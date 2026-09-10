import { describe } from "vitest";
import { it } from "../helpers";
import { callReducer, isSpacetimedbReachable, opt, signMemberToken, sqlQuery, touchSession } from "./helpers";

const canRun = await isSpacetimedbReachable();

// Must match MAX_LIVE_LOG_ROWS in apps/internal-tool/spacetimedb/src/index.ts.
const MAX_LIVE_LOG_ROWS = 200;

function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runBounded<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      await worker(next);
    }
  }));
}

// log_mcp_call arg order (see module index.ts): correlationId, conversationId?,
// toolName, reason, userPrompt, question, response, stepCount, innerToolCallsJson,
// durationMs, modelId, errorMessage?.
async function insertMcpCall(token: string, correlationId: string, question: string): Promise<void> {
  const res = await callReducer(token, "log_mcp_call", [
    correlationId, opt(null), "ask_hexclave", "reason", "prompt", question, "response",
    1, "[]", 0n, "model", opt(null),
  ]);
  if (!res.ok) throw new Error(`log_mcp_call failed: ${res.body}`);
}

describe.skipIf(!canRun)("my_visible_* log views are capped to the newest N rows", () => {
  it("returns at most MAX_LIVE_LOG_ROWS and keeps the newest rows", async ({ expect }) => {
    const token = await signMemberToken();
    await touchSession(token);

    const marker = uniqueMarker("capped-views");
    // Insert comfortably past the cap so the view is guaranteed full of our rows.
    const overshoot = 12;
    const correlationIds = Array.from({ length: MAX_LIVE_LOG_ROWS + overshoot }, (_, i) => `${marker}-${i}`);

    try {
      await runBounded(correlationIds, 12, cid => insertMcpCall(token, cid, marker));

      const { rows } = await sqlQuery(token, "SELECT * FROM my_visible_mcp_call_log");

      // The cap holds: the append-only table is not streamed in full.
      expect(rows.length).toBe(MAX_LIVE_LOG_ROWS);
      // Newest-first: since our rows are the most recently inserted, a correctly
      // ordered cap returns only our rows (the oldest `overshoot` are dropped).
      expect(rows.every(r => r.question === marker)).toBe(true);
    } finally {
      await runBounded(correlationIds, 12, async (cid) => {
        await callReducer(token, "delete_mcp_call_log", [cid]).catch(() => undefined);
      });
    }
  });
});
