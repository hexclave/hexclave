/**
 * Result-equivalence tests for the platform-analytics ClickHouse queries.
 *
 * The queries in clickhouse-queries.ts reconstruct ReplacingMergeTree semantics
 * by hand (GROUP BY dedup key + argMax(..., sync_sequence_id) instead of FINAL)
 * and count distinct users in two stages instead of uniqExact. This test seeds a
 * scratch database with the edge cases those rewrites must get right — several
 * versions of one row, deletion tombstones written into a different month
 * partition than the live row, a row that was deleted and then re-created,
 * duplicate events per user/day, users straddling the current/prior window —
 * and checks every query against hand-computed expectations. Runs against the
 * local ClickHouse from docker/dependencies (needs `analytics_internal` to be
 * migrated, which `pnpm db:init` does).
 */
import { getClickhouseAdminClient, getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTIVITY_SPLIT_SAMPLE, buildPlatformAnalyticsClickhouseQueries, runPlatformAnalyticsClickhouseQueries, type PlatformAnalyticsClickhouseResults } from "./clickhouse-queries";

const DB = `test_platform_analytics_${randomUUID().replaceAll("-", "")}`;
const BRANCH = "main";
const INTERNAL = "internal";
const P1 = "proj-1";
const P2 = "proj-2";

const ONE_DAY_MS = 86_400_000;
const today = new Date();
today.setUTCHours(0, 0, 0, 0);
// Noon so day boundaries are unambiguous however the timezone is rendered.
const daysAgo = (n: number) => new Date(today.getTime() - n * ONE_DAY_MS + 12 * 3_600_000);
const dayStr = (n: number) => daysAgo(n).toISOString().slice(0, 10);
const chDT64 = (d: Date) => d.toISOString().slice(0, 23).replace("T", " ");
const chDT = (d: Date) => new Date(d.getTime() - 12 * 3_600_000).toISOString().slice(0, 19);

// Same window shape as the route: visible window = last 30 days (since == mid),
// prior window = the 30 days before that.
const WINDOW_DAYS = 30;
const window = {
  branchId: BRANCH,
  internalProjectId: INTERNAL,
  since: chDT(daysAgo(WINDOW_DAYS - 1)),
  mid: chDT(daysAgo(WINDOW_DAYS - 1)),
  priorSince: chDT(daysAgo(2 * WINDOW_DAYS - 1)),
  until: chDT(daysAgo(-1)),
};

const chAdmin = getClickhouseAdminClient();
const chMetrics = getClickhouseAdminClientForMetrics();

const SYNCED_TABLES = ["users", "contact_channels", "teams", "connected_accounts", "email_outboxes"] as const;
const ALL_TABLES = ["events", ...SYNCED_TABLES, "clickmap_events"] as const;

async function insert(table: typeof ALL_TABLES[number], rows: Record<string, unknown>[]) {
  // One insert per row => one part per row, like a trickle of sync batches; merges
  // are stopped so FINAL/argMax really have to reconcile versions across parts.
  for (const row of rows) {
    await chAdmin.insert({ table: `${DB}.${table}`, values: [row], format: "JSONEachRow" });
  }
}

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;

type UserRow = { project_id: string, branch_id?: string, id: string, signed_up_at: Date, is_anonymous: 0 | 1, sync_sequence_id: number, sync_is_deleted?: 0 | 1 };
const userRow = (u: UserRow) => ({
  project_id: u.project_id,
  branch_id: u.branch_id ?? BRANCH,
  id: u.id,
  display_name: null,
  profile_image_url: null,
  primary_email: null,
  primary_email_verified: 0,
  signed_up_at: chDT64(u.signed_up_at),
  client_metadata: "{}",
  client_read_only_metadata: "{}",
  server_metadata: "{}",
  is_anonymous: u.is_anonymous,
  restricted_by_admin: 0,
  restricted_by_admin_reason: null,
  restricted_by_admin_private_details: null,
  sync_sequence_id: u.sync_sequence_id,
  sync_is_deleted: u.sync_is_deleted ?? 0,
});

type ChannelRow = { project_id: string, id: string, user_id: string, type?: string, is_verified: 0 | 1, created_at: Date, sync_sequence_id: number, sync_is_deleted?: 0 | 1 };
const channelRow = (c: ChannelRow) => ({
  project_id: c.project_id,
  branch_id: BRANCH,
  id: c.id,
  user_id: c.user_id,
  type: c.type ?? "EMAIL",
  value: `${c.id}@example.com`,
  is_primary: 1,
  is_verified: c.is_verified,
  used_for_auth: 1,
  created_at: chDT64(c.created_at),
  sync_sequence_id: c.sync_sequence_id,
  sync_is_deleted: c.sync_is_deleted ?? 0,
});

type EventRow = { project_id: string, branch_id?: string, event_type?: string, event_at: Date, user_id: string | null, data?: Record<string, unknown> };
const eventRow = (e: EventRow) => ({
  event_type: e.event_type ?? "$token-refresh",
  event_at: chDT64(e.event_at),
  data: e.data ?? {},
  project_id: e.project_id,
  branch_id: e.branch_id ?? BRANCH,
  user_id: e.user_id,
  team_id: null,
  refresh_token_id: null,
  session_replay_id: null,
  session_replay_segment_id: null,
});

// The activity split samples 1-in-ACTIVITY_SPLIT_SAMPLE users by cityHash64(user_id).
// Pick user ids on both sides of that filter from ClickHouse itself so the test does
// not hard-code hash values.
async function pickUserIds(): Promise<{ sampled: string[], unsampled: string[] }> {
  const result = await chAdmin.query({
    query: `
      SELECT concat('user-', toString(number)) AS id,
        cityHash64(concat('user-', toString(number))) % {n:UInt8} = 0 AS sampled
      FROM numbers(200)
    `,
    query_params: { n: ACTIVITY_SPLIT_SAMPLE },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ id: string, sampled: 0 | 1 }>();
  return {
    sampled: rows.filter((r) => r.sampled === 1).map((r) => r.id),
    unsampled: rows.filter((r) => r.sampled === 0).map((r) => r.id),
  };
}

const num = (v: string | number) => Number(v);
const byKey = <T extends { projectId: string }>(rows: T[]) => [...rows].sort((a, b) => stringCompare(a.projectId, b.projectId));

let results: PlatformAnalyticsClickhouseResults;
let ids: { sampled: string[], unsampled: string[] };

beforeAll(async () => {
  ids = await pickUserIds();
  // Unsampled ids keep the activity split independent of the other event fixtures.
  const [a, b, c, d, e, f, x, y, z] = ids.unsampled;
  const [s1, s2, s3] = ids.sampled;
  if (ids.unsampled.length < 9 || ids.sampled.length < 3) throwErr("numbers(200) should yield enough ids on both sides of the sampling filter", ids);

  await chAdmin.command({ query: `CREATE DATABASE ${DB}` });
  for (const t of ALL_TABLES) {
    await chAdmin.command({ query: `CREATE TABLE ${DB}.${t} AS analytics_internal.${t}` });
  }
  for (const t of SYNCED_TABLES) {
    await chAdmin.command({ query: `SYSTEM STOP MERGES ${DB}.${t}` });
  }

  await insert("users", [
    // u1: anonymous at first, later claimed => counts as a regular (old) user.
    userRow({ project_id: P1, id: uuid(1), signed_up_at: daysAgo(100), is_anonymous: 1, sync_sequence_id: 1 }),
    userRow({ project_id: P1, id: uuid(1), signed_up_at: daysAgo(100), is_anonymous: 0, sync_sequence_id: 2 }),
    // u2: live row in one month partition, deletion tombstone in a different one.
    userRow({ project_id: P1, id: uuid(2), signed_up_at: daysAgo(400), is_anonymous: 0, sync_sequence_id: 3 }),
    userRow({ project_id: P1, id: uuid(2), signed_up_at: daysAgo(200), is_anonymous: 0, sync_sequence_id: 4, sync_is_deleted: 1 }),
    // u3: signed up inside the visible window.
    userRow({ project_id: P1, id: uuid(3), signed_up_at: daysAgo(5), is_anonymous: 0, sync_sequence_id: 5 }),
    // u4: anonymous, inside the window.
    userRow({ project_id: P1, id: uuid(4), signed_up_at: daysAgo(3), is_anonymous: 1, sync_sequence_id: 6 }),
    // u5 (P2): signed up in the prior window.
    userRow({ project_id: P2, id: uuid(5), signed_up_at: daysAgo(40), is_anonymous: 0, sync_sequence_id: 7 }),
    // Excluded: internal project, other branch.
    userRow({ project_id: INTERNAL, id: uuid(6), signed_up_at: daysAgo(5), is_anonymous: 0, sync_sequence_id: 8 }),
    userRow({ project_id: P2, branch_id: "other", id: uuid(7), signed_up_at: daysAgo(5), is_anonymous: 0, sync_sequence_id: 9 }),
    // u8: deleted, then re-created with a newer version => live.
    userRow({ project_id: P1, id: uuid(8), signed_up_at: daysAgo(100), is_anonymous: 0, sync_sequence_id: 10, sync_is_deleted: 1 }),
    userRow({ project_id: P1, id: uuid(8), signed_up_at: daysAgo(100), is_anonymous: 0, sync_sequence_id: 11 }),
  ]);

  await insert("contact_channels", [
    // u1: verified.
    channelRow({ project_id: P1, id: uuid(101), user_id: uuid(1), is_verified: 1, created_at: daysAgo(100), sync_sequence_id: 1 }),
    // u3: was verified, latest version says unverified.
    channelRow({ project_id: P1, id: uuid(102), user_id: uuid(3), is_verified: 1, created_at: daysAgo(5), sync_sequence_id: 2 }),
    channelRow({ project_id: P1, id: uuid(102), user_id: uuid(3), is_verified: 0, created_at: daysAgo(5), sync_sequence_id: 3 }),
    // u5: verified channel, deleted later (tombstone in another partition).
    channelRow({ project_id: P2, id: uuid(103), user_id: uuid(5), is_verified: 1, created_at: daysAgo(40), sync_sequence_id: 4 }),
    channelRow({ project_id: P2, id: uuid(103), user_id: uuid(5), is_verified: 1, created_at: daysAgo(400), sync_sequence_id: 5, sync_is_deleted: 1 }),
    // u5: verified but not an EMAIL channel.
    channelRow({ project_id: P2, id: uuid(104), user_id: uuid(5), type: "PHONE", is_verified: 1, created_at: daysAgo(40), sync_sequence_id: 6 }),
    // u8: verified.
    channelRow({ project_id: P1, id: uuid(105), user_id: uuid(8), is_verified: 1, created_at: daysAgo(100), sync_sequence_id: 7 }),
    // Verified channel of a deleted user (u2) must not resurrect the user.
    channelRow({ project_id: P1, id: uuid(106), user_id: uuid(2), is_verified: 1, created_at: daysAgo(400), sync_sequence_id: 8 }),
  ]);

  const cc = (code: string) => ({ ip_info: { country_code: code } });
  await insert("events", [
    // a (P1): two refreshes on the same day must count once; country moves US -> DE.
    eventRow({ project_id: P1, event_at: daysAgo(2), user_id: a, data: cc("US") }),
    eventRow({ project_id: P1, event_at: daysAgo(1), user_id: a, data: cc("DE") }),
    eventRow({ project_id: P1, event_at: new Date(daysAgo(1).getTime() + 60_000), user_id: a, data: cc("DE") }),
    // b (P1): active in both the current and the prior window, no country.
    eventRow({ project_id: P1, event_at: daysAgo(1), user_id: b }),
    eventRow({ project_id: P1, event_at: daysAgo(45), user_id: b }),
    // c (P2): two consecutive days; first ever event long before the window.
    eventRow({ project_id: P2, event_at: daysAgo(100), user_id: c, data: cc("FR") }),
    eventRow({ project_id: P2, event_at: daysAgo(10), user_id: c, data: cc("FR") }),
    eventRow({ project_id: P2, event_at: daysAgo(9), user_id: c, data: cc("FR") }),
    // d (P2): prior window only.
    eventRow({ project_id: P2, event_at: daysAgo(40), user_id: d }),
    // Excluded: internal project, NULL user, outside both windows.
    eventRow({ project_id: INTERNAL, event_at: daysAgo(1), user_id: e, data: cc("JP") }),
    eventRow({ project_id: P1, event_at: daysAgo(1), user_id: null }),
    eventRow({ project_id: P1, event_at: daysAgo(70), user_id: f }),
    // Page views / clicks.
    eventRow({ project_id: P1, event_type: "$page-view", event_at: daysAgo(3), user_id: x }),
    eventRow({ project_id: P1, event_type: "$page-view", event_at: daysAgo(3), user_id: x }),
    eventRow({ project_id: P1, event_type: "$click", event_at: daysAgo(3), user_id: y }),
    eventRow({ project_id: P1, event_type: "$click", event_at: daysAgo(2), user_id: z }),
    eventRow({ project_id: P2, event_type: "$page-view", event_at: daysAgo(2), user_id: z }),
    eventRow({ project_id: INTERNAL, event_type: "$page-view", event_at: daysAgo(2), user_id: z }),
    // Activity split (sampled users only): s1 reactivated then retained, s2 new,
    // s3 anonymous => ignored.
    eventRow({ project_id: P1, event_at: daysAgo(100), user_id: s1 }),
    eventRow({ project_id: P1, event_at: daysAgo(8), user_id: s1 }),
    eventRow({ project_id: P1, event_at: daysAgo(7), user_id: s1 }),
    eventRow({ project_id: P2, event_at: daysAgo(8), user_id: s2 }),
    eventRow({ project_id: P2, event_at: daysAgo(8), user_id: s3, data: { is_anonymous: true } }),
  ]);

  const syncedRow = (project_id: string, key: Record<string, unknown>, seq: number, deleted: 0 | 1, created_at: Date) => ({
    project_id, branch_id: BRANCH, ...key, created_at: chDT64(created_at), sync_sequence_id: seq, sync_is_deleted: deleted,
  });
  await insert("teams", [
    { ...syncedRow(P1, { id: uuid(201) }, 1, 0, daysAgo(400)), display_name: "t", profile_image_url: null, client_metadata: "{}", client_read_only_metadata: "{}", server_metadata: "{}" },
    // Deleted across partitions => P1 has no live team.
    { ...syncedRow(P1, { id: uuid(201) }, 2, 1, daysAgo(200)), display_name: "t", profile_image_url: null, client_metadata: "{}", client_read_only_metadata: "{}", server_metadata: "{}" },
    { ...syncedRow(P2, { id: uuid(202) }, 3, 0, daysAgo(10)), display_name: "t", profile_image_url: null, client_metadata: "{}", client_read_only_metadata: "{}", server_metadata: "{}" },
    { ...syncedRow(P2, { id: uuid(202) }, 4, 0, daysAgo(10)), display_name: "t2", profile_image_url: null, client_metadata: "{}", client_read_only_metadata: "{}", server_metadata: "{}" },
  ]);
  await insert("connected_accounts", [
    // Two providers for the same user are two live rows.
    syncedRow(P1, { user_id: uuid(1), provider: "github", provider_account_id: "gh-1" }, 1, 0, daysAgo(100)),
    syncedRow(P1, { user_id: uuid(1), provider: "google", provider_account_id: "g-1" }, 2, 0, daysAgo(100)),
    syncedRow(P2, { user_id: uuid(5), provider: "github", provider_account_id: "gh-5" }, 3, 0, daysAgo(400)),
    syncedRow(P2, { user_id: uuid(5), provider: "github", provider_account_id: "gh-5" }, 4, 1, daysAgo(40)),
  ]);
  const outbox = (project_id: string, id: string, seq: number, deleted: 0 | 1, created_at: Date) => ({
    ...syncedRow(project_id, { id }, seq, deleted, created_at),
    status: "SENT", simple_status: "SENT", created_with: "API", email_draft_id: null, email_programmatic_call_template_id: null, theme_id: null,
    is_high_priority: 0, is_transactional: null, subject: null, notification_category_id: null, started_rendering_at: null, rendered_at: null,
    render_error: null, scheduled_at: chDT64(created_at), updated_at: chDT64(created_at), started_sending_at: null, server_error: null,
    delivered_at: null, opened_at: null, clicked_at: null, unsubscribed_at: null, marked_as_spam_at: null, bounced_at: null, delivery_delayed_at: null,
    can_have_delivery_info: null, skipped_reason: null, skipped_details: null, send_retries: 0, is_paused: 0,
  });
  await insert("email_outboxes", [
    outbox(P1, uuid(301), 1, 0, daysAgo(5)),
    outbox(INTERNAL, uuid(302), 2, 0, daysAgo(5)),
  ]);
  const click = (project_id: string, event_at: Date, is_dead: 0 | 1) => ({
    project_id, branch_id: BRANCH, event_at: chDT64(event_at), user_id: null, session_replay_id: null, url: "https://x", path: "/",
    viewport_width: 1000, viewport_height: 800, pointer_x: 1, pointer_y: 1, client_y: 1, pointer_relative_x: 0.5, pointer_target_fixed: 0,
    elements_chain: "", selector: "", elements_text: "", tag_name: "a", href: null, is_dead,
  });
  await insert("clickmap_events", [
    click(P1, daysAgo(1), 0),
    click(P1, daysAgo(1), 1),
    click(P2, daysAgo(40), 1),
    click(INTERNAL, daysAgo(1), 1),
  ]);

  results = await runPlatformAnalyticsClickhouseQueries(chMetrics, buildPlatformAnalyticsClickhouseQueries(DB, window));
});

afterAll(async () => {
  await chAdmin.command({ query: `DROP DATABASE IF EXISTS ${DB}` });
  await chAdmin.close();
  await chMetrics.close();
});

describe("platform analytics ClickHouse queries", () => {
  it("counts users per project from the latest row version, honoring cross-partition tombstones", () => {
    expect(byKey(results.usersByProject).map((r) => ({ ...r, total: num(r.total), totalPrev: num(r.totalPrev), verified: num(r.verified), verifiedPrev: num(r.verifiedPrev), anonymous: num(r.anonymous) }))).toEqual([
      // u1, u3, u8 live and non-anonymous; u1 + u8 verified and signed up before the window; u4 anonymous; u2 deleted.
      { projectId: P1, total: 3, totalPrev: 2, verified: 2, verifiedPrev: 2, anonymous: 1 },
      // u5's only EMAIL channel was deleted.
      { projectId: P2, total: 1, totalPrev: 1, verified: 0, verifiedPrev: 0, anonymous: 0 },
    ]);
  });

  it("counts signups by day and by project", () => {
    expect(results.signupSeries.map((r) => ({ day: r.day, c: num(r.c) }))).toEqual([{ day: dayStr(5), c: 1 }]);
    expect(byKey(results.signupsByProject).map((r) => ({ ...r, cur: num(r.cur), prev: num(r.prev) }))).toEqual([
      { projectId: P1, cur: 1, prev: 0 },
      { projectId: P2, cur: 0, prev: 1 },
    ]);
  });

  it("counts each active user once per day", () => {
    expect(results.dauSeries.map((r) => ({ day: r.day, c: num(r.c) }))).toEqual([
      { day: dayStr(10), c: 1 },
      { day: dayStr(9), c: 1 },
      { day: dayStr(8), c: 3 },
      { day: dayStr(7), c: 1 },
      { day: dayStr(2), c: 1 },
      { day: dayStr(1), c: 2 },
    ]);
    expect(results.sparkByProject.map((r) => ({ ...r, c: num(r.c) })).sort((l, r) => stringCompare(`${l.projectId}${l.day}`, `${r.projectId}${r.day}`))).toEqual([
      { projectId: P1, day: dayStr(8), c: 1 },
      { projectId: P1, day: dayStr(7), c: 1 },
      { projectId: P1, day: dayStr(2), c: 1 },
      { projectId: P1, day: dayStr(1), c: 2 },
      { projectId: P2, day: dayStr(10), c: 1 },
      { projectId: P2, day: dayStr(9), c: 1 },
      { projectId: P2, day: dayStr(8), c: 2 },
    ]);
  });

  it("counts monthly active users and projects for the current and prior window", () => {
    const [row] = results.mauProjects;
    // Current: a, b, c, s1, s2, s3; prior: b, d.
    expect({ mauCur: num(row.mauCur), mauPrev: num(row.mauPrev), projCur: num(row.projCur), projPrev: num(row.projPrev) })
      .toEqual({ mauCur: 6, mauPrev: 2, projCur: 2, projPrev: 2 });
    expect(byKey(results.activeByProject).map((r) => ({ ...r, cur: num(r.cur), prev: num(r.prev) }))).toEqual([
      { projectId: P1, cur: 3, prev: 1 },
      { projectId: P2, cur: 3, prev: 1 },
    ]);
  });

  it("counts page views and visitors per day", () => {
    expect(results.pvSeries.map((r) => ({ day: r.day, pv: num(r.pv), visitors: num(r.visitors) }))).toEqual([
      { day: dayStr(3), pv: 2, visitors: 1 },
      { day: dayStr(2), pv: 1, visitors: 1 },
    ]);
    expect(byKey(results.analyticsByProject).map((r) => ({ ...r, c: num(r.c) }))).toEqual([
      { projectId: P1, c: 2 },
      { projectId: P2, c: 1 },
    ]);
  });

  it("attributes each user to their latest country", () => {
    expect([...results.country].map((r) => ({ country_code: r.country_code, c: num(r.c) })).sort((l, r) => stringCompare(l.country_code, r.country_code))).toEqual([
      { country_code: "DE", c: 1 },
      { country_code: "FR", c: 1 },
    ]);
  });

  it("splits sampled activity into new / retained / reactivated", () => {
    const n = ACTIVITY_SPLIT_SAMPLE;
    expect(results.split.map((r) => ({ day: r.day, total: num(r.total_count), new_: num(r.new_count), retained: num(r.retained_count), reactivated: num(r.reactivated_count) }))).toEqual([
      // s1 (first seen 100 days ago) comes back, s2 is new.
      { day: dayStr(8), total: 2 * n, new_: n, retained: 0, reactivated: n },
      // s1 active again the next day.
      { day: dayStr(7), total: n, new_: 0, retained: n, reactivated: 0 },
    ]);
  });

  it("counts live rows of the synced feature tables per project", () => {
    expect(byKey(results.teamsByProject).map((r) => ({ ...r, c: num(r.c) }))).toEqual([
      { projectId: P1, c: 0 },
      { projectId: P2, c: 1 },
    ]);
    expect(byKey(results.oauthByProject).map((r) => ({ ...r, c: num(r.c) }))).toEqual([
      { projectId: P1, c: 2 },
      { projectId: P2, c: 0 },
    ]);
    expect(byKey(results.emailsByProject).map((r) => ({ ...r, c: num(r.c) }))).toEqual([
      { projectId: P1, c: 1 },
    ]);
  });

  it("counts dead clicks over the visible window", () => {
    const [row] = results.deadClicks;
    expect({ clicks: num(row.clicks), dead: num(row.dead) }).toEqual({ clicks: 2, dead: 1 });
  });
});
