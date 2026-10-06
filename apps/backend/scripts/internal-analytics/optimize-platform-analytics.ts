/**
 * Optimization harness: rewrite the heaviest platform-analytics queries and
 * prove each variant returns BYTE-IDENTICAL results to the original while
 * lowering peak memory. Isolated scratch DBs (bench_pa), seeded server-side.
 *
 * This is what justified the sipHash64 key changes in route.tsx (dauSeries,
 * sparkByProject, mauProjects, activeByProject) — exact, and 30-60% less peak
 * memory. It also documents the negative results: hashing the country group key
 * doesn't help (argMax payload dominates), and the PG authMethods rewrites are
 * far worse than the original 5-join plan once the production composite PK
 * indexes exist.
 *
 * Run: pnpm --filter @hexclave/backend run with-env:dev tsx scripts/optimize-platform-analytics.ts
 * Env: PA_SKIP_SEED=1 reuse data; PA_KEEP=1 keep data; PA_EVENTS / PA_USERS / PA_PROJECTS.
 */
import { getClickhouseAdminClient, getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { globalPrismaClient } from "@/prisma-client";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const envInt = (n: string, f: number) => {
  const v = getEnvVariable(n, "");
  return v === "" ? f : Number(v);
};
const envBool = (n: string) => ["1", "true"].includes(getEnvVariable(n, ""));
const NUM_PROJECTS = envInt("PA_PROJECTS", 10_000);
const NUM_USERS = envInt("PA_USERS", 1_000_000);
const NUM_EVENTS = envInt("PA_EVENTS", 50_000_000);
const ZIPF_K = 4, BRANCH = "main", INTERNAL = "internal";
const chAdmin = getClickhouseAdminClient();
const chMetrics = getClickhouseAdminClientForMetrics();
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const ONE_DAY_MS = 86400000, WINDOW_DAYS = 30;
const now = new Date();
const todayUtc = new Date(now);
todayUtc.setUTCHours(0, 0, 0, 0);
const windowStart = new Date(todayUtc.getTime() - (WINDOW_DAYS - 1) * ONE_DAY_MS);
const priorStart = new Date(todayUtc.getTime() - (2 * WINDOW_DAYS - 1) * ONE_DAY_MS);
const untilExclusive = new Date(todayUtc.getTime() + ONE_DAY_MS);
const chDT = (d: Date) => d.toISOString().slice(0, 19);
const sinceParam = chDT(windowStart), midParam = chDT(windowStart), priorSinceParam = chDT(priorStart), untilParam = chDT(untilExclusive);

async function seed() {
  log("CH: (re)create bench_pa.events");
  await chAdmin.command({ query: "DROP DATABASE IF EXISTS bench_pa" });
  await chAdmin.command({ query: "CREATE DATABASE bench_pa" });
  await chAdmin.command({ query: "CREATE TABLE bench_pa.events AS analytics_internal.events" });
  const projExpr = (k: string) => `concat('bench-proj-', toString(toUInt32(floor(${NUM_PROJECTS} * pow((cityHash64(${k}) % 1000000)/1000000.0, ${ZIPF_K})))))`;
  const cc = `['US','DE','IN','BR','GB','FR','JP','CA','AU','NL'][(cityHash64(number,'cc') % 10)+1]`;
  const CHUNK = 5_000_000;
  for (let off = 0; off < NUM_EVENTS; off += CHUNK) {
    const n = Math.min(CHUNK, NUM_EVENTS - off);
    await chAdmin.command({ query: `
      INSERT INTO bench_pa.events (event_type, event_at, data, project_id, branch_id, user_id, team_id, refresh_token_id, session_replay_id, session_replay_segment_id, created_at) SELECT
        ['$token-refresh','$token-refresh','$token-refresh','$token-refresh','$token-refresh','$token-refresh','$token-refresh','$page-view','$page-view','$click'][((number+${off}) % 10)+1],
        now64(3,'UTC') - toIntervalSecond(cityHash64(number+${off},'t') % (90*86400)),
        CAST(concat('{"is_anonymous":', toString(toUInt8(cityHash64((number+${off}) % ${NUM_USERS},'a') % 10 = 0)), ',"ip_info":{"country_code":"', ${cc}, '"},"referrer":""}'), 'JSON'),
        ${projExpr(`(number+${off}) % ${NUM_USERS}`)}, '${BRANCH}', toString((number+${off}) % ${NUM_USERS}),
        NULL, NULL, NULL, NULL, now64(3,'UTC')
      FROM numbers(${n})` });
    log(`  events ${(off + n).toLocaleString()}/${NUM_EVENTS.toLocaleString()}`);
  }

  log("PG: (re)create bench_pa schema + auth/email tables WITH production composite indexes");
  const ex = (s: string) => globalPrismaClient.$executeRawUnsafe(s);
  await ex("DROP SCHEMA IF EXISTS bench_pa CASCADE");
  await ex("CREATE SCHEMA bench_pa");
  await ex(`CREATE UNLOGGED TABLE bench_pa."Tenancy"(id uuid PRIMARY KEY,"projectId" text,"branchId" text)`);
  await ex(`CREATE UNLOGGED TABLE bench_pa."AuthMethod"("tenancyId" uuid,id uuid, PRIMARY KEY("tenancyId",id))`);
  await ex(`CREATE UNLOGGED TABLE bench_pa."OAuthAuthMethod"("tenancyId" uuid,"authMethodId" uuid,"configOAuthProviderId" text, PRIMARY KEY("tenancyId","authMethodId"))`);
  await ex(`CREATE UNLOGGED TABLE bench_pa."PasswordAuthMethod"("tenancyId" uuid,"authMethodId" uuid, PRIMARY KEY("tenancyId","authMethodId"))`);
  await ex(`CREATE UNLOGGED TABLE bench_pa."PasskeyAuthMethod"("tenancyId" uuid,"authMethodId" uuid, PRIMARY KEY("tenancyId","authMethodId"))`);
  await ex(`CREATE UNLOGGED TABLE bench_pa."OtpAuthMethod"("tenancyId" uuid,"authMethodId" uuid, PRIMARY KEY("tenancyId","authMethodId"))`);
  await ex(`CREATE UNLOGGED TABLE bench_pa."EmailOutbox"("tenancyId" uuid,"finishedSendingAt" timestamptz,"deliveredAt" timestamptz,"bouncedAt" timestamptz,"simpleStatus" text,"createdAt" timestamptz)`);
  await ex(`INSERT INTO bench_pa."Tenancy" SELECT md5('ten'||g)::uuid,'bench-proj-'||g,'${BRANCH}' FROM generate_series(0,${NUM_PROJECTS - 1}) g`);
  const zipfTen = `md5('ten'|| floor(${NUM_PROJECTS}*power(random(),${ZIPF_K}))::int )::uuid`;
  await ex(`INSERT INTO bench_pa."AuthMethod" SELECT ${zipfTen}, md5('am'||g)::uuid FROM generate_series(0,${NUM_USERS - 1}) g`);
  const h = `(('x'||substr(md5(id::text),1,8))::bit(32)::int)`;
  await ex(`INSERT INTO bench_pa."OAuthAuthMethod" SELECT "tenancyId",id,(ARRAY['google','github','microsoft','gitlab'])[1+floor(random()*4)::int] FROM bench_pa."AuthMethod" WHERE ${h}%2=0`);
  await ex(`INSERT INTO bench_pa."PasswordAuthMethod" SELECT "tenancyId",id FROM bench_pa."AuthMethod" WHERE ${h}%10 IN (1,2,3)`);
  await ex(`INSERT INTO bench_pa."OtpAuthMethod" SELECT "tenancyId",id FROM bench_pa."AuthMethod" WHERE ${h}%10 IN (4,5)`);
  await ex(`INSERT INTO bench_pa."PasskeyAuthMethod" SELECT "tenancyId",id FROM bench_pa."AuthMethod" WHERE ${h}%20=7`);
  await ex(`INSERT INTO bench_pa."EmailOutbox" SELECT ${zipfTen},
      CASE WHEN random()<0.95 THEN now() END, CASE WHEN random()<0.88 THEN now() END, CASE WHEN random()<0.02 THEN now() END,
      (ARRAY['OK','OK','OK','OK','IN_PROGRESS','ERROR'])[1+floor(random()*6)::int], now()-(random()*90)*interval '1 day'
    FROM generate_series(1,1000000)`);
  await ex(`ANALYZE bench_pa."Tenancy",bench_pa."AuthMethod",bench_pa."OAuthAuthMethod",bench_pa."PasswordAuthMethod",bench_pa."PasskeyAuthMethod",bench_pa."OtpAuthMethod",bench_pa."EmailOutbox"`);
  log("seed done");
}

const T = "bench_pa";
const evScope = `project_id != {internalProjectId:String}`;
const P = {
  base: { branchId: BRANCH, internalProjectId: INTERNAL },
  win: { branchId: BRANCH, internalProjectId: INTERNAL, since: sinceParam, until: untilParam },
  two: { branchId: BRANCH, internalProjectId: INTERNAL, priorSince: priorSinceParam, mid: midParam, until: untilParam },
};
type Run = { ms: number, memMiB: number, readRows: number, canon: string };
const canonRows = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, String(r[k])]))).sort().join("|");

async function runCh(sql: string, params: Record<string, unknown>): Promise<Run> {
  let best: Run | null = null;
  for (let i = 0; i < 3; i++) {
    const qid = `opt-${randomUUID()}`;
    const rows = await (await chMetrics.query({ query: sql, query_params: params, query_id: qid, format: "JSONEachRow" })).json<Record<string, unknown>>();
    await chMetrics.command({ query: "SYSTEM FLUSH LOGS" });
    const s = (await (await chMetrics.query({ query: `SELECT query_duration_ms d, memory_usage m, read_rows r FROM system.query_log WHERE query_id={q:String} AND type='QueryFinish' ORDER BY event_time DESC LIMIT 1`, query_params: { q: qid }, format: "JSONEachRow" })).json<{ d: string, m: string, r: string }>())[0];
    const run: Run = { ms: Number(s.d), memMiB: Number(s.m) / 1048576, readRows: Number(s.r), canon: canonRows(rows) };
    if (!best || run.memMiB < best.memMiB) best = run;
  }
  return best!;
}

type PgRun = { ms: number, bufMiB: number, rows: number, canon: string };
async function runPg(sql: string, params: unknown[]): Promise<PgRun> {
  const result = await globalPrismaClient.$queryRawUnsafe<Array<Record<string, unknown>>>(sql, ...params);
  const canon = canonRows(result.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]))));
  let best: { ms: number, bufMiB: number, rows: number } | null = null;
  for (let i = 0; i < 3; i++) {
    const plan = (await globalPrismaClient.$queryRawUnsafe<Array<{ "QUERY PLAN": Array<{ Plan: Record<string, unknown>, "Execution Time": number }> }>>(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, ...params))[0]["QUERY PLAN"][0];
    const sumBuf = (node: Record<string, unknown>): number => {
      let s = Number(node["Shared Hit Blocks"] ?? 0) + Number(node["Shared Read Blocks"] ?? 0) + Number(node["Temp Written Blocks"] ?? 0) + Number(node["Temp Read Blocks"] ?? 0);
      for (const c of ((node.Plans as Array<Record<string, unknown>> | undefined) ?? [])) {
        s += sumBuf(c);
      }
      return s;
    };
    const run = { ms: Number(plan["Execution Time"]), bufMiB: sumBuf(plan.Plan) * 8192 / 1048576, rows: Number(plan.Plan["Actual Rows"] ?? 0) };
    if (!best || run.bufMiB < best.bufMiB) best = run;
  }
  return { ...best!, canon };
}

type ChCase = { query: string, variants: Array<{ name: string, sql: string, params: Record<string, unknown> }> };
const CH_CASES: ChCase[] = [
  { query: "dauSeries", variants: [
    { name: "original", params: P.win, sql: `SELECT toDate(event_at) AS day, uniqExact(assumeNotNull(user_id)) AS c FROM ${T}.events WHERE event_type='$token-refresh' AND user_id IS NOT NULL AND ${evScope} AND event_at>={since:DateTime} AND event_at<{until:DateTime} GROUP BY day ORDER BY day ASC` },
    { name: "uniqExact(sipHash64)", params: P.win, sql: `SELECT toDate(event_at) AS day, uniqExact(sipHash64(assumeNotNull(user_id))) AS c FROM ${T}.events WHERE event_type='$token-refresh' AND user_id IS NOT NULL AND ${evScope} AND event_at>={since:DateTime} AND event_at<{until:DateTime} GROUP BY day ORDER BY day ASC` },
  ] },
  { query: "sparkByProject", variants: [
    { name: "original", params: P.win, sql: `SELECT project_id AS projectId, toDate(event_at) AS day, uniqExact(assumeNotNull(user_id)) AS c FROM ${T}.events WHERE event_type='$token-refresh' AND user_id IS NOT NULL AND ${evScope} AND event_at>={since:DateTime} AND event_at<{until:DateTime} GROUP BY project_id, day` },
    { name: "uniqExact(sipHash64)", params: P.win, sql: `SELECT project_id AS projectId, toDate(event_at) AS day, uniqExact(sipHash64(assumeNotNull(user_id))) AS c FROM ${T}.events WHERE event_type='$token-refresh' AND user_id IS NOT NULL AND ${evScope} AND event_at>={since:DateTime} AND event_at<{until:DateTime} GROUP BY project_id, day` },
  ] },
  { query: "mauProjects", variants: [
    { name: "original", params: P.two, sql: `SELECT uniqExactIf(assumeNotNull(user_id),event_at>={mid:DateTime}) AS mauCur, uniqExactIf(assumeNotNull(user_id),event_at<{mid:DateTime}) AS mauPrev, uniqExactIf(project_id,event_at>={mid:DateTime}) AS projCur, uniqExactIf(project_id,event_at<{mid:DateTime}) AS projPrev FROM ${T}.events WHERE event_type='$token-refresh' AND user_id IS NOT NULL AND ${evScope} AND event_at>={priorSince:DateTime} AND event_at<{until:DateTime}` },
    { name: "uniqExactIf(sipHash64)", params: P.two, sql: `SELECT uniqExactIf(sipHash64(assumeNotNull(user_id)),event_at>={mid:DateTime}) AS mauCur, uniqExactIf(sipHash64(assumeNotNull(user_id)),event_at<{mid:DateTime}) AS mauPrev, uniqExactIf(project_id,event_at>={mid:DateTime}) AS projCur, uniqExactIf(project_id,event_at<{mid:DateTime}) AS projPrev FROM ${T}.events WHERE event_type='$token-refresh' AND user_id IS NOT NULL AND ${evScope} AND event_at>={priorSince:DateTime} AND event_at<{until:DateTime}` },
  ] },
  { query: "activeByProject", variants: [
    { name: "original", params: P.two, sql: `SELECT project_id AS projectId, uniqExactIf(assumeNotNull(user_id),event_at>={mid:DateTime}) AS cur, uniqExactIf(assumeNotNull(user_id),event_at<{mid:DateTime}) AS prev FROM ${T}.events WHERE event_type='$token-refresh' AND user_id IS NOT NULL AND ${evScope} AND event_at>={priorSince:DateTime} AND event_at<{until:DateTime} GROUP BY project_id` },
    { name: "uniqExactIf(sipHash64)", params: P.two, sql: `SELECT project_id AS projectId, uniqExactIf(sipHash64(assumeNotNull(user_id)),event_at>={mid:DateTime}) AS cur, uniqExactIf(sipHash64(assumeNotNull(user_id)),event_at<{mid:DateTime}) AS prev FROM ${T}.events WHERE event_type='$token-refresh' AND user_id IS NOT NULL AND ${evScope} AND event_at>={priorSince:DateTime} AND event_at<{until:DateTime} GROUP BY project_id` },
  ] },
  { query: "country", variants: [
    { name: "original", params: P.win, sql: `SELECT country_code, count() AS c FROM (SELECT user_id, argMax(cc,event_at) AS country_code FROM (SELECT user_id,event_at,CAST(data.ip_info.country_code,'Nullable(String)') AS cc FROM ${T}.events WHERE event_type='$token-refresh' AND user_id IS NOT NULL AND ${evScope} AND event_at>={since:DateTime} AND event_at<{until:DateTime}) WHERE cc IS NOT NULL GROUP BY user_id) WHERE country_code IS NOT NULL GROUP BY country_code ORDER BY c DESC` },
    { name: "GROUP BY sipHash64(user_id)", params: P.win, sql: `SELECT country_code, count() AS c FROM (SELECT argMax(cc,event_at) AS country_code FROM (SELECT sipHash64(assumeNotNull(user_id)) AS uid,event_at,CAST(data.ip_info.country_code,'Nullable(String)') AS cc FROM ${T}.events WHERE event_type='$token-refresh' AND user_id IS NOT NULL AND ${evScope} AND event_at>={since:DateTime} AND event_at<{until:DateTime}) WHERE cc IS NOT NULL GROUP BY uid) WHERE country_code IS NOT NULL GROUP BY country_code ORDER BY c DESC` },
  ] },
];

const am = (j: string) => `bench_pa."${j}"`;
type PgCase = { query: string, params: unknown[], variants: Array<{ name: string, sql: string }> };
const PG_CASES: PgCase[] = [
  { query: "authMethods", params: [], variants: [
    { name: "original (5 LEFT JOINs)", sql: `
      SELECT method, COUNT(*)::int AS count FROM (
        SELECT COALESCE(oaam."configOAuthProviderId"::text,
          CASE WHEN pam."authMethodId" IS NOT NULL THEN 'password' END,
          CASE WHEN pkm."authMethodId" IS NOT NULL THEN 'passkey' END,
          CASE WHEN oam."authMethodId" IS NOT NULL THEN 'otp' END, 'other') AS method
        FROM ${am("AuthMethod")} am JOIN ${am("Tenancy")} t ON t.id=am."tenancyId"
        LEFT JOIN ${am("OAuthAuthMethod")} oaam ON oaam."tenancyId"=am."tenancyId" AND oaam."authMethodId"=am.id
        LEFT JOIN ${am("PasswordAuthMethod")} pam ON pam."tenancyId"=am."tenancyId" AND pam."authMethodId"=am.id
        LEFT JOIN ${am("PasskeyAuthMethod")} pkm ON pkm."tenancyId"=am."tenancyId" AND pkm."authMethodId"=am.id
        LEFT JOIN ${am("OtpAuthMethod")} oam ON oam."tenancyId"=am."tenancyId" AND oam."authMethodId"=am.id
        WHERE t."projectId" <> '${INTERNAL}') sub GROUP BY method ORDER BY count DESC` },
    { name: "correlated subqueries (precedence preserved)", sql: `
      SELECT method, COUNT(*)::int AS count FROM (
        SELECT COALESCE(
          (SELECT oaam."configOAuthProviderId"::text FROM ${am("OAuthAuthMethod")} oaam WHERE oaam."tenancyId"=am."tenancyId" AND oaam."authMethodId"=am.id),
          CASE WHEN EXISTS(SELECT 1 FROM ${am("PasswordAuthMethod")} pam WHERE pam."tenancyId"=am."tenancyId" AND pam."authMethodId"=am.id) THEN 'password' END,
          CASE WHEN EXISTS(SELECT 1 FROM ${am("PasskeyAuthMethod")} pkm WHERE pkm."tenancyId"=am."tenancyId" AND pkm."authMethodId"=am.id) THEN 'passkey' END,
          CASE WHEN EXISTS(SELECT 1 FROM ${am("OtpAuthMethod")} oam WHERE oam."tenancyId"=am."tenancyId" AND oam."authMethodId"=am.id) THEN 'otp' END,
          'other') AS method
        FROM ${am("AuthMethod")} am JOIN ${am("Tenancy")} t ON t.id=am."tenancyId" WHERE t."projectId" <> '${INTERNAL}') sub GROUP BY method ORDER BY count DESC` },
  ] },
  { query: "email", params: [windowStart, priorStart], variants: [
    { name: "original (1M-row scan, 9 FILTERs)", sql: `
      SELECT COUNT(*) FILTER (WHERE eo."finishedSendingAt" IS NOT NULL)::int AS sent,
        COUNT(*) FILTER (WHERE eo."deliveredAt" IS NOT NULL)::int AS delivered,
        COUNT(*) FILTER (WHERE eo."bouncedAt" IS NOT NULL)::int AS bounced,
        COUNT(*) FILTER (WHERE eo."simpleStatus"::text='ERROR')::int AS error,
        COUNT(*) FILTER (WHERE eo."simpleStatus"::text='IN_PROGRESS')::int AS in_progress,
        COUNT(*) FILTER (WHERE eo."deliveredAt" IS NOT NULL AND eo."createdAt">=$1)::int AS "deliveredCur",
        COUNT(*) FILTER (WHERE eo."finishedSendingAt" IS NOT NULL AND eo."createdAt">=$1)::int AS "finishedCur",
        COUNT(*) FILTER (WHERE eo."deliveredAt" IS NOT NULL AND eo."createdAt">=$2 AND eo."createdAt"<$1)::int AS "deliveredPrev",
        COUNT(*) FILTER (WHERE eo."finishedSendingAt" IS NOT NULL AND eo."createdAt">=$2 AND eo."createdAt"<$1)::int AS "finishedPrev"
      FROM ${am("EmailOutbox")} eo JOIN ${am("Tenancy")} t ON t.id=eo."tenancyId" WHERE t."projectId" <> '${INTERNAL}'` },
    { name: "drop Tenancy join (EXISTS anti-filter)", sql: `
      SELECT COUNT(*) FILTER (WHERE eo."finishedSendingAt" IS NOT NULL)::int AS sent,
        COUNT(*) FILTER (WHERE eo."deliveredAt" IS NOT NULL)::int AS delivered,
        COUNT(*) FILTER (WHERE eo."bouncedAt" IS NOT NULL)::int AS bounced,
        COUNT(*) FILTER (WHERE eo."simpleStatus"::text='ERROR')::int AS error,
        COUNT(*) FILTER (WHERE eo."simpleStatus"::text='IN_PROGRESS')::int AS in_progress,
        COUNT(*) FILTER (WHERE eo."deliveredAt" IS NOT NULL AND eo."createdAt">=$1)::int AS "deliveredCur",
        COUNT(*) FILTER (WHERE eo."finishedSendingAt" IS NOT NULL AND eo."createdAt">=$1)::int AS "finishedCur",
        COUNT(*) FILTER (WHERE eo."deliveredAt" IS NOT NULL AND eo."createdAt">=$2 AND eo."createdAt"<$1)::int AS "deliveredPrev",
        COUNT(*) FILTER (WHERE eo."finishedSendingAt" IS NOT NULL AND eo."createdAt">=$2 AND eo."createdAt"<$1)::int AS "finishedPrev"
      FROM ${am("EmailOutbox")} eo WHERE EXISTS(SELECT 1 FROM ${am("Tenancy")} t WHERE t.id=eo."tenancyId" AND t."projectId" <> '${INTERNAL}')` },
  ] },
];

async function main() {
  if (!envBool("PA_SKIP_SEED")) {
    await seed();
  } else {
    log("reusing bench_pa");
  }
  const report: { ch: unknown[], pg: unknown[] } = { ch: [], pg: [] };

  log("=== ClickHouse ===");
  for (const c of CH_CASES) {
    const runs: Array<{ name: string, run: Run, ok: boolean }> = [];
    let baseCanon = "";
    for (const v of c.variants) {
      const run = await runCh(v.sql, v.params);
      if (v.name === "original") baseCanon = run.canon;
      const ok = run.canon === baseCanon;
      runs.push({ name: v.name, run, ok });
      log(`  ${c.query} / ${v.name}: ${run.memMiB.toFixed(0)}MiB ${run.ms}ms read=${run.readRows.toLocaleString()} ${ok ? "EQ" : "DIFF"}`);
    }
    const orig = runs[0].run;
    const best = runs.filter((r) => r.ok).reduce((a, b) => b.run.memMiB < a.run.memMiB ? b : a);
    report.ch.push({ query: c.query, origMemMiB: orig.memMiB, origMs: orig.ms, variants: runs.map((r) => ({ name: r.name, memMiB: r.run.memMiB, ms: r.run.ms, readRows: r.run.readRows, equal: r.ok })), best: best.name, bestMemMiB: best.run.memMiB, memReductionPct: (1 - best.run.memMiB / orig.memMiB) * 100 });
  }

  log("=== Postgres ===");
  for (const c of PG_CASES) {
    const runs: Array<{ name: string, run: PgRun, ok: boolean }> = [];
    let baseCanon = "";
    for (const v of c.variants) {
      const run = await runPg(v.sql, c.params);
      if (v.name.startsWith("original")) baseCanon = run.canon;
      const ok = run.canon === baseCanon;
      runs.push({ name: v.name, run, ok });
      log(`  ${c.query} / ${v.name}: ${run.bufMiB.toFixed(0)}MiB buf ${run.ms.toFixed(0)}ms ${ok ? "EQ" : "DIFF"}`);
    }
    const orig = runs[0].run;
    const best = runs.filter((r) => r.ok).reduce((a, b) => b.run.bufMiB < a.run.bufMiB ? b : a);
    report.pg.push({ query: c.query, origBufMiB: orig.bufMiB, origMs: orig.ms, variants: runs.map((r) => ({ name: r.name, bufMiB: r.run.bufMiB, ms: r.run.ms, equal: r.ok })), best: best.name, bestBufMiB: best.run.bufMiB, bufReductionPct: (1 - best.run.bufMiB / orig.bufMiB) * 100 });
  }

  writeFileSync("/tmp/platform-analytics-optimize.json", JSON.stringify({ generatedAt: new Date().toISOString(), scale: { NUM_PROJECTS, NUM_USERS, NUM_EVENTS }, ...report }, null, 2));
  log("wrote /tmp/platform-analytics-optimize.json");
  if (!envBool("PA_KEEP")) {
    await chAdmin.command({ query: "DROP DATABASE IF EXISTS bench_pa" });
    await globalPrismaClient.$executeRawUnsafe("DROP SCHEMA IF EXISTS bench_pa CASCADE");
  }
  process.exit(0);
}

try {
  await main();
} catch (e) {
  console.error("FAILED:", e);
  process.exit(1);
}
