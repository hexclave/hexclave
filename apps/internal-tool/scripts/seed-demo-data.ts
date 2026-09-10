/**
 * Fills a local internal-tool instance with demo data: `pnpm seed:demo`.
 *
 * Why this exists: every table behind this app is populated by real MCP
 * traffic, so a fresh development environment renders empty grids and empty
 * charts. That makes the UI impossible to work on without either pointing at
 * production or manually driving the MCP server. This writes a representative
 * corpus instead (see demo-dataset.ts for the content).
 *
 * How it talks to SpacetimeDB: it signs a member token with the same
 * dev signing seed the app itself mints with, then calls the same public
 * reducers the backend ingest routes call. It deliberately does NOT go through
 * `/api/backend/*` — those routes require a backend assertion signed by the
 * Stack Auth project keys, which would make seeding depend on a running
 * backend, and they cover only ingest (no QA review, human review, or
 * knowledge-base curation).
 *
 * Two properties worth knowing before you read the output:
 *
 *  - Row timestamps are always "now". `createdAt` is stamped server-side from
 *    `ctx.timestamp` inside each reducer and there is no argument to override
 *    it, so a seeded corpus lands in a single day. Per-row detail, the grids,
 *    the score/flag distributions, and the filters are all faithful; the
 *    14-day "calls over time" chart in Analytics will show one tall bar.
 *  - Rows seeded without a QA review read as `pending` for two minutes and as
 *    `review-failed` after that. That is the module's own definition (see
 *    QA_REVIEW_FAILED_THRESHOLD_MICROS in spacetimedb/src/log-filters.ts):
 *    an unreviewed row that has been waiting longer than the threshold is
 *    treated as a review that never came back. Both states are worth seeing,
 *    so this is left alone rather than worked around.
 *
 * Re-running is safe: everything written here carries a `demo-seed-` prefix,
 * and the script deletes its own previous rows before inserting. It never
 * touches rows it did not create. Pass `--clear` to delete without reseeding.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as jose from "jose";
import { derivePrivateJwkFromSeed, SPACETIMEDB_SIGNING_KEY_DERIVATION_PURPOSE } from "../src/lib/derive-private-jwk-from-seed";
import { SPACETIMEDB_TOKEN_AUDIENCE, spacetimeDbName } from "../src/lib/spacetimedb-constants";
import { spacetimedbHttpBase } from "../src/lib/spacetimedb-http";
import {
  DEMO_AI_QUERIES,
  DEMO_FEEDBACK,
  DEMO_MANUAL_QA,
  DEMO_MCP_CALLS,
  type DemoToolCall,
} from "./demo-dataset";

/** Everything this script writes is prefixed with this, and only rows carrying it are ever deleted. */
const DEMO_PREFIX = "demo-seed-";
const SEED_ACTOR_NAME = "Demo Seed Script";
const TOKEN_TTL = "10m";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Minimal dotenv, in Next's precedence order. We cannot reuse Next's own loader
 * (`@next/env`) because it is not a direct dependency of this package, and
 * Node's `--env-file` does not expand `${VAR:-default}`, which .env.development
 * relies on for the port prefix.
 */
function loadEnvFiles(): void {
  // Lowest precedence first; earlier files never overwrite later ones.
  const files = [".env", ".env.development", ".env.local"];
  const loaded = new Map<string, string>();
  for (const file of files) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (match == null) continue;
      const [, key, rawValue] = match;
      // Strip trailing `# comment`, which .env in this package uses inline.
      loaded.set(key, rawValue.replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, ""));
    }
  }
  const expand = (value: string): string => value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_full, name: string, fallback: string | undefined) => process.env[name] ?? loaded.get(name) ?? fallback ?? "",
  );
  for (const [key, value] of loaded) {
    // Real environment variables win over .env files, same as Next.
    process.env[key] ??= expand(value);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value == null || value === "" || value === "REPLACE_ME") {
    throw new Error(
      `${name} is not set. Run this from apps/internal-tool with the dev environment configured — `
      + `\`pnpm dev\` generates the SpacetimeDB signing seed into .env.local on first run.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// SpacetimeDB transport
// ---------------------------------------------------------------------------

/**
 * Signs the same shape of token the tool's `/api/spacetimedb-token` route
 * mints for a signed-in reviewer. The `name` claim is what the module credits
 * human actions to, so seeded reviews and knowledge-base entries are visibly
 * attributed to the script rather than to a real teammate.
 */
async function signSeedToken(): Promise<string> {
  const jwk = derivePrivateJwkFromSeed(
    SPACETIMEDB_SIGNING_KEY_DERIVATION_PURPOSE,
    requiredEnv("HEXCLAVE_SPACETIMEDB_SIGNING_SEED"),
  );
  const key = await jose.importJWK(jwk, "ES256");
  return await new jose.SignJWT({ name: SEED_ACTOR_NAME })
    .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
    .setIssuer(requiredEnv("HEXCLAVE_INTERNAL_TOOL_BASE_URL").replace(/\/+$/, ""))
    .setAudience(SPACETIMEDB_TOKEN_AUDIENCE)
    .setSubject(`${DEMO_PREFIX}script`)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(key);
}

function opt<T>(value: T | null | undefined): { some: T } | { none: [] } {
  return value == null ? { none: [] } : { some: value };
}

type Transport = {
  callReducer: (reducer: string, args: unknown[]) => Promise<void>,
  sql: (query: string) => Promise<Array<Record<string, unknown>>>,
};

function createTransport(token: string): Transport {
  const base = spacetimedbHttpBase();
  const db = encodeURIComponent(spacetimeDbName());

  return {
    async callReducer(reducer, args) {
      const res = await fetch(`${base}/v1/database/${db}/call/${encodeURIComponent(reducer)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify(args, (_key, value) => (typeof value === "bigint" ? Number(value) : value)),
      });
      if (!res.ok) {
        throw new Error(`Reducer ${reducer} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
    },
    async sql(query) {
      const res = await fetch(`${base}/v1/database/${db}/sql`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", "Authorization": `Bearer ${token}` },
        body: query,
      });
      if (!res.ok) {
        throw new Error(`SQL ${JSON.stringify(query)} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      const payload = await res.json() as Array<{
        schema: { elements: Array<{ name: { some: string } | { none: null } }> },
        rows: unknown[][],
      }>;
      if (payload.length === 0) return [];
      const [first] = payload;
      const columns = first.schema.elements.map(el => ("some" in el.name ? el.name.some : ""));
      return first.rows.map((tuple) => {
        const row: Record<string, unknown> = {};
        columns.forEach((column, i) => {
          row[column] = tuple[i];
        });
        return row;
      });
    },
  };
}

/** SpacetimeDB's /sql returns snake_case columns; the reducer API speaks camelCase. */
function column(row: Record<string, unknown>, snake: string, camel: string): unknown {
  return row[snake] ?? row[camel];
}

/**
 * Optional columns come back from /sql as a tagged sum — `[0, value]` for some
 * and `[1, []]` for none — with object and bare encodings seen across versions.
 */
function decodeOptional<T>(value: unknown): T | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value[0] === 0 ? value[1] as T : undefined;
  if (typeof value === "object") {
    if ("some" in value) return (value as { some: T }).some;
    return undefined;
  }
  return value as T;
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  throw new Error(`Expected a u64 id from SpacetimeDB, received ${typeof value}: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Clearing previously seeded rows
// ---------------------------------------------------------------------------

async function clearPreviousSeed(transport: Transport): Promise<number> {
  let deleted = 0;

  // QA entries first: an entry curated from a call holds a foreign reference to
  // the call's correlation id, so removing it before the call keeps the
  // knowledge base from briefly pointing at a row that no longer exists.
  const qaRows = await transport.sql("SELECT * FROM my_visible_qa_entries");
  for (const row of qaRows) {
    const source = decodeOptional<string>(column(row, "source_mcp_correlation_id", "sourceMcpCorrelationId"));
    const requestId = decodeOptional<string>(column(row, "request_id", "requestId"));
    const isDemo = (source?.startsWith(DEMO_PREFIX) ?? false) || (requestId?.startsWith(DEMO_PREFIX) ?? false);
    if (!isDemo) continue;
    await transport.callReducer("delete_qa_entry", [toBigInt(row.id)]);
    deleted++;
  }

  const tables = [
    { view: "my_visible_mcp_call_log", reducer: "delete_mcp_call_log" },
    { view: "my_visible_ai_query_log", reducer: "delete_ai_query_log" },
    { view: "my_visible_feedback_log", reducer: "delete_feedback" },
  ];
  for (const { view, reducer } of tables) {
    const rows = await transport.sql(`SELECT * FROM ${view}`);
    for (const row of rows) {
      const correlationId = column(row, "correlation_id", "correlationId");
      if (typeof correlationId !== "string" || !correlationId.startsWith(DEMO_PREFIX)) continue;
      await transport.callReducer(reducer, [correlationId]);
      deleted++;
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

function serializeInnerToolCalls(calls: DemoToolCall[]): string {
  // Mirrors buildInnerToolCalls in apps/backend/src/lib/ai/loggers/mcp-call-logger.ts.
  // ConversationReplay reads `toolName`, `args`, and `result` off each entry.
  return JSON.stringify(calls.map(call => ({
    type: "tool-call",
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    args: call.args,
    argsText: JSON.stringify(call.args),
    result: call.result,
  })));
}

async function seedMcpCalls(transport: Transport): Promise<number> {
  for (const call of DEMO_MCP_CALLS) {
    const correlationId = `${DEMO_PREFIX}mcp-${call.slug}`;
    await transport.callReducer("log_mcp_call", [
      correlationId,
      opt(`${DEMO_PREFIX}${call.conversationSlug}`),
      call.toolName,
      call.reason,
      call.userPrompt,
      call.question,
      call.response,
      call.stepCount,
      serializeInnerToolCalls(call.innerToolCalls),
      call.durationMs,
      call.modelId,
      opt(call.errorMessage),
      opt(call.context),
      opt(call.user),
      opt(call.project),
    ]);

    const { review } = call;
    if (review != null) {
      await transport.callReducer("update_mcp_qa_review", [
        correlationId,
        review.needsHumanReview,
        review.answerCorrect,
        review.answerRelevant,
        JSON.stringify(review.flags),
        review.improvementSuggestions,
        review.overallScore,
        review.reviewModelId,
        opt(review.conversation.length === 0 ? undefined : JSON.stringify(review.conversation)),
        opt(review.reviewErrorMessage),
      ]);
    }

    // Curating a call into the knowledge base also marks it human-reviewed, so
    // this runs before the explicit set_human_reviewed below to avoid a
    // redundant write.
    const { publishToQa } = call;
    if (publishToQa != null) {
      await transport.callReducer("upsert_qa_from_call_and_mark_reviewed", [
        correlationId,
        publishToQa.question,
        publishToQa.answer,
        publishToQa.publish,
      ]);
    } else if (call.humanReviewed === true) {
      await transport.callReducer("set_human_reviewed", [correlationId, true]);
    }
  }
  return DEMO_MCP_CALLS.length;
}

async function seedAiQueries(transport: Transport): Promise<number> {
  for (const query of DEMO_AI_QUERIES) {
    await transport.callReducer("log_ai_query", [
      `${DEMO_PREFIX}ai-${query.slug}`,
      query.mode,
      query.systemPromptId,
      query.quality,
      query.speed,
      query.modelId,
      query.isAuthenticated,
      opt(query.projectId),
      opt(query.userId),
      JSON.stringify(query.requestedTools),
      JSON.stringify(query.messages),
      JSON.stringify(query.steps),
      query.finalText,
      opt(query.inputTokens),
      opt(query.outputTokens),
      opt(query.cachedInputTokens),
      opt(query.cacheCreationTokens),
      opt(query.costUsd),
      opt(query.cacheDiscountUsd),
      opt(query.errorMessage == null ? `gen-${DEMO_PREFIX}${query.slug}` : undefined),
      query.stepCount,
      query.durationMs,
      opt(query.errorMessage),
      opt(`${DEMO_PREFIX}conv-ai-${query.slug}`),
    ]);
  }
  return DEMO_AI_QUERIES.length;
}

async function seedFeedback(transport: Transport): Promise<number> {
  for (const feedback of DEMO_FEEDBACK) {
    await transport.callReducer("log_feedback", [
      `${DEMO_PREFIX}fb-${feedback.slug}`,
      opt(feedback.conversationSlug == null ? undefined : `${DEMO_PREFIX}${feedback.conversationSlug}`),
      feedback.category,
      feedback.message,
      feedback.transport,
      opt(feedback.requestIp),
      opt(feedback.requestIpSource),
      opt(feedback.userAgent),
      opt(feedback.requestHost),
      opt(feedback.mcpProtocolVersion),
    ]);
  }
  return DEMO_FEEDBACK.length;
}

async function seedManualQa(transport: Transport): Promise<number> {
  for (const entry of DEMO_MANUAL_QA) {
    // add_manual_qa dedupes on requestId, so a stable id makes this idempotent
    // even if a previous run was interrupted before the clear step completed.
    await transport.callReducer("add_manual_qa", [
      entry.question,
      entry.answer,
      entry.publish,
      `${DEMO_PREFIX}${entry.slug}`,
    ]);
  }
  return DEMO_MANUAL_QA.length;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const clearOnly = process.argv.includes("--clear");

  loadEnvFiles();
  const transport = createTransport(await signSeedToken());

  // The `my_visible_*` views and every page procedure gate on a session row for
  // the caller's identity. WebSocket clients get one from `clientConnected`;
  // an HTTP caller has to enrol itself.
  await transport.callReducer("touch_session", []);

  const removed = await clearPreviousSeed(transport);
  console.log(`Removed ${removed} previously seeded row(s).`);

  if (clearOnly) {
    console.log("--clear given; not reseeding.");
    return;
  }

  const mcpCalls = await seedMcpCalls(transport);
  const aiQueries = await seedAiQueries(transport);
  const feedback = await seedFeedback(transport);
  const manualQa = await seedManualQa(transport);

  console.log([
    `Seeded ${mcpCalls} MCP calls, ${aiQueries} AI queries, ${feedback} feedback entries, `,
    `and ${manualQa} manual knowledge-base entries.`,
    "\nAll rows are stamped with the current time — reducers set createdAt server-side,",
    "\nso the 14-day chart in Analytics concentrates in today's bucket.",
    `\nRe-run to refresh, or 'pnpm seed:demo --clear' to remove everything with the ${DEMO_PREFIX} prefix.`,
  ].join(""));
}

await main();
