import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { it } from "../../../../helpers";
import { Auth, Project, niceBackendFetch } from "../../../backend-helpers";


const OTLP_RESOURCE_ATTRIBUTES = [
  { key: "service.namespace", value: { stringValue: "e2e" } },
  { key: "service.name", value: { stringValue: "issues-e2e" } },
  { key: "service.version", value: { stringValue: "test" } },
  { key: "deployment.environment.name", value: { stringValue: "test" } },
] as const;


const CHECKOUT_FRAMES = [
  "doWork (https://app.example.com/static/checkout.js:10:15)",
  "handleClick (https://app.example.com/static/checkout.js:22:3)",
] as const;

const PROFILE_FRAMES = [
  "renderProfile (https://app.example.com/static/profile.js:41:9)",
] as const;

function browserStack(header: string, frames: readonly string[]): string {
  return [header, ...frames.map((frame) => `    at ${frame}`)].join("\n");
}

type ErrorEventOptions = {
  name: string,
  message: string,
  eventAtMs: number,
  stack?: string,
  synthetic?: boolean,
  release?: string,
};

const ISSUE_TEST_TIMEOUT = 180_000;

function errorEvent(options: ErrorEventOptions) {
  return {
    event_type: "$error",
    event_at_ms: options.eventAtMs,
    data: {
      name: options.name,
      message: options.message,
      handled: true,
      ...options.stack === undefined ? {} : { stack: options.stack },
      ...options.synthetic === true ? { synthetic: true } : {},
      ...options.release === undefined ? {} : { release: options.release },
    },
  };
}

function checkoutTypeError(eventAtMs: number, message = "cart.total is not a function") {
  return errorEvent({
    name: "TypeError",
    message,
    eventAtMs,
    stack: browserStack(`TypeError: ${message}`, CHECKOUT_FRAMES),
  });
}


async function setUpIssuesProject() {
  const created = await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({
    "apps.installed.analytics.enabled": true,
    "apps.installed.observability.enabled": true,
  });
  const user = await Auth.fastSignUp();
  return { ...created, user };
}

type BatchEvent = ReturnType<typeof errorEvent>;

function toOtlpKvlistValues(data: Record<string, unknown>) {
  return Object.entries(data).map(([key, value]) => {
    if (typeof value === "string") return { key, value: { stringValue: value } };
    if (typeof value === "boolean") return { key, value: { boolValue: value } };
    throw new HexclaveAssertionError(`Unsupported OTLP kvlist value type for ${key}: ${typeof value}`);
  });
}

function errorLogRecord(event: BatchEvent, eventId: string) {
  return {
    timeUnixNano: `${event.event_at_ms}000000`,
    eventName: "$error",
    severityNumber: 17,
    attributes: [
      { key: "hexclave.signal.type", value: { stringValue: "error" } },
      { key: "hexclave.event.id", value: { stringValue: eventId } },
      { key: "hexclave.data", value: { kvlistValue: { values: toOtlpKvlistValues({ ...event.data, event_id: eventId }) } } },
    ],
  };
}

async function postBatch(options: { events: BatchEvent[], clientBatchId?: string }) {
  const clientBatchId = options.clientBatchId ?? randomUUID();
  const response = await niceBackendFetch("/api/v1/analytics/otlp/v1/logs", {
    method: "POST",
    accessType: "client",
    body: {
      resourceLogs: [{
        resource: { attributes: OTLP_RESOURCE_ATTRIBUTES },
        scopeLogs: [{
          logRecords: options.events.map((event, ordinal) => errorLogRecord(event, expectedOccurrenceId(clientBatchId, ordinal))),
        }],
      }],
    },
  });
  if (response.status !== 200 || response.body?.partialSuccess != null) {
    throw new HexclaveAssertionError("OTLP error ingest failed", { response });
  }
  const batchId = await discoverServerBatchId(expectedOccurrenceId(clientBatchId, 0));
  await waitForIssueMaterialization(batchId);
  return { batchId, clientBatchId, response };
}

async function discoverServerBatchId(occurrenceId: string): Promise<string> {
  const deadline = performance.now() + 60_000;
  while (true) {
    const rows = analyticsRows(await queryAnalytics(
      `SELECT DISTINCT batch_id FROM errors WHERE occurrence_id = {occurrenceId:String}`,
      { occurrenceId },
    ));
    if (rows.length > 1) {
      throw new HexclaveAssertionError(`Occurrence ${occurrenceId} unexpectedly appears under multiple batch ids`, { rows });
    }
    const batchId = rows.length === 1 ? rows[0].batch_id : undefined;
    if (typeof batchId === "string") return batchId;
    if (performance.now() > deadline) {
      throw new HexclaveAssertionError(`Occurrence ${occurrenceId} did not become queryable in ClickHouse within 60s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitForIssueMaterialization(batchId: string): Promise<void> {
  await withInternalDatabase(async (client) => {
    const deadline = performance.now() + 120_000;
    while (true) {
      const result = await client.query(`SELECT 1 FROM "IssueMaterialization" WHERE "batchId" = $1 LIMIT 1`, [batchId]);
      if ((result.rowCount ?? 0) > 0) return;
      if (performance.now() > deadline) {
        throw new HexclaveAssertionError(`Issue materialization for batch ${batchId} did not complete within 120s`, { batchId });
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
}

function issuesUrl(query: Record<string, string> = {}) {
  const search = new URLSearchParams(query).toString();
  return `/api/v1/internal/issues${search === "" ? "" : `?${search}`}`;
}

async function listIssues(query: Record<string, string> = {}) {
  return await niceBackendFetch(issuesUrl(query), { method: "GET", accessType: "admin" });
}

async function getIssue(issueId: string, query: Record<string, string> = {}) {
  const search = new URLSearchParams(query).toString();
  return await niceBackendFetch(
    `/api/v1/internal/issues/${encodeURIComponent(issueId)}${search === "" ? "" : `?${search}`}`,
    { method: "GET", accessType: "admin" },
  );
}

async function patchIssue(issueId: string, body: { status: string, ignored_until_millis?: number | null }) {
  return await niceBackendFetch(`/api/v1/internal/issues/${encodeURIComponent(issueId)}`, {
    method: "PATCH",
    accessType: "admin",
    body,
  });
}

async function queryAnalytics(query: string, params: Record<string, unknown> = {}) {
  return await niceBackendFetch("/api/v1/analytics/query", {
    method: "POST",
    accessType: "admin",
    body: { query, params },
  });
}

function analyticsRows(response: { status: number, body?: unknown }): Record<string, unknown>[] {
  if (response.status !== 200) {
    throw new HexclaveAssertionError("Analytics query failed", { response });
  }
  const body = response.body;
  const result = typeof body === "object" && body !== null && "result" in body ? (body as { result: unknown }).result : null;
  if (!Array.isArray(result)) {
    throw new HexclaveAssertionError("Analytics query did not return a result array", { response });
  }
  return result.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
}

type ListedIssue = {
  id: string,
  short_id: string,
  type: string,
  value: string,
  culprit: string,
  status: string,
  substatus: string,
  times_seen: string,
  counters_truncated_at_millis: number | null,
  window_occurrences: number,
  window_users: number,
  service_name: string | null,
  environment: string | null,
  release: string | null,
  first_seen_at_millis: number,
  last_seen_at_millis: number,
  issue_hashes: string[],
};

function itemsOf(response: { status: number, body?: any }): ListedIssue[] {
  if (response.status !== 200) {
    throw new HexclaveAssertionError("Issue list request failed", { response });
  }
  const items = response.body?.items;
  if (!Array.isArray(items)) {
    throw new HexclaveAssertionError("Issue list response had no items array", { response });
  }
  return items as ListedIssue[];
}

function onlyItem(response: { status: number, body?: any }): ListedIssue {
  const items = itemsOf(response);
  if (items.length !== 1) {
    throw new HexclaveAssertionError(`Expected exactly one issue, got ${items.length}`, { response });
  }
  return items[0];
}

function summarize(issue: ListedIssue) {
  return {
    short_id: issue.short_id,
    type: issue.type,
    value: issue.value,
    culprit: issue.culprit,
    status: issue.status,
    substatus: issue.substatus,
    times_seen: issue.times_seen,
    counters_truncated_at_millis: issue.counters_truncated_at_millis,
    window_occurrences: issue.window_occurrences,
    window_users: issue.window_users,
    service_name: issue.service_name,
    environment: issue.environment,
    owned_hash_count: issue.issue_hashes.length,
  };
}

function expectedOccurrenceId(clientBatchId: string, ordinal: number): string {
  return createHash("sha256").update(`${clientBatchId}:${ordinal}`, "utf8").digest("hex").slice(0, 32);
}

function internalDatabaseConnectionString(): string {
  const connectionString = getEnvVariable(
    "HEXCLAVE_DATABASE_CONNECTION_STRING",
    getEnvVariable("STACK_DATABASE_CONNECTION_STRING", ""),
  );
  if (connectionString === "") {
    throw new HexclaveAssertionError("Issue E2E tests require a configured internal database connection string");
  }
  return connectionString;
}

async function withInternalDatabase<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: internalDatabaseConnectionString(),
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}


it("returns OBSERVABILITY_NOT_ENABLED when the observability app is not installed", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ "apps.installed.analytics.enabled": true });

  const res = await listIssues();
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "OBSERVABILITY_NOT_ENABLED",
        "error": "Observability is not enabled for this project.",
      },
      "headers": Headers {
        "x-stack-known-error": "OBSERVABILITY_NOT_ENABLED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects non-admin access to the issues endpoints", async ({ expect }) => {
  await setUpIssuesProject();

  const clientRes = await niceBackendFetch(issuesUrl(), { method: "GET", accessType: "client" });
  expect(clientRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "INSUFFICIENT_ACCESS_TYPE",
        "details": {
          "actual_access_type": "client",
          "allowed_access_types": ["admin"],
        },
        "error": "The x-hexclave-access-type header must be 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
      },
      "headers": Headers {
        "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
        <some fields may have been hidden>,
      },
    }
  `);

  const serverRes = await niceBackendFetch(issuesUrl(), { method: "GET", accessType: "server" });
  expect(serverRes.status).toBe(401);
  expect(serverRes.body?.code).toBe("INSUFFICIENT_ACCESS_TYPE");
});


it("stamps grouping columns and a deterministic occurrence_id onto ingested $error rows", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  const { batchId, clientBatchId } = await postBatch({ events: [checkoutTypeError(now)] });

  const rows = analyticsRows(await queryAnalytics(
    `SELECT occurrence_id, batch_id, event_type, error_type, error_culprit, data.message AS message, level,
            issue_hash, length(issue_hashes) AS owned_hash_count, issue_grouping_config, issue_variant, grouping_degraded
     FROM errors
     WHERE batch_id = {batchId:String}`,
    { batchId },
  ));
  expect(rows).toHaveLength(1);
  const row = rows[0];

  expect(row.occurrence_id).toBe(expectedOccurrenceId(clientBatchId, 0));
  expect(row.issue_hash).toMatch(/^[0-9a-f]{32}$/);

  expect({
    event_type: row.event_type,
    error_type: row.error_type,
    error_culprit: row.error_culprit,
    message: row.message,
    level: row.level,
    owned_hash_count: row.owned_hash_count,
    issue_grouping_config: row.issue_grouping_config,
    issue_variant: row.issue_variant,
    grouping_degraded: row.grouping_degraded,
  }).toMatchInlineSnapshot(`
    {
      "error_culprit": "doWork (/static/checkout.js)",
      "error_type": "TypeError",
      "event_type": "$error",
      "grouping_degraded": 0,
      "issue_grouping_config": "hexclave-js:2026-08-01",
      "issue_variant": "system",
      "level": "error",
      "message": "cart.total is not a function",
      "owned_hash_count": 1,
    }
  `);

  const detail = await getIssue(onlyItem(await listIssues()).id);
  expect(detail.status).toBe(200);
  expect(detail.body?.occurrence?.frames).toMatchInlineSnapshot(`
    [
      {
        "abs_path": "https://app.example.com/static/checkout.js",
        "colno": 3,
        "filename": "/static/checkout.js",
        "function": "handleClick",
        "in_app": true,
        "lineno": 22,
        "module": "static/checkout",
        "symbolication": {
          "context": null,
          "diagnostics": [
            {
              "code": "missing_release_metadata",
              "message": "The occurrence projection and canonical error envelope do not contain an exact release value, so source-map lookup was not attempted.",
            },
          ],
          "name": null,
          "original_column": null,
          "original_line": null,
          "source_file": null,
          "status": "not_attempted",
        },
      },
      {
        "abs_path": "https://app.example.com/static/checkout.js",
        "colno": 15,
        "filename": "/static/checkout.js",
        "function": "doWork",
        "in_app": true,
        "lineno": 10,
        "module": "static/checkout",
        "symbolication": {
          "context": null,
          "diagnostics": [
            {
              "code": "missing_release_metadata",
              "message": "The occurrence projection and canonical error envelope do not contain an exact release value, so source-map lookup was not attempted.",
            },
          ],
          "name": null,
          "original_column": null,
          "original_line": null,
          "source_file": null,
          "status": "not_attempted",
        },
      },
    ]
  `);
});

it("collapses two occurrences of the same error into one issue", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now)] });
  await postBatch({ events: [checkoutTypeError(now + 1_000)] });

  const issue = onlyItem(await listIssues());
  expect(summarize(issue)).toMatchInlineSnapshot(`
    {
      "counters_truncated_at_millis": null,
      "culprit": "doWork (/static/checkout.js)",
      "environment": "test",
      "owned_hash_count": 1,
      "service_name": "issues-e2e",
      "short_id": "1",
      "status": "unresolved",
      "substatus": "new",
      "times_seen": "2",
      "type": "TypeError",
      "value": "cart.total is not a function",
      "window_occurrences": 2,
      "window_users": 1,
    }
  `);
  expect(issue.last_seen_at_millis).toBe(now + 1_000);
  expect(issue.first_seen_at_millis).toBe(now);
});

it("does not merge a TypeError and a RangeError thrown from the same frame", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  const message = "value out of bounds";
  await postBatch({
    events: [
      errorEvent({ name: "TypeError", message, eventAtMs: now, stack: browserStack(`TypeError: ${message}`, CHECKOUT_FRAMES) }),
      errorEvent({ name: "RangeError", message, eventAtMs: now, stack: browserStack(`RangeError: ${message}`, CHECKOUT_FRAMES) }),
    ],
  });

  const items = itemsOf(await listIssues());
  expect(items).toHaveLength(2);
  expect(new Set(items.flatMap((item) => item.issue_hashes)).size).toBe(2);
  expect(items.map((item) => ({ type: item.type, culprit: item.culprit, times_seen: item.times_seen })).sort((a, b) => stringCompare(a.type, b.type))).toMatchInlineSnapshot(`
    [
      {
        "culprit": "doWork (/static/checkout.js)",
        "times_seen": "1",
        "type": "RangeError",
      },
      {
        "culprit": "doWork (/static/checkout.js)",
        "times_seen": "1",
        "type": "TypeError",
      },
    ]
  `);
});

it("does not merge two different non-Error (synthetic) throws", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  const syntheticStack = browserStack("Error: thrown value", PROFILE_FRAMES);
  await postBatch({
    events: [
      errorEvent({ name: "Error", message: "Non-Error thrown: payment declined", eventAtMs: now, stack: syntheticStack, synthetic: true }),
      errorEvent({ name: "Error", message: "Non-Error thrown: session expired", eventAtMs: now, stack: syntheticStack, synthetic: true }),
    ],
  });

  const items = itemsOf(await listIssues());
  expect(items).toHaveLength(2);
  expect(new Set(items.flatMap((item) => item.issue_hashes)).size).toBe(2);
  expect(items.map((item) => item.value).sort()).toMatchInlineSnapshot(`
    [
      "Non-Error thrown: payment declined",
      "Non-Error thrown: session expired",
    ]
  `);

  await postBatch({
    events: [errorEvent({ name: "Error", message: "Non-Error thrown: payment declined", eventAtMs: now + 1_000, stack: syntheticStack, synthetic: true })],
  });
  const after = itemsOf(await listIssues());
  expect(after).toHaveLength(2);
  expect(after.map((item) => item.times_seen).sort()).toEqual(["1", "2"]);
});


it("increments times_seen exactly once when the same batch_id is posted twice", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  const clientBatchId = randomUUID();
  const events = [checkoutTypeError(now)];

  const { batchId } = await postBatch({ clientBatchId, events });
  const afterFirst = onlyItem(await listIssues());
  expect(afterFirst.times_seen).toBe("1");

  const { batchId: retryBatchId } = await postBatch({ clientBatchId, events });
  expect(retryBatchId).toBe(batchId);
  const afterRetry = onlyItem(await listIssues());

  expect({ times_seen: afterRetry.times_seen, substatus: afterRetry.substatus }).toMatchInlineSnapshot(`
    {
      "substatus": "new",
      "times_seen": "1",
    }
  `);
  expect(afterRetry.id).toBe(afterFirst.id);
  expect(afterRetry.short_id).toBe(afterFirst.short_id);

  const ledgerRows = await withInternalDatabase(async (client) => {
    return await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "IssueMaterialization" WHERE "batchId" = $1`,
      [batchId],
    );
  });
  expect(ledgerRows.rows[0].count).toBe("1");
});

it.fails("does not inflate window_occurrences when the same batch is retried", async ({ expect }) => {
  await setUpIssuesProject();

  const clientBatchId = randomUUID();
  const events = [checkoutTypeError(Date.now())];
  await postBatch({ clientBatchId, events });
  await postBatch({ clientBatchId, events });

  expect(onlyItem(await listIssues()).window_occurrences).toBe(1);
});

it("produces a byte-identical occurrence_id across retries of the same batch", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  const clientBatchId = randomUUID();
  const events = [checkoutTypeError(now), checkoutTypeError(now + 1, "other failure")];

  const { batchId } = await postBatch({ clientBatchId, events });
  const first = analyticsRows(await queryAnalytics(
    `SELECT occurrence_id FROM errors WHERE batch_id = {batchId:String} ORDER BY occurrence_id`,
    { batchId },
  )).map((row) => row.occurrence_id);

  const { batchId: retryBatchId } = await postBatch({ clientBatchId, events });
  expect(retryBatchId).toBe(batchId);
  const second = analyticsRows(await queryAnalytics(
    `SELECT occurrence_id FROM errors WHERE batch_id = {batchId:String} ORDER BY occurrence_id`,
    { batchId },
  )).map((row) => row.occurrence_id);

  expect(second).toEqual(first);
  expect(new Set(first).size).toBe(2);
  expect(new Set(first)).toEqual(new Set([expectedOccurrenceId(clientBatchId, 0), expectedOccurrenceId(clientBatchId, 1)]));
});


it("reopens a resolved issue as regressed when a new occurrence arrives", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now)] });
  const issue = onlyItem(await listIssues());

  const patchRes = await patchIssue(issue.id, { status: "resolved" });
  expect(patchRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "id": "<stripped UUID>",
        "status": "resolved",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(itemsOf(await listIssues({ status: "unresolved" }))).toHaveLength(0);
  expect(onlyItem(await listIssues({ status: "resolved" })).status).toBe("resolved");

  await postBatch({ events: [checkoutTypeError(now + 1_000)] });

  const regressed = onlyItem(await listIssues({ status: "unresolved" }));
  expect({ status: regressed.status, substatus: regressed.substatus, times_seen: regressed.times_seen }).toMatchInlineSnapshot(`
    {
      "status": "unresolved",
      "substatus": "regressed",
      "times_seen": "2",
    }
  `);
});

it("regresses on server receipt time, not on the client clock, for a back-dated occurrence", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now)] });
  const issue = onlyItem(await listIssues());
  expect((await patchIssue(issue.id, { status: "resolved" })).status).toBe(200);

  const backdatedAtMs = now - 2 * 60 * 60 * 1000;
  await postBatch({ events: [checkoutTypeError(backdatedAtMs)] });

  const after = onlyItem(await listIssues({ status: "all" }));
  expect({ status: after.status, substatus: after.substatus, times_seen: after.times_seen }).toMatchInlineSnapshot(`
    {
      "status": "unresolved",
      "substatus": "regressed",
      "times_seen": "2",
    }
  `);
  expect(after.last_seen_at_millis).toBe(now);
  expect(after.first_seen_at_millis).toBe(backdatedAtMs);
});

it("reports an issue whose snooze has expired as unresolved before the next occurrence", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now)] });
  const issue = onlyItem(await listIssues());

  const patchRes = await patchIssue(issue.id, { status: "ignored", ignored_until_millis: now - 60_000 });
  expect(patchRes.status).toBe(200);

  const listed = onlyItem(await listIssues({ status: "all" }));
  expect(listed.status).toBe("unresolved");

  const detail = await getIssue(issue.id);
  expect(detail.status).toBe(200);
  expect(detail.body?.issue?.status).toBe("unresolved");

  expect((await listIssues({ status: "all" })).body?.counts).toMatchInlineSnapshot(`
    {
      "ignored": 0,
      "resolved": 0,
      "unresolved": 1,
    }
  `);

  expect(itemsOf(await listIssues({ status: "unresolved" }))).toHaveLength(1);
  expect(itemsOf(await listIssues({ status: "ignored" }))).toHaveLength(0);

  expect((await patchIssue(issue.id, { status: "ignored", ignored_until_millis: now + 60 * 60 * 1000 })).status).toBe(200);
  expect(onlyItem(await listIssues({ status: "all" })).status).toBe("ignored");

  expect((await patchIssue(issue.id, { status: "ignored" })).status).toBe(200);
  expect(onlyItem(await listIssues({ status: "all" })).status).toBe("ignored");
});


it("returns short_id and times_seen as strings, not numbers", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now)] });
  await postBatch({ events: [checkoutTypeError(now + 1_000)] });

  const listed = onlyItem(await listIssues());
  expect(typeof listed.short_id).toBe("string");
  expect(typeof listed.times_seen).toBe("string");
  expect({ short_id: listed.short_id, times_seen: listed.times_seen }).toMatchInlineSnapshot(`
    {
      "short_id": "1",
      "times_seen": "2",
    }
  `);

  const detail = await getIssue(listed.id);
  expect(detail.status).toBe(200);
  expect(typeof detail.body?.issue?.short_id).toBe("string");
  expect(typeof detail.body?.issue?.times_seen).toBe("string");
});

it("resolves the detail route by uuid, by numeric short id, and through an IssueRedirect", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now)] });
  const issue = onlyItem(await listIssues());

  const byUuid = await getIssue(issue.id);
  expect(byUuid.status).toBe(200);
  expect(byUuid.body?.issue?.id).toBe(issue.id);
  expect(byUuid.body?.redirected_from_issue_id).toBe(null);

  const byShortId = await getIssue(issue.short_id);
  expect(byShortId.status).toBe(200);
  expect(byShortId.body?.issue?.id).toBe(issue.id);

  const mergedAwayIssueId = randomUUID();
  await withInternalDatabase(async (client) => {
    const tenancies = await client.query<{ tenancyId: string }>(
      `SELECT "tenancyId" FROM "Issue" WHERE "id" = $1::uuid`,
      [issue.id],
    );
    if (tenancies.rows.length !== 1) {
      throw new HexclaveAssertionError("Expected exactly one Issue row for the seeded issue");
    }
    await client.query(
      `INSERT INTO "IssueRedirect" ("tenancyId", "fromIssueId", "toIssueId", "fromShortId")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint)`,
      [tenancies.rows[0].tenancyId, mergedAwayIssueId, issue.id, "9999"],
    );
  });

  let byRedirect = await getIssue(mergedAwayIssueId);
  const redirectDeadline = performance.now() + 15_000;
  while (byRedirect.status === 404 && performance.now() < redirectDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    byRedirect = await getIssue(mergedAwayIssueId);
  }
  expect(byRedirect.status).toBe(200);
  expect(byRedirect.body?.issue?.id).toBe(issue.id);
  expect(byRedirect.body?.redirected_from_issue_id).toBe(mergedAwayIssueId);

  const malformed = await getIssue("not-an-id");
  expect(malformed).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "issue_id must be a UUID or a numeric short id",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const missing = await getIssue(randomUUID());
  expect(missing).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": "Issue not found",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("cannot read or mutate another project's issue", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();
  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now)] });
  const projectAIssue = onlyItem(await listIssues());

  await setUpIssuesProject();
  await postBatch({ events: [errorEvent({ name: "Error", message: "project B only", eventAtMs: now, stack: browserStack("Error: project B only", PROFILE_FRAMES) })] });
  const projectBIssue = onlyItem(await listIssues());
  expect(projectBIssue.id).not.toBe(projectAIssue.id);
  expect(projectBIssue.short_id).toBe("1");
  expect((await getIssue("1")).body?.issue?.id).toBe(projectBIssue.id);

  const crossRead = await getIssue(projectAIssue.id);
  expect(crossRead).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": "Issue not found",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const crossWrite = await patchIssue(projectAIssue.id, { status: "resolved" });
  expect(crossWrite).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": "Issue not found",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("filters the issue list by status, service, and environment", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({
    events: [
      checkoutTypeError(now),
      errorEvent({ name: "ReferenceError", message: "profile is not defined", eventAtMs: now, stack: browserStack("ReferenceError: profile is not defined", PROFILE_FRAMES) }),
    ],
  });

  const all = itemsOf(await listIssues({ status: "all" }));
  expect(all).toHaveLength(2);
  const resolvedTarget = all.find((item) => item.type === "TypeError") ?? throwMissing("TypeError issue");
  expect((await patchIssue(resolvedTarget.id, { status: "resolved" })).status).toBe(200);

  expect(itemsOf(await listIssues({ status: "unresolved" })).map((item) => item.type)).toEqual(["ReferenceError"]);
  expect(itemsOf(await listIssues({ status: "resolved" })).map((item) => item.type)).toEqual(["TypeError"]);
  expect(itemsOf(await listIssues({ status: "ignored" }))).toHaveLength(0);

  const allRes = await listIssues({ status: "all" });
  expect(allRes.body?.counts).toMatchInlineSnapshot(`
    {
      "ignored": 0,
      "resolved": 1,
      "unresolved": 1,
    }
  `);
  expect(allRes.body?.approximate).toBe(false);
  expect(allRes.body?.cursor).toBe(null);

  expect(itemsOf(await listIssues({ status: "all", service: "issues-e2e" }))).toHaveLength(2);
  expect(itemsOf(await listIssues({ status: "all", service: "some-other-service" }))).toHaveLength(0);
  expect(itemsOf(await listIssues({ status: "all", environment: "test" }))).toHaveLength(2);
  expect(itemsOf(await listIssues({ status: "all", environment: "production" }))).toHaveLength(0);

  expect(itemsOf(await listIssues({ status: "all", search: "profile" })).map((item) => item.type)).toEqual(["ReferenceError"]);
  expect(itemsOf(await listIssues({ status: "all", search: "nothing-matches-this" }))).toHaveLength(0);

  expect(itemsOf(await listIssues({ status: "all", sort: "events" }))).toHaveLength(2);
  expect((await listIssues({ status: "all", sort: "events" })).body?.approximate).toBe(false);
});

it("validates issue list query parameters", async ({ expect }) => {
  await setUpIssuesProject();

  expect(await listIssues({ hours: "3" })).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "hours must be one of 1, 24, 168, 720",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(await listIssues({ status: "bogus" })).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "status must be one of unresolved, resolved, ignored, all",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(await listIssues({ sort: "bogus" })).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "sort must be one of last_seen, first_seen, events, users",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(await listIssues({ handled: "bogus" })).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "handled must be one of all, handled, unhandled",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(await listIssues({ limit: "0" })).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "limit must be a positive integer",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect((await listIssues({ hours: "720", status: "all", sort: "users", sort_dir: "asc", limit: "10", handled: "handled" })).status).toBe(200);
});

it("paginates the issue list with a keyset cursor", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({
    events: [
      checkoutTypeError(now),
      errorEvent({ name: "ReferenceError", message: "profile is not defined", eventAtMs: now + 1_000, stack: browserStack("ReferenceError: profile is not defined", PROFILE_FRAMES) }),
    ],
  });

  const first = await listIssues({ status: "all", limit: "1" });
  expect(itemsOf(first)).toHaveLength(1);
  const cursor = first.body?.cursor;
  if (typeof cursor !== "string") {
    throw new HexclaveAssertionError("Expected a next-page cursor", { response: first });
  }

  const second = await listIssues({ status: "all", limit: "1", cursor });
  expect(itemsOf(second)).toHaveLength(1);
  expect(itemsOf(second)[0].id).not.toBe(itemsOf(first)[0].id);
  expect(second.body?.cursor).toBe(null);
});

it("navigates an issue's occurrences with the older/newer cursors", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now)] });
  await postBatch({ events: [checkoutTypeError(now + 5_000)] });

  const issue = onlyItem(await listIssues());
  const newest = await getIssue(issue.id);
  expect(newest.status).toBe(200);
  expect(newest.body?.occurrence?.event_at_millis).toBe(now + 5_000);
  expect(newest.body?.occurrence?.message).toBe("cart.total is not a function");
  expect(newest.body?.occurrence?.raw_stack).toContain("at doWork (https://app.example.com/static/checkout.js:10:15)");

  const olderCursor = newest.body?.older_cursor;
  if (typeof olderCursor !== "string") {
    throw new HexclaveAssertionError("Expected an older cursor", { response: newest });
  }
  const older = await getIssue(issue.id, { occurrence: olderCursor, direction: "older" });
  expect(older.status).toBe(200);
  expect(older.body?.occurrence?.event_at_millis).toBe(now);
});


it("merges issues, picking the primary by (firstSeenAt asc, timesSeen desc, id asc) and summing lifetime counters", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now - 60_000)] });
  await postBatch({
    events: [
      errorEvent({ name: "ReferenceError", message: "profile is not defined", eventAtMs: now, stack: browserStack("ReferenceError: profile is not defined", PROFILE_FRAMES) }),
      errorEvent({ name: "ReferenceError", message: "profile is not defined", eventAtMs: now + 1, stack: browserStack("ReferenceError: profile is not defined", PROFILE_FRAMES) }),
    ],
  });

  const items = itemsOf(await listIssues({ status: "all" }));
  expect(items).toHaveLength(2);
  const older = items.find((item) => item.type === "TypeError") ?? throwMissing("TypeError issue");
  const newer = items.find((item) => item.type === "ReferenceError") ?? throwMissing("ReferenceError issue");

  const mergeRes = await niceBackendFetch("/api/v1/internal/issues/merge", {
    method: "POST",
    accessType: "admin",
    body: { issue_ids: [newer.id, older.id] },
  });
  expect(mergeRes.status).toBe(200);
  expect(mergeRes.body?.primary_issue_id).toBe(older.id);
  expect(mergeRes.body?.merged_issue_ids).toEqual([newer.id]);

  const merged = onlyItem(await listIssues({ status: "all" }));
  expect(merged.id).toBe(older.id);
  expect(merged.times_seen).toBe("3");
  expect(merged.issue_hashes).toHaveLength(2);
  expect(merged.counters_truncated_at_millis).toBe(null);

  const redirected = await getIssue(newer.id);
  expect(redirected.status).toBe(200);
  expect(redirected.body?.issue?.id).toBe(older.id);
  expect(redirected.body?.redirected_from_issue_id).toBe(newer.id);
});

it("merging into an already-merged issue follows the redirect and creates no chain", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now - 120_000)] });
  await postBatch({ events: [errorEvent({ name: "ReferenceError", message: "profile is not defined", eventAtMs: now - 60_000, stack: browserStack("ReferenceError: profile is not defined", PROFILE_FRAMES) })] });
  await postBatch({ events: [errorEvent({ name: "SyntaxError", message: "unexpected token", eventAtMs: now, stack: browserStack("SyntaxError: unexpected token", PROFILE_FRAMES) })] });

  const items = itemsOf(await listIssues({ status: "all" }));
  const first = items.find((item) => item.type === "TypeError") ?? throwMissing("TypeError issue");
  const second = items.find((item) => item.type === "ReferenceError") ?? throwMissing("ReferenceError issue");
  const third = items.find((item) => item.type === "SyntaxError") ?? throwMissing("SyntaxError issue");

  const firstMerge = await niceBackendFetch("/api/v1/internal/issues/merge", {
    method: "POST", accessType: "admin", body: { issue_ids: [first.id, second.id] },
  });
  expect(firstMerge.body?.primary_issue_id).toBe(first.id);

  const secondMerge = await niceBackendFetch("/api/v1/internal/issues/merge", {
    method: "POST", accessType: "admin", body: { issue_ids: [second.id, third.id] },
  });
  expect(secondMerge.status).toBe(200);
  expect(secondMerge.body?.primary_issue_id).toBe(first.id);

  const redirects = await withInternalDatabase(async (client) => {
    return await client.query<{ fromIssueId: string, toIssueId: string }>(
      `SELECT "fromIssueId", "toIssueId" FROM "IssueRedirect" WHERE "toIssueId" = $1::uuid OR "fromIssueId" = $1::uuid`,
      [first.id],
    );
  });
  expect(redirects.rows.every((row) => row.toIssueId === first.id)).toBe(true);
  expect(new Set(redirects.rows.map((row) => row.fromIssueId))).toEqual(new Set([second.id, third.id]));
});

it("unmerge is retroactive: historical occurrences owned by the split hash resolve to the new issue", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now - 60_000)] });
  await postBatch({ events: [errorEvent({ name: "ReferenceError", message: "profile is not defined", eventAtMs: now, stack: browserStack("ReferenceError: profile is not defined", PROFILE_FRAMES) })] });

  const before = itemsOf(await listIssues({ status: "all" }));
  const older = before.find((item) => item.type === "TypeError") ?? throwMissing("TypeError issue");
  const newer = before.find((item) => item.type === "ReferenceError") ?? throwMissing("ReferenceError issue");
  const splitHash = newer.issue_hashes[0];

  await niceBackendFetch("/api/v1/internal/issues/merge", {
    method: "POST", accessType: "admin", body: { issue_ids: [older.id, newer.id] },
  });

  const mergedDetail = await getIssue(older.id);
  expect(mergedDetail.body?.occurrence?.event_at_millis).toBe(now);

  const unmergeRes = await niceBackendFetch(`/api/v1/internal/issues/${encodeURIComponent(older.id)}/unmerge`, {
    method: "POST", accessType: "admin", body: { hashes: [splitHash] },
  });
  expect(unmergeRes.status).toBe(200);
  expect(unmergeRes.body?.source_issue_id).toBe(older.id);
  const newIssueId = unmergeRes.body?.new_issue_id;
  if (typeof newIssueId !== "string") {
    throw new HexclaveAssertionError("Unmerge did not return a new issue id", { response: unmergeRes });
  }

  const newDetail = await getIssue(newIssueId);
  expect(newDetail.status).toBe(200);
  expect(newDetail.body?.occurrence?.event_at_millis).toBe(now);
  expect(newDetail.body?.issue?.issue_hashes).toEqual([splitHash]);

  const sourceDetail = await getIssue(older.id);
  expect(sourceDetail.body?.occurrence?.event_at_millis).toBe(now - 60_000);
  expect(sourceDetail.body?.issue?.issue_hashes).not.toContain(splitHash);
});

it("unmerge stamps counters_truncated_at_millis on the new issue", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now - 60_000)] });
  await postBatch({ events: [errorEvent({ name: "ReferenceError", message: "profile is not defined", eventAtMs: now, stack: browserStack("ReferenceError: profile is not defined", PROFILE_FRAMES) })] });

  const before = itemsOf(await listIssues({ status: "all" }));
  const older = before.find((item) => item.type === "TypeError") ?? throwMissing("TypeError issue");
  const newer = before.find((item) => item.type === "ReferenceError") ?? throwMissing("ReferenceError issue");
  const splitHash = newer.issue_hashes[0];

  await niceBackendFetch("/api/v1/internal/issues/merge", {
    method: "POST", accessType: "admin", body: { issue_ids: [older.id, newer.id] },
  });
  const unmergeRes = await niceBackendFetch(`/api/v1/internal/issues/${encodeURIComponent(older.id)}/unmerge`, {
    method: "POST", accessType: "admin", body: { hashes: [splitHash] },
  });
  expect(unmergeRes.status).toBe(200);

  const truncatedAt = unmergeRes.body?.counters_truncated_at_millis;
  expect(typeof truncatedAt).toBe("number");
  const newIssue = itemsOf(await listIssues({ status: "all" })).find((item) => item.id === unmergeRes.body?.new_issue_id);
  expect(newIssue?.counters_truncated_at_millis).toBe(truncatedAt);
});

it("resolves a merged-away NUMERIC short id through IssueRedirect", { timeout: ISSUE_TEST_TIMEOUT }, async ({ expect }) => {
  await setUpIssuesProject();

  const now = Date.now();
  await postBatch({ events: [checkoutTypeError(now - 60_000)] });
  await postBatch({ events: [errorEvent({ name: "ReferenceError", message: "profile is not defined", eventAtMs: now, stack: browserStack("ReferenceError: profile is not defined", PROFILE_FRAMES) })] });

  const items = itemsOf(await listIssues({ status: "all" }));
  const primary = items.find((item) => item.type === "TypeError") ?? throwMissing("TypeError issue");
  const loser = items.find((item) => item.type === "ReferenceError") ?? throwMissing("ReferenceError issue");
  const loserShortId = loser.short_id;

  const merge = await niceBackendFetch("/api/v1/internal/issues/merge", {
    method: "POST", accessType: "admin", body: { issue_ids: [primary.id, loser.id] },
  });
  expect(merge.status).toBe(200);
  expect(merge.body?.primary_issue_id).toBe(primary.id);

  const byShortId = await getIssue(loserShortId);
  expect(byShortId.status).toBe(200);
  expect(byShortId.body?.issue?.id).toBe(primary.id);
  expect(byShortId.body?.redirected_from_issue_id).toBe(loser.id);

  const byUuid = await getIssue(loser.id);
  expect(byUuid.status).toBe(200);
  expect(byUuid.body?.issue?.id).toBe(primary.id);
});

function throwMissing(what: string): never {
  throw new HexclaveAssertionError(`Expected to find ${what} in the issue list`);
}
