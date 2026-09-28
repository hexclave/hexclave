import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { Client } from "pg";
import { it } from "../../../../helpers";
import { Project, niceBackendFetch, withInternalProject } from "../../../backend-helpers";
import { waitForItemQuantityToReach } from "../../../payment-quota-helpers";

/**
 * Each test gets its own throwaway database on the local Postgres and points a
 * data source at it. A separate database rather than a schema because logical
 * replication slots are per-database: a leaked slot on the app's own database
 * would pin write-ahead log for everything else running here.
 */

function sourceServer() {
  const connectionString = getEnvVariable(
    "HEXCLAVE_DATABASE_CONNECTION_STRING",
    getEnvVariable("STACK_DATABASE_CONNECTION_STRING", ""),
  );
  if (connectionString === "") {
    throw new HexclaveAssertionError("Data Source tests need a database connection string to build a source from");
  }
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: Number.parseInt(url.port || "5432", 10),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    adminDatabase: url.pathname.replace(/^\//, ""),
  };
}

function connectionStringFor(database: string) {
  const server = sourceServer();
  return `postgres://${encodeURIComponent(server.username)}:${encodeURIComponent(server.password)}@${server.host}:${server.port}/${database}`;
}

async function onSource<T>(database: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: connectionStringFor(database), connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates a source database seeded with `setup`, runs the test, and drops it. */
async function withSourceDatabase<T>(
  setup: string,
  fn: (source: { database: string, query: (sql: string) => Promise<void> }) => Promise<T>,
): Promise<T> {
  const server = sourceServer();
  const database = `ds_e2e_${Math.random().toString(36).slice(2, 12)}`;
  await onSource(server.adminDatabase, async client => {
    await client.query(`CREATE DATABASE ${JSON.stringify(database).replace(/"/g, '"')}`);
  });
  try {
    await onSource(database, async client => {
      await client.query(setup);
    });
    return await fn({
      database,
      query: async (sql: string) => {
        await onSource(database, async client => {
          await client.query(sql);
        });
      },
    });
  } finally {
    await onSource(server.adminDatabase, async client => {
      // Slots and the connections holding them must go before the database can be
      // dropped; a test that failed mid-sync would otherwise block cleanup.
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [database],
      ).catch(() => {});
      await client.query(`DROP DATABASE IF EXISTS ${JSON.stringify(database).replace(/"/g, '"')} WITH (FORCE)`).catch(() => {});
    });
  }
}

/** A project on the team plan with a warehouse, which is what a source writes into. */
async function createProjectWithWarehouse() {
  const { createProjectResponse, projectId } = await Project.createAndSwitch();
  const ownerTeamId = createProjectResponse.body.owner_team_id;
  await withInternalProject(async () => {
    const grant = await niceBackendFetch(`/api/v1/payments/products/team/${ownerTeamId}`, {
      method: "POST",
      accessType: "server",
      body: { product_id: "team" },
    });
    if (grant.status !== 200) {
      throw new HexclaveAssertionError(`Failed to grant the team plan to '${ownerTeamId}'`, { response: grant });
    }
  });
  await waitForItemQuantityToReach(ownerTeamId, ITEM_IDS.dataWarehouse, 1);
  const provision = await niceBackendFetch("/api/v1/data-warehouse/provision", {
    method: "POST",
    accessType: "admin",
    body: {},
  });
  if (provision.status !== 200) {
    throw new HexclaveAssertionError("Failed to provision the warehouse a data source needs", { response: provision });
  }
  return { projectId, credentials: { username: provision.body.username, password: provision.body.password } };
}

async function connectSource(database: string, overrides: Record<string, unknown> = {}) {
  const server = sourceServer();
  return await niceBackendFetch("/api/v1/data-sources", {
    method: "POST",
    accessType: "admin",
    body: {
      host: server.host,
      port: server.port,
      database,
      username: server.username,
      password: server.password,
      ssl_mode: "disable",
      ...overrides,
    },
  });
}

const listSources = () => niceBackendFetch("/api/v1/data-sources", { accessType: "admin" });
const getSource = (id: string) => niceBackendFetch(`/api/v1/data-sources/${id}`, { accessType: "admin" });
const getCatalog = (id: string) => niceBackendFetch(`/api/v1/data-sources/${id}/catalog`, { accessType: "admin" });
const setStreams = (id: string, streams: unknown[]) => niceBackendFetch(`/api/v1/data-sources/${id}/streams`, {
  method: "PUT", accessType: "admin", body: { streams },
});
const syncSource = (id: string) => niceBackendFetch(`/api/v1/data-sources/${id}/sync`, {
  method: "POST", accessType: "admin", body: {},
});
const deleteSource = (id: string) => niceBackendFetch(`/api/v1/data-sources/${id}`, {
  method: "DELETE", accessType: "admin",
});
const runScheduledSyncs = () => niceBackendFetch("/api/v1/internal/data-source-sync-step", {
  method: "GET",
  headers: { "Authorization": "Bearer mock_cron_secret" },
  query: { max_duration_ms: "120000" },
});

async function getCdcInfrastructureCounts(database: string): Promise<{ slots: number, publications: number }> {
  return await onSource(database, async client => {
    const slots = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_replication_slots WHERE database = current_database() AND slot_name LIKE 'hexclave_%'`,
    );
    const publications = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_publication WHERE pubname LIKE 'hexclave_%'`,
    );
    return { slots: slots.rows[0].count, publications: publications.rows[0].count };
  });
}

async function waitForBlockedDataSourceSync(database: string): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const blocked = await onSource(database, async client => {
      const result = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = 'hexclave_data_source_sync'
            AND state = 'active'
            AND wait_event_type = 'Lock'
        ) AS exists
      `);
      return result.rows[0].exists;
    });
    if (blocked) return;
    await wait(25);
  }
  throw new HexclaveAssertionError("Timed out waiting for the data source sync to block on the test table lock");
}

function getDestinationTable(
  response: { body: { data_source: { streams: { table_name: string, destination_table: string }[] } } },
  tableName: string,
): string {
  const stream = response.body.data_source.streams.find(candidate => candidate.table_name === tableName);
  if (stream == null) throw new HexclaveAssertionError(`Response has no stream for table ${tableName}`);
  return stream.destination_table;
}

/** Reads the destination as the customer would, with the project's own warehouse user. */
async function queryWarehouse(credentials: { username: string, password: string }, query: string) {
  const url = new URL(getEnvVariable("HEXCLAVE_CLICKHOUSE_URL", ""));
  url.searchParams.set("user", credentials.username);
  url.searchParams.set("password", credentials.password);
  const response = await fetch(url, { method: "POST", body: query });
  return { status: response.status, text: (await response.text()).trim() };
}

const SIMPLE_SCHEMA = `
  CREATE TABLE plans (id int PRIMARY KEY, name text NOT NULL);
  CREATE TABLE events (id bigserial PRIMARY KEY, label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now() - interval '1 hour');
  CREATE INDEX events_created_at_idx ON events (created_at);
  CREATE TABLE keyless (a int NOT NULL, b text);
  INSERT INTO plans VALUES (1, 'free'), (2, 'pro');
  INSERT INTO events (label) SELECT 'e' || g FROM generate_series(1, 25) g;
  ANALYZE;
`;

// ─── auth and entitlement ───────────────────────────────────────────────────

it("refuses anything below admin access", async ({ expect }) => {
  await Project.createAndSwitch();
  const client = await niceBackendFetch("/api/v1/data-sources", { accessType: "client" });
  expect(client.status).toBe(401);
  const server = await niceBackendFetch("/api/v1/data-sources", { accessType: "server" });
  expect(server.status).toBe(401);
});

it("lists nothing for a project that has never connected one", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await listSources();
  expect(response.status).toBe(200);
  expect(response.body.data_sources).toEqual([]);
});

it("cannot connect a source on the free plan", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await connectSource("postgres");
  expect(response.status).toBe(400);
  expect(response.body).toMatchObject({
    code: "ITEM_QUANTITY_INSUFFICIENT_AMOUNT",
    details: { item_id: ITEM_IDS.dataWarehouse },
  });
});

it("cannot connect a source before the warehouse it would write into exists", async ({ expect }) => {
  const { createProjectResponse } = await Project.createAndSwitch();
  const ownerTeamId = createProjectResponse.body.owner_team_id;
  await withInternalProject(async () => {
    await niceBackendFetch(`/api/v1/payments/products/team/${ownerTeamId}`, {
      method: "POST", accessType: "server", body: { product_id: "team" },
    });
  });
  await waitForItemQuantityToReach(ownerTeamId, ITEM_IDS.dataWarehouse, 1);

  const response = await connectSource("postgres");
  expect(response.status).toBe(400);
  expect(String(response.body)).toContain("does not have a data warehouse");
});

// ─── connecting ─────────────────────────────────────────────────────────────

it("rejects credentials it cannot connect with, and stores nothing", async ({ expect }) => {
  await createProjectWithWarehouse();
  const response = await connectSource("postgres", { password: "not-the-password" });
  expect(response.status).toBe(400);
  // A source row that has never connected is worse than no row: it looks configured.
  const list = await listSources();
  expect(list.body.data_sources).toEqual([]);
});

it("rejects an unsupported SSL mode", async ({ expect }) => {
  await createProjectWithWarehouse();
  const response = await connectSource("postgres", { ssl_mode: "banana" });
  expect(response.status).toBe(400);
});

it("connects, and returns a catalog with a mode decision per table", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const response = await connectSource(source.database);
    expect(response.status).toBe(200);
    expect(response.body.data_source).toMatchObject({
      type: "postgres",
      database: source.database,
      status: "pending",
      streams: [],
    });
    expect(response.body.data_source).not.toHaveProperty("password");
    expect(response.body.data_source.capabilities.wal_level).toBe("logical");

    const tables = response.body.catalog.tables;
    expect(tables.map((t: any) => t.table_name).sort()).toEqual(["events", "keyless", "plans"]);

    const events = tables.find((t: any) => t.table_name === "events");
    expect(events.primary_key_columns).toEqual(["id"]);
    // Both the indexed timestamp and the monotonic key qualify; the timestamp is
    // preferred because it moves when a row is updated in place.
    expect(events.cursor_candidates.map((c: any) => c.column).sort()).toEqual(["created_at", "id"]);
    expect(events.default_cursor_column).toBe("created_at");
    // CDC wherever the server allows it: cheaper in steady state, and the only
    // mode that sees deletes.
    expect(events.recommended_mode).toBe("cdc");

    // Without a primary key there is no key to match an update or delete against.
    const keyless = tables.find((t: any) => t.table_name === "keyless");
    expect(keyless.primary_key_columns).toEqual([]);
    expect(keyless.available_modes.find((m: any) => m.mode === "cdc")).toEqual({
      mode: "cdc", available: false, reason: "needs a primary key",
    });
  });
});

it("re-reads the catalog on demand, so a table added later becomes syncable", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    await source.query(`CREATE TABLE added_later (id int PRIMARY KEY)`);

    const catalog = await getCatalog(data_source.id);
    expect(catalog.status).toBe(200);
    expect(catalog.body.catalog.tables.map((t: any) => t.table_name)).toContain("added_later");
  });
});

// ─── configuring streams ────────────────────────────────────────────────────

it("refuses a mode the source cannot support, rather than downgrading it", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    const response = await setStreams(data_source.id, [
      { schema_name: "public", table_name: "keyless", mode: "cdc" },
    ]);
    expect(response.status).toBe(400);
    expect(String(response.body)).toContain("needs a primary key");
  });
});

it("refuses a table the source does not have", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    const response = await setStreams(data_source.id, [
      { schema_name: "public", table_name: "no_such_table", mode: "cursor", cursor_column: "id" },
    ]);
    expect(response.status).toBe(400);
    expect(String(response.body)).toContain("no readable table");
  });
});

it("refuses a cursor column that is not a usable cursor", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    const response = await setStreams(data_source.id, [
      { schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "label" },
    ]);
    expect(response.status).toBe(400);
    expect(String(response.body)).toContain("cannot be used as a cursor");
  });
});

it("replaces the stream list wholesale and reports it back", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);

    const first = await setStreams(data_source.id, [
      { schema_name: "public", table_name: "plans", mode: "cursor", cursor_column: "id" },
      { schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "created_at" },
    ]);
    expect(first.status).toBe(200);
    expect(first.body.data_source.status).toBe("active");
    expect(first.body.data_source.streams.map((s: any) => [s.table_name, s.mode, s.cursor_column])).toEqual([
      ["events", "cursor", "created_at"],
      ["plans", "cursor", "id"],
    ]);
    const eventsDestination = getDestinationTable(first, "events");
    const plansDestination = getDestinationTable(first, "plans");
    expect(eventsDestination).toMatch(/^public_events_[0-9a-f]{64}$/);
    expect(plansDestination).toMatch(/^public_plans_[0-9a-f]{64}$/);
    expect(eventsDestination).not.toBe(plansDestination);

    const second = await setStreams(data_source.id, [
      { schema_name: "public", table_name: "plans", mode: "cursor", cursor_column: "id" },
    ]);
    expect(second.body.data_source.streams.map((s: any) => s.table_name)).toEqual(["plans"]);
    expect(getDestinationTable(second, "plans")).toBe(plansDestination);

    const fetched = await getSource(data_source.id);
    expect(fetched.status).toBe(200);
    expect(fetched.body.data_source.streams.map((s: any) => s.table_name)).toEqual(["plans"]);
  });
});

it("refuses stream changes while a sync is using the previous configuration", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    await setStreams(data_source.id, [
      { schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "created_at" },
    ]);

    await onSource(source.database, async lockClient => {
      await lockClient.query("BEGIN");
      await lockClient.query("LOCK TABLE events IN ACCESS EXCLUSIVE MODE");
      const syncing = syncSource(data_source.id);
      try {
        await waitForBlockedDataSourceSync(source.database);
        const reconfigured = await setStreams(data_source.id, [
          { schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "id" },
        ]);
        expect(reconfigured.status).toBe(409);
        expect(String(reconfigured.body)).toContain("Wait for the running sync to finish");
      } finally {
        await lockClient.query("ROLLBACK");
        expect((await syncing).status).toBe(200);
      }
    });

    const fetched = await getSource(data_source.id);
    expect(fetched.body.data_source.streams[0].cursor_column).toBe("created_at");
  });
});

// ─── syncing ────────────────────────────────────────────────────────────────

it("executes a due source through the scheduler's existing claim", async ({ expect }) => {
  const { projectId, credentials } = await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    const configured = await setStreams(data_source.id, [
      { schema_name: "public", table_name: "plans", mode: "cursor", cursor_column: "id" },
    ]);

    const scheduled = await runScheduledSyncs();
    expect(scheduled.status).toBe(200);

    const synced = await getSource(data_source.id);
    expect(synced.body.data_source.error).toBe(null);
    expect(synced.body.data_source.streams[0]).toMatchObject({ status: "active", rows_synced: 2 });
    const destinationTable = getDestinationTable(configured, "plans");
    const rows = await queryWarehouse(credentials, `SELECT name FROM \`${projectId}\`.\`${destinationTable}\` FINAL ORDER BY id`);
    expect(rows.text).toBe("free\npro");
  });
});

it("syncs cursor streams into the project's warehouse", async ({ expect }) => {
  const { projectId, credentials } = await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    await setStreams(data_source.id, [
      { schema_name: "public", table_name: "plans", mode: "cursor", cursor_column: "id" },
      { schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "created_at" },
    ]);

    const sync = await syncSource(data_source.id);
    expect(sync.status).toBe(200);
    expect(sync.body.data_source.streams.map((s: any) => [s.table_name, s.status, s.error])).toEqual([
      ["events", "active", null],
      ["plans", "active", null],
    ]);
    expect(sync.body.data_source.streams.find((s: any) => s.table_name === "events").rows_synced).toBe(25);

    const plansDestination = getDestinationTable(sync, "plans");
    const eventsDestination = getDestinationTable(sync, "events");
    const plans = await queryWarehouse(credentials, `SELECT name FROM \`${projectId}\`.\`${plansDestination}\` FINAL ORDER BY id`);
    expect(plans.status).toBe(200);
    expect(plans.text).toBe("free\npro");

    const events = await queryWarehouse(credentials, `SELECT count() FROM \`${projectId}\`.\`${eventsDestination}\` FINAL`);
    expect(events.text).toBe("25");
  });
});

it("resumes a cursor stream instead of re-reading the table", async ({ expect }) => {
  const { projectId, credentials } = await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    await setStreams(data_source.id, [
      { schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "created_at" },
    ]);
    const first = await syncSource(data_source.id);
    expect(first.body.data_source.streams[0].rows_synced).toBe(25);

    // Backdated past the safety lag, which exists so a transaction committing
    // after its timestamp is not skipped — a row written at now() is not due yet.
    await source.query(`INSERT INTO events (label, created_at) VALUES ('late', now() - interval '30 minutes')`);
    const second = await syncSource(data_source.id);
    // rows_synced is cumulative, so only the one new row was read: a watermark
    // that loses precision would re-read all 25 every time.
    expect(second.body.data_source.streams[0].rows_synced).toBe(26);

    const destinationTable = getDestinationTable(second, "events");
    const rows = await queryWarehouse(credentials, `SELECT count() FROM \`${projectId}\`.\`${destinationTable}\` FINAL`);
    expect(rows.text).toBe("26");
  });
});

it("holds a cursor stream back from now(), so a late commit is not skipped", async ({ expect }) => {
  const { projectId, credentials } = await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    await setStreams(data_source.id, [
      { schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "created_at" },
    ]);
    const first = await syncSource(data_source.id);
    await source.query(`INSERT INTO events (label, created_at) VALUES ('too-fresh', now())`);
    await syncSource(data_source.id);

    const fresh = await queryWarehouse(
      credentials,
      `SELECT count() FROM \`${projectId}\`.\`${getDestinationTable(first, "events")}\` FINAL WHERE label = 'too-fresh'`,
    );
    expect(fresh.text).toBe("0");
  });
});

it("syncs inserts, updates and deletes through change data capture", async ({ expect }) => {
  const { projectId, credentials } = await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    const configured = await setStreams(data_source.id, [
      { schema_name: "public", table_name: "events", mode: "cdc" },
    ]);
    expect(configured.status).toBe(200);

    // First sync creates the slot and snapshots.
    const snapshot = await syncSource(data_source.id);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.data_source.streams[0].error).toBe(null);
    expect(snapshot.body.data_source.streams[0].rows_synced).toBe(25);

    await source.query(`INSERT INTO events (label) VALUES ('inserted')`);
    await source.query(`UPDATE events SET label = 'renamed' WHERE label = 'e1'`);
    await source.query(`DELETE FROM events WHERE label = 'e2'`);

    const second = await syncSource(data_source.id);
    expect(second.status).toBe(200);
    expect(second.body.data_source.streams[0].error).toBe(null);

    const live = await queryWarehouse(
      credentials,
      `SELECT count() FROM \`${projectId}\`.\`${getDestinationTable(second, "events")}\` FINAL WHERE _hexclave_deleted = 0`,
    );
    expect(live.text).toBe("25"); // 25 + 1 inserted - 1 deleted

    const renamed = await queryWarehouse(
      credentials,
      `SELECT count() FROM \`${projectId}\`.\`${getDestinationTable(second, "events")}\` FINAL WHERE label = 'renamed' AND _hexclave_deleted = 0`,
    );
    expect(renamed.text).toBe("1");

    // The only mode that can observe a delete at all.
    const deleted = await queryWarehouse(
      credentials,
      `SELECT count() FROM \`${projectId}\`.\`${getDestinationTable(second, "events")}\` FINAL WHERE label = 'e2' AND _hexclave_deleted = 0`,
    );
    expect(deleted.text).toBe("0");

    await deleteSource(data_source.id);
  });
});

it("rebuilds the destination when a stream changes mode", async ({ expect }) => {
  const { projectId, credentials } = await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    await setStreams(data_source.id, [{ schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "created_at" }]);
    await syncSource(data_source.id);

    // Cursor versions are epoch microseconds and CDC versions are LSNs, which are
    // many orders of magnitude smaller — merging the two would leave the table
    // frozen at its pre-switch contents forever.
    await setStreams(data_source.id, [{ schema_name: "public", table_name: "events", mode: "cdc" }]);
    await syncSource(data_source.id);
    await source.query(`UPDATE events SET label = 'after-switch' WHERE label = 'e3'`);
    const afterSwitch = await syncSource(data_source.id);
    expect(afterSwitch.body.data_source.streams[0].error).toBe(null);

    const updated = await queryWarehouse(
      credentials,
      `SELECT count() FROM \`${projectId}\`.\`${getDestinationTable(afterSwitch, "events")}\` FINAL WHERE label = 'after-switch'`,
    );
    expect(updated.text).toBe("1");

    await deleteSource(data_source.id);
  });
});

it("rebuilds the destination when the source's primary key changes", async ({ expect }) => {
  const { projectId, credentials } = await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    const streams = [{ schema_name: "public", table_name: "plans", mode: "cursor", cursor_column: "id" }];
    const configured = await setStreams(data_source.id, streams);
    await syncSource(data_source.id);

    // A second row with id 1 is only distinct under the new key. Left on the old
    // ORDER BY (id), ReplacingMergeTree would collapse it into the existing row.
    await source.query(`
      ALTER TABLE plans DROP CONSTRAINT plans_pkey;
      ALTER TABLE plans ADD PRIMARY KEY (id, name);
      INSERT INTO plans VALUES (1, 'legacy');
    `);
    const resaved = await setStreams(data_source.id, streams);
    expect(resaved.status).toBe(200);
    expect(resaved.body.data_source.streams[0]).toMatchObject({
      status: "pending",
      primary_key_columns: ["id", "name"],
      rows_synced: 0,
    });

    const synced = await syncSource(data_source.id);
    expect(synced.body.data_source.streams[0]).toMatchObject({ status: "active", error: null, rows_synced: 3 });
    const rows = await queryWarehouse(
      credentials,
      `SELECT name FROM \`${projectId}\`.\`${getDestinationTable(configured, "plans")}\` FINAL ORDER BY id, name`,
    );
    expect(rows.text).toBe("free\nlegacy\npro");
  });
});

it("drops CDC infrastructure when switching or removing the final CDC stream", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    await setStreams(data_source.id, [{ schema_name: "public", table_name: "events", mode: "cdc" }]);
    await syncSource(data_source.id);
    expect(await getCdcInfrastructureCounts(source.database)).toEqual({ slots: 1, publications: 1 });

    const switched = await setStreams(data_source.id, [
      { schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "created_at" },
    ]);
    expect(switched.status).toBe(200);
    expect(await getCdcInfrastructureCounts(source.database)).toEqual({ slots: 0, publications: 0 });

    // Recreate both objects, then cover removing the stream rather than merely
    // switching its mode. Teardown is idempotent across both transitions.
    await setStreams(data_source.id, [{ schema_name: "public", table_name: "events", mode: "cdc" }]);
    await syncSource(data_source.id);
    expect(await getCdcInfrastructureCounts(source.database)).toEqual({ slots: 1, publications: 1 });

    const removed = await setStreams(data_source.id, []);
    expect(removed.status).toBe(200);
    expect(await getCdcInfrastructureCounts(source.database)).toEqual({ slots: 0, publications: 0 });
  });
});

it("keeps one stream's failure from stopping the others", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    await setStreams(data_source.id, [
      { schema_name: "public", table_name: "plans", mode: "cursor", cursor_column: "id" },
      { schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "created_at" },
    ]);
    // Dropped behind the configuration's back, which is what a permissions change
    // or a migration looks like from here.
    await source.query(`DROP TABLE events`);

    const sync = await syncSource(data_source.id);
    expect(sync.status).toBe(200);
    const byTable = Object.fromEntries(sync.body.data_source.streams.map((s: any) => [s.table_name, s]));
    expect(byTable.plans.status).toBe("active");
    expect(byTable.plans.error).toBe(null);
    expect(byTable.events.status).toBe("failed");
    expect(String(byTable.events.error)).toContain("no longer exists");
  });
});

// ─── deleting and isolation ─────────────────────────────────────────────────

it("disconnects a source and drops the replication slot it created", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    await setStreams(data_source.id, [{ schema_name: "public", table_name: "events", mode: "cdc" }]);
    await syncSource(data_source.id);

    const slotsBefore = await onSource(source.database, async client =>
      (await client.query(`SELECT count(*)::int AS n FROM pg_replication_slots WHERE database = current_database()`)).rows[0].n);
    expect(slotsBefore).toBe(1);

    const deleted = await deleteSource(data_source.id);
    expect(deleted.status).toBe(200);

    // A slot nobody reads pins write-ahead log until the customer's disk fills.
    const slotsAfter = await onSource(source.database, async client =>
      (await client.query(`SELECT count(*)::int AS n FROM pg_replication_slots WHERE database = current_database()`)).rows[0].n);
    expect(slotsAfter).toBe(0);

    expect((await listSources()).body.data_sources).toEqual([]);
    expect((await getSource(data_source.id)).status).toBe(404);
  });
});

it("waits for a running sync to finish before cleaning up a deleted source", async ({ expect }) => {
  await createProjectWithWarehouse();
  await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    // The cursor stream gives the test a table to lock; the CDC stream owns the slot.
    await setStreams(data_source.id, [
      { schema_name: "public", table_name: "events", mode: "cursor", cursor_column: "created_at" },
      { schema_name: "public", table_name: "plans", mode: "cdc" },
    ]);
    await syncSource(data_source.id);
    expect(await getCdcInfrastructureCounts(source.database)).toEqual({ slots: 1, publications: 1 });

    let syncStatus: number | undefined;
    await onSource(source.database, async lockClient => {
      await lockClient.query("BEGIN");
      await lockClient.query("LOCK TABLE events IN ACCESS EXCLUSIVE MODE");
      const syncing = syncSource(data_source.id);
      try {
        await waitForBlockedDataSourceSync(source.database);

        // Delete does not wait for the sync, and the source is gone from every
        // read right away.
        expect((await deleteSource(data_source.id)).status).toBe(200);
        expect((await getSource(data_source.id)).status).toBe(404);
        expect((await listSources()).body.data_sources).toEqual([]);

        // But the slot the sync is about to read stays until the sync is done,
        // including across a scheduler pass that finds the lease still held.
        expect(await getCdcInfrastructureCounts(source.database)).toEqual({ slots: 1, publications: 1 });
        await runScheduledSyncs();
        expect(await getCdcInfrastructureCounts(source.database)).toEqual({ slots: 1, publications: 1 });
      } finally {
        await lockClient.query("ROLLBACK");
        syncStatus = (await syncing).status;
      }
    });
    // The sync ran to completion against a source that no longer exists.
    expect(syncStatus).toBe(404);

    // With the lease released, the next scheduler pass finishes the deletion.
    await runScheduledSyncs();
    expect(await getCdcInfrastructureCounts(source.database)).toEqual({ slots: 0, publications: 0 });
    expect((await deleteSource(data_source.id)).status).toBe(404);
  });
});

it("does not let one project touch another's source", async ({ expect }) => {
  await createProjectWithWarehouse();
  const ownedId = await withSourceDatabase(SIMPLE_SCHEMA, async source => {
    const { body: { data_source } } = await connectSource(source.database);
    await setStreams(data_source.id, [{ schema_name: "public", table_name: "plans", mode: "cursor", cursor_column: "id" }]);
    return data_source.id;
  });

  // A second project, entitled and provisioned, so the only thing standing
  // between it and the first project's source is the tenancy scoping itself.
  await createProjectWithWarehouse();
  expect((await listSources()).body.data_sources).toEqual([]);
  expect((await getSource(ownedId)).status).toBe(404);
  expect((await getCatalog(ownedId)).status).toBe(404);
  expect((await syncSource(ownedId)).status).toBe(404);
  expect((await setStreams(ownedId, [])).status).toBe(404);
  expect((await deleteSource(ownedId)).status).toBe(404);
});
