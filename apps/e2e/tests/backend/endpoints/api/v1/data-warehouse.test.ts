import { ITEM_IDS, PLAN_LIMITS } from "@hexclave/shared/dist/plans";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { Client } from "pg";
import { it } from "../../../../helpers";
import { Project, niceBackendFetch, withInternalProject } from "../../../backend-helpers";
import { waitForItemQuantityToReach } from "../../../payment-quota-helpers";

const DATA_WAREHOUSE_OPERATION_LOCK_CLASS = 247_911;

/**
 * A direct Postgres connection, for the states the API cannot produce on demand
 * (a held operation lock, a row left behind by a failed provision).
 */
async function withDatabaseClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const connectionString = getEnvVariable(
    "HEXCLAVE_DATABASE_CONNECTION_STRING",
    getEnvVariable("STACK_DATABASE_CONNECTION_STRING", ""),
  );
  if (connectionString === "") {
    throw new HexclaveAssertionError("Data Warehouse database-state tests require a database connection string");
  }
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000, query_timeout: 30_000 });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function getTestTenancyId(client: Client, projectId: string): Promise<string> {
  const tenancyResult = await client.query<{ id: string }>(
    `SELECT "id" FROM "Tenancy" WHERE "projectId" = $1 ORDER BY "createdAt" LIMIT 1`,
    [projectId],
  );
  if (tenancyResult.rows.length !== 1) {
    throw new HexclaveAssertionError("Expected exactly one Data Warehouse test tenancy", {
      projectId,
      resultCount: tenancyResult.rows.length,
    });
  }
  return tenancyResult.rows[0].id;
}

async function whileWarehouseOperationLocked<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
  return await withDatabaseClient(async (client) => {
    const tenancyId = await getTestTenancyId(client, projectId);
    await client.query(
      "SELECT pg_advisory_lock($1::int, hashtext($2::text))",
      [DATA_WAREHOUSE_OPERATION_LOCK_CLASS, tenancyId],
    );
    try {
      return await operation();
    } finally {
      await client.query(
        "SELECT pg_advisory_unlock($1::int, hashtext($2::text))",
        [DATA_WAREHOUSE_OPERATION_LOCK_CLASS, tenancyId],
      );
    }
  });
}

/** Marks the project's warehouse FAILED, optionally dropping its stored password. */
async function forceWarehouseFailed(projectId: string, options: { dropStoredPassword: boolean }) {
  await withDatabaseClient(async (client) => {
    const tenancyId = await getTestTenancyId(client, projectId);
    const result = await client.query(
      options.dropStoredPassword
        ? `UPDATE "DataWarehouse" SET "status" = 'FAILED', "encryptedPassword" = NULL, "passwordUpdatedAt" = NULL WHERE "tenancyId" = $1`
        : `UPDATE "DataWarehouse" SET "status" = 'FAILED' WHERE "tenancyId" = $1`,
      [tenancyId],
    );
    if (result.rowCount !== 1) {
      throw new HexclaveAssertionError("Expected exactly one Data Warehouse row to mark FAILED", { projectId, rowCount: result.rowCount });
    }
  });
}

async function rotatePassword() {
  return await niceBackendFetch("/api/v1/data-warehouse/rotate-password", {
    method: "POST",
    accessType: "admin",
    body: {},
  });
}

/** A project on the team plan, which is what entitles it to a Data Warehouse. */
async function createEntitledProject() {
  const { createProjectResponse, projectId } = await Project.createAndSwitch();
  const ownerTeamId = createProjectResponse.body.owner_team_id;
  await withInternalProject(async () => {
    const grantResponse = await niceBackendFetch(`/api/v1/payments/products/team/${ownerTeamId}`, {
      method: "POST",
      accessType: "server",
      body: { product_id: "team" },
    });
    if (grantResponse.status !== 200) {
      throw new HexclaveAssertionError(`Failed to grant the team plan to '${ownerTeamId}'`, { response: grantResponse });
    }
  });
  await waitForItemQuantityToReach(ownerTeamId, ITEM_IDS.dataWarehouse, 1);
  return { projectId, ownerTeamId };
}

async function provision() {
  return await niceBackendFetch("/api/v1/data-warehouse/provision", {
    method: "POST",
    accessType: "admin",
    body: {},
  });
}

async function getWarehouse() {
  return await niceBackendFetch("/api/v1/data-warehouse", { accessType: "admin" });
}

async function runAnalyticsQuery(query: string) {
  return await niceBackendFetch("/api/v1/analytics/query", {
    method: "POST",
    accessType: "server",
    body: { query },
  });
}

/**
 * Talks to ClickHouse directly as a customer would — the only way to exercise the
 * write path, since `/analytics/query` pins `readonly=1`.
 */
async function clickhouse(options: { username: string, password: string, query: string }) {
  const url = new URL(process.env.HEXCLAVE_CLICKHOUSE_URL ?? throwMissingClickhouseUrl());
  url.searchParams.set("user", options.username);
  url.searchParams.set("password", options.password);
  const response = await fetch(url, { method: "POST", body: options.query });
  return { status: response.status, text: (await response.text()).trim() };
}

function throwMissingClickhouseUrl(): never {
  throw new HexclaveAssertionError("HEXCLAVE_CLICKHOUSE_URL is not set; the Data Warehouse tests need to reach ClickHouse directly");
}

it("is not provisioned by default, but reports the database name it would get", async ({ expect }) => {
  const { projectId } = await Project.createAndSwitch();
  const response = await getWarehouse();
  expect(response.status).toBe(200);
  expect(response.body.status).toBe("not_provisioned");
  expect(response.body.database_name).toBe(projectId);
  expect(response.body.username).toBe(null);
  expect(response.body.password_updated_at_millis).toBe(null);
  const portPrefix = process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX ?? "81";
  expect(response.body.connection).toEqual({
    host: "localhost",
    https_port: Number(`${portPrefix}36`),
    native_port: Number(`${portPrefix}37`),
  });
});

it("cannot be provisioned on the free plan", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await provision();
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({
    code: "ITEM_QUANTITY_INSUFFICIENT_AMOUNT",
    details: { item_id: ITEM_IDS.dataWarehouse },
  });
});

it("provisions a database and user on the team plan, returning the password exactly once", async ({ expect }) => {
  const { projectId } = await createEntitledProject();

  const provisionResponse = await provision();
  expect(provisionResponse.status).toBe(200);
  expect(provisionResponse.body.database_name).toBe(projectId);
  expect(provisionResponse.body.username).toBe(projectId);
  expect(typeof provisionResponse.body.password).toBe("string");
  expect(provisionResponse.body.password.length).toBeGreaterThan(20);
  expect(provisionResponse.body.password_updated_at_millis).toEqual(expect.any(Number));

  const getResponse = await getWarehouse();
  expect(getResponse.status).toBe(200);
  expect(getResponse.body.status).toBe("ready");
  expect(getResponse.body.username).toBe(projectId);
  expect(getResponse.body).not.toHaveProperty("password");
  expect(getResponse.body.password_updated_at_millis).toEqual(expect.any(Number));
});

it("refuses to provision twice, so live credentials are never silently invalidated", async ({ expect }) => {
  await createEntitledProject();
  expect((await provision()).status).toBe(200);
  const second = await provision();
  expect(second.status).toBe(400);
  // StatusError responses carry the message as a plain-text body.
  expect(String(second.body)).toContain("already has a data warehouse");
});

it("rejects provisioning while another session holds its operation lock", async ({ expect }) => {
  const { projectId } = await createEntitledProject();
  const blocked = await whileWarehouseOperationLocked(projectId, async () => await provision());
  expect(blocked.status).toBe(409);

  const successful = await provision();
  expect(successful.status).toBe(200);
  const direct = await clickhouse({ ...successful.body, query: "SELECT 1" });
  expect(direct.status).toBe(200);
});

it("lets the project read and write its own database", async ({ expect }) => {
  const { projectId } = await createEntitledProject();
  const { body: credentials } = await provision();

  const create = await clickhouse({
    ...credentials,
    query: `CREATE TABLE "${projectId}".orders (id UInt64, total Float64) ENGINE = MergeTree ORDER BY id`,
  });
  expect(create.status).toBe(200);

  const insert = await clickhouse({
    ...credentials,
    query: `INSERT INTO "${projectId}".orders VALUES (1, 9.99), (2, 42.0)`,
  });
  expect(insert.status).toBe(200);

  const select = await clickhouse({
    ...credentials,
    query: `SELECT count(), sum(total) FROM "${projectId}".orders`,
  });
  expect(select.status).toBe(200);
  expect(select.text).toBe("2\t51.99");
});

it("keeps the project's analytics access, scoped by the pinned project id", async ({ expect }) => {
  await createEntitledProject();
  const { body: credentials } = await provision();

  const analytics = await clickhouse({ ...credentials, query: "SELECT count() FROM default.events" });
  expect(analytics.status).toBe(200);

  // The row-policy inputs are CONST user settings, so a direct connection
  // cannot point itself at another project's analytics rows.
  const override = await clickhouse({
    ...credentials,
    query: "SELECT 1 SETTINGS SQL_project_id = 'some-other-project'",
  });
  expect(override.status).not.toBe(200);
  expect(override.text).toContain("SQL_project_id");
});

it("caps both per-query and aggregate resource usage for direct connections", async ({ expect }) => {
  await createEntitledProject();
  const { body: credentials } = await provision();

  const configuredLimits = await clickhouse({
    ...credentials,
    query: `
      SELECT
        getSetting('max_memory_usage'),
        getSetting('max_memory_usage_for_user'),
        getSetting('max_concurrent_queries_for_user'),
        getSetting('max_threads')
    `,
  });
  expect(configuredLimits.status).toBe(200);
  expect(configuredLimits.text).toBe("4000000000\t4000000000\t10\t4");

  // The plan's timeout is the ceiling, not just the default: a team-plan user must
  // not be able to raise it to a higher plan's timeout on a direct connection.
  // The exact value is the team's `analytics_timeout_seconds` quantity. That is 60
  // once the free plan's replacement has been processed, but free's end is queued
  // for the timefold worker (~1s), so provisioning right after the upgrade can
  // briefly see free + team stacked (70). Hence a range: at least the team plan's
  // timeout, below the highest plan's, and not raisable.
  const configuredExecutionTime = await clickhouse({
    ...credentials,
    query: "SELECT getSetting('max_execution_time')",
  });
  expect(configuredExecutionTime.status).toBe(200);
  const executionTimeCeiling = Number(configuredExecutionTime.text);
  expect(executionTimeCeiling).toBeGreaterThanOrEqual(PLAN_LIMITS.team.analyticsTimeoutSeconds);
  expect(executionTimeCeiling).toBeLessThan(PLAN_LIMITS.growth.analyticsTimeoutSeconds);

  const raiseExecutionTime = await clickhouse({
    ...credentials,
    query: `SELECT 1 SETTINGS max_execution_time = ${executionTimeCeiling + 1}`,
  });
  expect(raiseExecutionTime.status).not.toBe(200);
  expect(raiseExecutionTime.text).toContain("max_execution_time");

  const lowerExecutionTime = await clickhouse({
    ...credentials,
    query: "SELECT getSetting('max_execution_time') SETTINGS max_execution_time = 5",
  });
  expect(lowerExecutionTime).toEqual({ status: 200, text: "5" });

  const raiseAggregateMemoryLimit = await clickhouse({
    ...credentials,
    query: "SELECT 1 SETTINGS max_memory_usage_for_user = 4000000001",
  });
  expect(raiseAggregateMemoryLimit.status).not.toBe(200);
  expect(raiseAggregateMemoryLimit.text).toContain("max_memory_usage_for_user");

  const raiseConcurrencyLimit = await clickhouse({
    ...credentials,
    query: "SELECT 1 SETTINGS max_concurrent_queries_for_user = 11",
  });
  expect(raiseConcurrencyLimit.status).not.toBe(200);
  expect(raiseConcurrencyLimit.text).toContain("max_concurrent_queries_for_user");

  const raiseCpuParallelism = await clickhouse({
    ...credentials,
    query: "SELECT 1 SETTINGS max_threads = 5",
  });
  expect(raiseCpuParallelism.status).not.toBe(200);
  expect(raiseCpuParallelism.text).toContain("max_threads");
});

it("denies the table engines and table functions that reach outside the instance", async ({ expect }) => {
  const { projectId } = await createEntitledProject();
  const { body: credentials } = await provision();

  const urlEngine = await clickhouse({
    ...credentials,
    query: `CREATE TABLE "${projectId}".exfil (a String) ENGINE = URL('http://example.com', CSV)`,
  });
  expect(urlEngine.status).not.toBe(200);

  const urlFunction = await clickhouse({
    ...credentials,
    query: "SELECT * FROM url('http://example.com', CSV, 'a String')",
  });
  expect(urlFunction.status).not.toBe(200);

  // On affected builds, CREATE TABLE AS infers a remote schema before checking READ
  // ON URL. This must fail on privileges, without dialing the unreachable address.
  const inferredUrlTable = await clickhouse({
    ...credentials,
    query: `CREATE TABLE "${projectId}".inferred_url AS url('http://127.0.0.1:1/data.csv', CSV)`,
  });
  expect(inferredUrlTable.status).not.toBe(200);
  expect(inferredUrlTable.text).toContain("URL");

  // Dictionary sources have their own outbound connectors, which the URL source
  // privilege above does not cover — so the user must not have CREATE DICTIONARY.
  const httpDictionary = await clickhouse({
    ...credentials,
    query: `
      CREATE DICTIONARY "${projectId}".outbound_dictionary (
        id UInt64,
        value String
      )
      PRIMARY KEY id
      SOURCE(HTTP(URL 'http://example.com/data.csv' FORMAT 'CSV'))
      LAYOUT(HASHED())
      LIFETIME(0)
    `,
  });
  expect(httpDictionary.status).not.toBe(200);
  expect(httpDictionary.text).toContain("CREATE DICTIONARY");

  // Source-backed engines are gated by `REVOKE SOURCES`, including sources that
  // were never named individually (Kafka was not in the old per-source list).
  const kafkaEngine = await clickhouse({
    ...credentials,
    query: `CREATE TABLE "${projectId}".kafka_exfil (a String) ENGINE = Kafka('localhost:9092', 'topic', 'group', 'JSONEachRow')`,
  });
  expect(kafkaEngine.status).not.toBe(200);
  expect(kafkaEngine.text).toContain("TABLE ENGINE");

  // GCS is S3 underneath but was missing from ClickHouse's own source-engine list
  // before 26.5. Where engine grants are enforced (as here), it must still be
  // denied, since it is not on the allow-list.
  const gcsEngine = await clickhouse({
    ...credentials,
    query: `CREATE TABLE "${projectId}".gcs_exfil (a String) ENGINE = GCS('http://127.0.0.1:1/bucket-name/key.csv', CSV)`,
  });
  expect(gcsEngine.status).not.toBe(200);
  expect(gcsEngine.text).toContain("TABLE ENGINE ON GCS");

  const grants = await clickhouse({ ...credentials, query: "SHOW GRANTS" });
  expect(grants.status).toBe(200);
  expect(grants.text).not.toMatch(/\b(SOURCES|URL|S3|REMOTE|KAFKA)\b/);
});

it("does not let one project read another project's warehouse", async ({ expect }) => {
  const first = await createEntitledProject();
  const { body: firstCredentials } = await provision();
  const created = await clickhouse({
    ...firstCredentials,
    query: `CREATE TABLE "${first.projectId}".secrets (v String) ENGINE = MergeTree ORDER BY v`,
  });
  expect(created.status).toBe(200);
  const inserted = await clickhouse({
    ...firstCredentials,
    query: `INSERT INTO "${first.projectId}".secrets VALUES ('first-project-only')`,
  });
  expect(inserted.status).toBe(200);

  // A second project with its own warehouse user. This is the assertion that matters:
  // with the old shared `limited_user`, one project's database was readable by all.
  const second = await createEntitledProject();
  const { body: secondCredentials } = await provision();

  const direct = await clickhouse({
    ...secondCredentials,
    query: `SELECT * FROM "${first.projectId}".secrets`,
  });
  expect(direct.status).not.toBe(200);
  expect(direct.text).toContain("Not enough privileges");

  // Same check through the API path, which connects as the second project's
  // warehouse user now that it has one.
  const throughApi = await runAnalyticsQuery(`SELECT * FROM "${first.projectId}".secrets`);
  expect(throughApi.status).toBe(400);
  expect(throughApi.body.code).toBe("ANALYTICS_QUERY_ERROR");

  // ...and the second project can still reach its own analytics data.
  const ownAnalytics = await runAnalyticsQuery("SELECT count() AS c FROM events");
  expect(ownAnalytics.status).toBe(200);
  expect(second.projectId).not.toBe(first.projectId);
});

it("can query its own warehouse tables through the analytics endpoint", async ({ expect }) => {
  const { projectId } = await createEntitledProject();
  const { body: credentials } = await provision();
  await clickhouse({
    ...credentials,
    query: `CREATE TABLE "${projectId}".orders (id UInt64) ENGINE = MergeTree ORDER BY id`,
  });
  await clickhouse({ ...credentials, query: `INSERT INTO "${projectId}".orders VALUES (1), (2), (3)` });

  const response = await runAnalyticsQuery(`SELECT count() AS c FROM "${projectId}".orders`);
  expect(response.status).toBe(200);
  expect(response.body.result).toEqual([{ c: 3 }]);
});

it("rotates the password, invalidating the old one and keeping analytics working", async ({ expect }) => {
  const { projectId } = await createEntitledProject();
  const { body: original } = await provision();
  await clickhouse({
    ...original,
    query: `CREATE TABLE "${projectId}".orders (id UInt64) ENGINE = MergeTree ORDER BY id`,
  });

  const rotateResponse = await niceBackendFetch("/api/v1/data-warehouse/rotate-password", {
    method: "POST",
    accessType: "admin",
    body: {},
  });
  expect(rotateResponse.status).toBe(200);
  expect(rotateResponse.body.password).not.toBe(original.password);
  expect(rotateResponse.body.username).toBe(original.username);
  expect(rotateResponse.body.password_updated_at_millis).toEqual(expect.any(Number));

  const withOldPassword = await clickhouse({ ...original, query: "SELECT 1" });
  expect(withOldPassword.status).not.toBe(200);

  const withNewPassword = await clickhouse({ ...rotateResponse.body, query: `SELECT count() FROM "${projectId}".orders` });
  expect(withNewPassword.status).toBe(200);

  // The backend reads the stored password per request, so it follows the rotation.
  const analytics = await runAnalyticsQuery("SELECT count() AS c FROM events");
  expect(analytics.status).toBe(200);
});

it("rejects rotation while another session holds its operation lock", async ({ expect }) => {
  const { projectId } = await createEntitledProject();
  const { body: original } = await provision();

  const rotate = () => niceBackendFetch("/api/v1/data-warehouse/rotate-password", {
    method: "POST",
    accessType: "admin",
    body: {},
  });
  const blocked = await whileWarehouseOperationLocked(projectId, async () => await rotate());
  expect(blocked.status).toBe(409);

  const successful = await rotate();
  expect(successful.status).toBe(200);
  expect((await clickhouse({ ...original, query: "SELECT 1" })).status).not.toBe(200);
  expect((await clickhouse({ ...successful.body, query: "SELECT 1" })).status).toBe(200);
});

it("cannot be rotated before it has been provisioned", async ({ expect }) => {
  await createEntitledProject();
  const response = await niceBackendFetch("/api/v1/data-warehouse/rotate-password", {
    method: "POST",
    accessType: "admin",
    body: {},
  });
  expect(response.status).toBe(400);
  expect(String(response.body)).toContain("does not have a data warehouse");
});

it("rejects rotation after a first provision failed, pointing to provisioning instead", async ({ expect }) => {
  const { projectId } = await createEntitledProject();
  expect((await provision()).status).toBe(200);
  // A failed first provision leaves a FAILED row with no stored password.
  await forceWarehouseFailed(projectId, { dropStoredPassword: true });

  const rotation = await rotatePassword();
  expect(rotation.status).toBe(400);
  expect(String(rotation.body)).toContain("Provision it instead");

  const retry = await provision();
  expect(retry.status).toBe(200);
  expect((await clickhouse({ ...retry.body, query: "SELECT 1" })).status).toBe(200);
});

it("still rotates a FAILED warehouse that has a stored password, as a repair path", async ({ expect }) => {
  const { projectId } = await createEntitledProject();
  const { body: original } = await provision();
  // What a rotation that could not restore the previous password leaves behind.
  await forceWarehouseFailed(projectId, { dropStoredPassword: false });

  const rotation = await rotatePassword();
  expect(rotation.status).toBe(200);
  expect(rotation.body.password).not.toBe(original.password);
  expect((await clickhouse({ ...rotation.body, query: "SELECT 1" })).status).toBe(200);
  expect((await getWarehouse()).body.status).toBe("ready");
});

it("is not reachable with server auth — provisioning is an admin action", async ({ expect }) => {
  await createEntitledProject();
  const response = await niceBackendFetch("/api/v1/data-warehouse/provision", {
    method: "POST",
    accessType: "server",
    body: {},
  });
  expect(response.status).toBe(401);
});
