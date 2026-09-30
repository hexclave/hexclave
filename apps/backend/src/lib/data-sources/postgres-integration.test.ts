/**
 * Exercises the SQL this module actually sends against a real Postgres. The
 * catalog queries, the server-side cursor, and the whole CDC path are the parts
 * most likely to be wrong in a way types cannot catch, and mocking them would
 * only test the mock.
 *
 * Skipped unless a server is pointed at explicitly, since it needs one with
 * logical replication enabled:
 *
 *   docker run -d --name hexclave-ds-test -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=appdb -p 55432:5432 postgres:16 \
 *     -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10
 *   HEXCLAVE_DATA_SOURCE_TEST_POSTGRES=postgres:testpass@localhost:55432/appdb \
 *     pnpm test run apps/backend/src/lib/data-sources/postgres-integration.test.ts
 */
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeDataSource } from "./probe";
import { withDataSourceClient } from "./postgres";
import { decodePgoutputMessage, formatLsn, type PgoutputRelation } from "./pgoutput";
import type { SyncCursorState } from "./sync";

const TEST_SERVER = getEnvVariable("HEXCLAVE_DATA_SOURCE_TEST_POSTGRES", "") || undefined;

function parseTestServer(value: string) {
  const url = new URL(`postgresql://${value}`);
  return {
    host: url.hostname,
    port: Number.parseInt(url.port || "5432", 10),
    database: url.pathname.replace(/^\//, ""),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslMode: "disable",
  };
}

const credentials = parseTestServer(TEST_SERVER ?? "postgres:postgres@localhost:5432/postgres");

describe.skipIf(!TEST_SERVER)("Postgres data source", () => {

beforeAll(async () => {
  await withDataSourceClient(credentials, async client => {
    await client.query(`DROP TABLE IF EXISTS users, plans, events_noindex, keyless, cdc_items, cdc_big, cdc_noise, cdc_toast CASCADE`);
    await client.query(`CREATE TABLE users (id bigserial PRIMARY KEY, email text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`CREATE INDEX users_updated_at_idx ON users (updated_at)`);
    await client.query(`CREATE TABLE plans (id int PRIMARY KEY, name text NOT NULL)`);
    await client.query(`CREATE TABLE events_noindex (id bigserial PRIMARY KEY, payload jsonb, modified_at timestamp NOT NULL DEFAULT now())`);
    await client.query(`CREATE TABLE keyless (a int NOT NULL, b text)`);
    // Backdated so they sit outside the cursor safety lag; the lag test adds a
    // fresh row of its own to check the near edge.
    await client.query(`INSERT INTO users (email, updated_at) SELECT 'u' || g || '@example.com', now() - interval '1 hour' FROM generate_series(1, 500) g`);
    await client.query(`INSERT INTO plans VALUES (1, 'free'), (2, 'pro')`);
    await client.query(`ANALYZE`);
  }, { allowWrites: true });
}, 60000);

it("probes a real server", async () => {
  const result = await probeDataSource(credentials);
  console.log("CAPABILITIES", JSON.stringify(result.capabilities));
  for (const table of result.tables) {
    console.log(`TABLE ${table.schemaName}.${table.tableName} rows=${table.approxRows} pk=[${table.primaryKeyColumns}] cursors=[${table.cursorCandidates.map(c => `${c.column}${c.indexed ? "*" : ""}`).join(",")}] cols=${table.columns.map(c => c.name + ":" + c.dataType).join(",")}`);
  }
  expect(result.capabilities.walLevel).toBe("logical");
  expect(result.tables.map(t => t.tableName).sort()).toEqual(["events_noindex", "keyless", "plans", "users"]);
}, 30000);

it("creates a slot, decodes real WAL, and advances", async () => {
  await withDataSourceClient(credentials, async client => {
    await client.query(`DROP PUBLICATION IF EXISTS hexclave_check`);
    await client.query(`SELECT pg_drop_replication_slot('hexclave_check') WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name='hexclave_check')`);
    await client.query(`CREATE PUBLICATION hexclave_check FOR TABLE users, plans`);
    await client.query(`SELECT pg_create_logical_replication_slot('hexclave_check', 'pgoutput')`);

    await client.query(`INSERT INTO users (email) VALUES ('cdc-insert@example.com')`);
    await client.query(`UPDATE users SET email = 'cdc-updated@example.com' WHERE email = 'cdc-insert@example.com'`);
    await client.query(`DELETE FROM users WHERE email = 'cdc-updated@example.com'`);

    const changes = await client.query<{ lsn: string, data: Buffer }>(
      `SELECT lsn::text AS lsn, data FROM pg_logical_slot_peek_binary_changes($1, NULL, $2, 'proto_version', '1', 'publication_names', $3)`,
      ["hexclave_check", 1000, "hexclave_check"],
    );
    const relations = new Map<number, PgoutputRelation>();
    const decoded = changes.rows.map(row => decodePgoutputMessage(row.data, relations));
    const kinds = decoded.map(m => m.type);
    console.log("WAL MESSAGES", kinds.join(","));
    console.log("DECODED", JSON.stringify(decoded.filter(m => ["insert", "update", "delete"].includes(m.type))));

    expect(kinds).toContain("insert");
    expect(kinds).toContain("update");
    expect(kinds).toContain("delete");
    expect(relations.size).toBeGreaterThan(0);

    const lastCommit = [...decoded].reverse().find(m => m.type === "commit");
    if (lastCommit?.type !== "commit") throw new Error("no commit decoded");
    const lsnText = formatLsn(lastCommit.endLsn);
    await client.query(`SELECT pg_replication_slot_advance($1, $2::pg_lsn)`, ["hexclave_check", lsnText]);

    const after = await client.query(
      `SELECT count(*)::int AS n FROM pg_logical_slot_peek_binary_changes($1, NULL, NULL, 'proto_version', '1', 'publication_names', $2)`,
      ["hexclave_check", "hexclave_check"],
    );
    console.log("REMAINING AFTER ADVANCE", after.rows[0].n);
    expect(after.rows[0].n).toBe(0);

    await client.query(`SELECT pg_drop_replication_slot('hexclave_check')`);
    await client.query(`DROP PUBLICATION hexclave_check`);
  }, { allowWrites: true });
}, 30000);

/** Records what the engine would write, so the Postgres side can be exercised without ClickHouse. */
function recordingClickhouse() {
  const inserts: { table: string, rows: Record<string, unknown>[] }[] = [];
  const commands: string[] = [];
  return {
    client: {
      command: async ({ query }: { query: string }) => { commands.push(query.trim().split("\n")[0]); },
      query: async () => ({ json: async () => [] }),
      insert: async ({ table, values }: { table: string, values: Record<string, unknown>[] }) => {
        inserts.push({ table, rows: values });
      },
      close: async () => {},
    },
    inserts,
    commands,
  };
}

it("runs cursor mode end to end on the Postgres side", async () => {
  const { probeDataSource } = await import("./probe");
  const { runStreamSyncs } = await import("./sync");
  const probe = await probeDataSource(credentials);
  const tablesByName = new Map(probe.tables.map(t => [`${t.schemaName}.${t.tableName}`, t]));
  const recorder = recordingClickhouse();

  const context = {
    credentials,
    clickhouse: recorder.client as never,
    databaseName: "wh_test",
    tablesByName,
    slotName: "hexclave_check2",
    publicationName: "hexclave_check2",
    startedAt: new Date("2026-08-21T00:00:00Z"),
    deadlineMs: Date.now() + 60_000,
  };

  const results = await runStreamSyncs(context, [
    {
      streamId: "s-plans", schemaName: "public", tableName: "plans", mode: "cursor" as const,
      cursorColumn: "id", primaryKeyColumns: ["id"], destinationTable: "public_plans", isPending: false, syncCursor: null,
    },
    {
      streamId: "s-users", schemaName: "public", tableName: "users", mode: "cursor" as const,
      cursorColumn: "id", primaryKeyColumns: ["id"], destinationTable: "public_users", isPending: false, syncCursor: null,
    },
  ]);

  console.log("RESULTS", JSON.stringify(results, null, 2));
  console.log("COMMANDS", JSON.stringify(recorder.commands, null, 2));
  console.log("SAMPLE ROW", JSON.stringify(recorder.inserts.find(i => i.table.includes("plans"))?.rows[0]));
  console.log("USER ROW", JSON.stringify(recorder.inserts.find(i => i.table.includes("users"))?.rows[0]));

  const plans = results.find(r => r.streamId === "s-plans")!;
  const users = results.find(r => r.streamId === "s-users")!;
  expect(plans.error).toBeNull();
  expect(plans.rowsSynced).toBe(2);
  expect(users.error).toBeNull();
  expect(users.rowsSynced).toBe(500);
  expect(users.syncCursor).toMatchObject({ mode: "cursor", value: "500" });
  // The primary key of the last row read rides along, so a group of rows sharing
  // one cursor value can be resumed through instead of re-read forever.
  expect(JSON.parse(users.syncCursor!.key!)).toEqual(["500"]); // bigserial arrives as a string from pg
}, 60000);

it("resumes a cursor stream from its watermark", async () => {
  const { probeDataSource } = await import("./probe");
  const { runStreamSyncs } = await import("./sync");
  const probe = await probeDataSource(credentials);
  const recorder = recordingClickhouse();
  const results = await runStreamSyncs({
    credentials,
    clickhouse: recorder.client as never,
    databaseName: "wh_test",
    tablesByName: new Map(probe.tables.map(t => [`${t.schemaName}.${t.tableName}`, t])),
    slotName: "x", publicationName: "x", startedAt: new Date(), deadlineMs: Date.now() + 60_000,
  }, [{
    streamId: "s-users", schemaName: "public", tableName: "users", mode: "cursor" as const,
    cursorColumn: "id", primaryKeyColumns: ["id"], destinationTable: "public_users",
    isPending: false,
    syncCursor: { mode: "cursor", value: "495" },
  }]);
  console.log("RESUMED", JSON.stringify(results));
  // Without a stored key the watermark is inclusive, so the boundary row is
  // re-read rather than skipped.
  expect(results[0].rowsSynced).toBe(6);
}, 60000);

it("holds a timestamp cursor back from now(), so a late commit is not skipped", async () => {
  const { probeDataSource } = await import("./probe");
  const { runStreamSyncs } = await import("./sync");

  // Rows written just now sit inside the safety lag and must not be read yet:
  // reading up to now() would move the watermark past a transaction that has not
  // committed, and that row would never be read again.
  await withDataSourceClient(credentials, async client => {
    await client.query(`INSERT INTO users (email, updated_at) VALUES ('fresh@example.com', now())`);
  }, { allowWrites: true });

  const probe = await probeDataSource(credentials);
  const recorder = recordingClickhouse();
  const results = await runStreamSyncs({
    credentials,
    clickhouse: recorder.client as never,
    databaseName: "wh_test",
    tablesByName: new Map(probe.tables.map(t => [`${t.schemaName}.${t.tableName}`, t])),
    slotName: "x", publicationName: "x", startedAt: new Date(), deadlineMs: Date.now() + 60_000,
  }, [{
    streamId: "s-users", schemaName: "public", tableName: "users", mode: "cursor" as const,
    cursorColumn: "updated_at", primaryKeyColumns: ["id"], destinationTable: "public_users", isPending: false, syncCursor: null,
  }]);

  const emails = recorder.inserts.flatMap(i => i.rows).map(r => r.email);
  expect(emails).not.toContain("fresh@example.com");
  expect(results[0].error).toBeNull();
  expect(results[0].rowsSynced).toBeGreaterThan(0);
}, 60000);

describe("change data capture", () => {
  const SLOT = "hexclave_cdc_test";

  async function dropSlotAndPublication() {
    await withDataSourceClient(credentials, async client => {
      await client.query(`SELECT pg_drop_replication_slot($1) WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = $1)`, [SLOT]);
      await client.query(`DROP PUBLICATION IF EXISTS ${SLOT}`);
    }, { allowWrites: true });
  }

  async function runCdc(
    tables: { table: string, syncCursor?: SyncCursorState | null, primaryKeyColumns?: string[] }[],
    options: { deadlineMs?: number, credentials?: typeof credentials } = {},
  ) {
    const { runStreamSyncs } = await import("./sync");
    const probe = await probeDataSource(options.credentials ?? credentials);
    const recorder = recordingClickhouse();
    const results = await runStreamSyncs({
      credentials: options.credentials ?? credentials,
      clickhouse: recorder.client as never,
      databaseName: "wh_test",
      tablesByName: new Map(probe.tables.map(t => [`${t.schemaName}.${t.tableName}`, t])),
      slotName: SLOT,
      publicationName: SLOT,
      startedAt: new Date(),
      deadlineMs: options.deadlineMs ?? Date.now() + 120_000,
    }, tables.map(({ table, syncCursor, primaryKeyColumns }) => ({
      streamId: `s-${table}`, schemaName: "public", tableName: table, mode: "cdc" as const,
      cursorColumn: null, primaryKeyColumns: primaryKeyColumns ?? ["id"], destinationTable: `public_${table}`,
      isPending: false, syncCursor: syncCursor ?? null,
    })));
    return { results, recorder };
  }

  async function slotConfirmedLsn(): Promise<string> {
    return await withDataSourceClient(credentials, async client => {
      const result = await client.query<{ lsn: string }>(`SELECT confirmed_flush_lsn::text AS lsn FROM pg_replication_slots WHERE slot_name = $1`, [SLOT]);
      return result.rows[0].lsn;
    });
  }

  async function currentLsn(): Promise<string> {
    return await withDataSourceClient(credentials, async client => {
      return (await client.query<{ lsn: string }>(`SELECT pg_current_wal_lsn()::text AS lsn`)).rows[0].lsn;
    });
  }

  beforeAll(async () => {
    await dropSlotAndPublication();
    await withDataSourceClient(credentials, async client => {
      await client.query(`DROP TABLE IF EXISTS cdc_items, cdc_big, cdc_noise, cdc_toast CASCADE`);
      await client.query(`CREATE TABLE cdc_items (id int PRIMARY KEY, name text NOT NULL)`);
      await client.query(`INSERT INTO cdc_items SELECT g, 'item ' || g FROM generate_series(1, 10) g`);
      await client.query(`CREATE TABLE cdc_big (id int PRIMARY KEY, name text NOT NULL)`);
      await client.query(`INSERT INTO cdc_big SELECT g, 'big ' || g FROM generate_series(1, 25000) g`);
      await client.query(`CREATE TABLE cdc_noise (id bigserial PRIMARY KEY, payload text)`);
      await client.query(`CREATE TABLE cdc_toast (id int, part int, title text NOT NULL, body text NOT NULL, PRIMARY KEY (id, part))`);
      await client.query(`ALTER TABLE cdc_toast ALTER COLUMN body SET STORAGE EXTERNAL`);
      await client.query(`INSERT INTO cdc_toast SELECT g, 1, 'title', repeat('x', 2100) || g FROM generate_series(1, 30000) g`);
    }, { allowWrites: true });
  }, 120000);

  // The probe test above expects to see only its own tables on a rerun.
  afterAll(async () => {
    await dropSlotAndPublication();
    await withDataSourceClient(credentials, async client => {
      await client.query(`DROP TABLE IF EXISTS cdc_items, cdc_big, cdc_noise, cdc_toast CASCADE`);
      await client.query(`DROP OWNED BY hexclave_reader`);
      await client.query(`DROP ROLE hexclave_reader`);
    }, { allowWrites: true });
  }, 60000);

  it("works with a publication a DBA created, even though our role cannot alter it", async () => {
    await dropSlotAndPublication();
    await withDataSourceClient(credentials, async client => {
      await client.query(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hexclave_reader') THEN DROP OWNED BY hexclave_reader; DROP ROLE hexclave_reader; END IF; END $$`);
      await client.query(`CREATE ROLE hexclave_reader LOGIN REPLICATION PASSWORD 'readerpass'`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO hexclave_reader`);
      // What our error message tells the DBA to run, run as someone else.
      await client.query(`CREATE PUBLICATION ${SLOT} FOR TABLE public.cdc_items`);
    }, { allowWrites: true });
    const reader = { ...credentials, username: "hexclave_reader", password: "readerpass" };

    const first = await runCdc([{ table: "cdc_items" }], { credentials: reader });
    expect(first.results[0].error).toBeNull();
    expect(first.results[0].syncCursor?.mode).toBe("lsn");
    const second = await runCdc([{ table: "cdc_items", syncCursor: first.results[0].syncCursor }], { credentials: reader });
    expect(second.results[0].error).toBeNull();

    // A table list that does need changing asks for the ALTER it needs, not a
    // CREATE that would fail on the existing publication.
    const widened = await runCdc([{ table: "cdc_items", syncCursor: first.results[0].syncCursor }, { table: "cdc_big" }], { credentials: reader });
    expect(widened.results[0].error).toContain(`ALTER PUBLICATION "${SLOT}" SET TABLE`);
  }, 120000);

  it("loads a large table over several syncs, resuming by primary key", async () => {
    await dropSlotAndPublication();
    // No time beyond the reserve: each sync reads exactly one page and stops.
    const tight = () => Date.now() + 30_000;
    const seen = new Set<unknown>();
    let cursor: SyncCursorState | null = null;
    let syncs = 0;
    while (cursor?.mode !== "lsn") {
      const { results, recorder } = await runCdc([{ table: "cdc_big", syncCursor: cursor }], { deadlineMs: tight() });
      expect(results[0].error).toBeNull();
      for (const row of recorder.inserts.flatMap(i => i.rows)) seen.add(row.id);
      cursor = results[0].syncCursor;
      syncs++;
      expect(syncs).toBeLessThan(10);
    }
    expect(syncs).toBe(3);
    expect(seen.size).toBe(25000);
  }, 120000);

  it("drains a backlog larger than one peek in a single sync", async () => {
    await dropSlotAndPublication();
    const initial = await runCdc([{ table: "cdc_items" }]);
    await withDataSourceClient(credentials, async client => {
      // 10k single-row transactions: 30k pgoutput messages, more than one peek holds.
      await client.query(`DO $$ BEGIN FOR i IN 11..10010 LOOP INSERT INTO cdc_items VALUES (i, 'burst ' || i); COMMIT; END LOOP; END $$`);
    }, { allowWrites: true });
    const { results } = await runCdc([{ table: "cdc_items", syncCursor: initial.results[0].syncCursor }]);
    expect(results[0].error).toBeNull();
    expect(results[0].rowsSynced).toBe(10000);
  }, 180000);

  it("advances the slot when only unpublished tables are written", async () => {
    await dropSlotAndPublication();
    const initial = await runCdc([{ table: "cdc_items" }]);
    await withDataSourceClient(credentials, async client => {
      await client.query(`INSERT INTO cdc_noise (payload) SELECT repeat('n', 500) FROM generate_series(1, 20000)`);
    }, { allowWrites: true });
    const before = await currentLsn();
    const { results } = await runCdc([{ table: "cdc_items", syncCursor: initial.results[0].syncCursor }]);
    expect(results[0].error).toBeNull();
    expect(results[0].rowsSynced).toBe(0);
    const confirmed = await slotConfirmedLsn();
    await withDataSourceClient(credentials, async client => {
      const caughtUp = await client.query<{ ok: boolean }>(`SELECT $1::pg_lsn >= $2::pg_lsn AS ok`, [confirmed, before]);
      expect(caughtUp.rows[0].ok).toBe(true);
    });
  }, 120000);

  it("refetches withheld TOAST values for more keys than one IN list can hold", async () => {
    await dropSlotAndPublication();
    // A composite key: its row-wise IN list is what overflows Postgres' parser
    // stack, somewhere past ~20k keys in one statement.
    const initial = await runCdc([{ table: "cdc_toast", primaryKeyColumns: ["id", "part"] }]);
    await withDataSourceClient(credentials, async client => {
      await client.query(`UPDATE cdc_toast SET title = 'renamed'`);
    }, { allowWrites: true });
    const { results, recorder } = await runCdc([{ table: "cdc_toast", primaryKeyColumns: ["id", "part"], syncCursor: initial.results[0].syncCursor }]);
    expect(results[0].error).toBeNull();
    // Every row's final write carries the whole body, not the column default.
    const latest = new Map<unknown, Record<string, unknown>>();
    for (const row of recorder.inserts.flatMap(i => i.rows)) latest.set(row.id, row);
    expect(latest.size).toBe(30000);
    for (const row of latest.values()) {
      expect(row.title).toBe("renamed");
      expect(String(row.body).startsWith("xxxx")).toBe(true);
    }
    await dropSlotAndPublication();
  }, 120000);
});

});
