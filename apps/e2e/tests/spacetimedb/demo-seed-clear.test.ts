// `clear_demo_seed` is what lets `pnpm seed:demo` re-run safely: it removes every
// row the seeder wrote, across the whole table (not just the capped my_visible_*
// views the seeder can query), and nothing else. The prefix is fixed inside the
// module, so the property under test is "only demo-seed- rows disappear".

import { afterEach, beforeEach, describe } from "vitest";
import { it } from "../helpers";
import {
  callReducer,
  createCleanupScope,
  findManualQaEntryIdByQuestion,
  isSpacetimedbReachable,
  opt,
  signMemberToken,
  sqlQuery,
  touchSession,
  type CleanupScope,
} from "./helpers";

const canRun = await isSpacetimedbReachable();

// Must match DEMO_SEED_PREFIX in apps/internal-tool/spacetimedb/src/demo-seed.ts.
const DEMO_SEED_PREFIX = "demo-seed-";

function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function insertMcpCall(token: string, correlationId: string, question: string): Promise<void> {
  const res = await callReducer(token, "log_mcp_call", [
    correlationId, opt(null), "ask_hexclave", "reason", "prompt", question, "response",
    1, "[]", 0n, "model", opt(null), opt(null), opt(null), opt(null),
  ]);
  if (!res.ok) throw new Error(`log_mcp_call failed: ${res.body}`);
}

describe.skipIf(!canRun)("clear_demo_seed", () => {
  let scope: CleanupScope;
  beforeEach(() => {
    scope = createCleanupScope();
  });
  afterEach(async () => {
    await scope.cleanup();
  });

  it("deletes only rows carrying the demo-seed prefix", async ({ expect }) => {
    const token = await signMemberToken();
    await touchSession(token);

    const marker = uniqueMarker("demo-seed-clear");
    const seededCorrelationId = `${DEMO_SEED_PREFIX}${marker}`;
    const realCorrelationId = `real-${marker}`;
    const realQuestion = `${marker}-real`;
    scope.trackMcpQuestion(realQuestion);
    // Tracked in case the assertion below fails and the row outlives the test.
    scope.trackMcpQuestion(`${marker}-seeded`);

    await insertMcpCall(token, seededCorrelationId, `${marker}-seeded`);
    await insertMcpCall(token, realCorrelationId, realQuestion);

    const seededQaQuestion = `${marker}-seeded-qa`;
    scope.trackMcpQuestion(seededQaQuestion);
    const qaRes = await callReducer(token, "add_manual_qa", [seededQaQuestion, "answer", false, `${DEMO_SEED_PREFIX}qa-${marker}`]);
    expect(qaRes.ok, qaRes.body).toBe(true);
    expect(await findManualQaEntryIdByQuestion(token, seededQaQuestion)).not.toBeUndefined();

    const cleared = await callReducer(token, "clear_demo_seed", []);
    expect(cleared.ok, cleared.body).toBe(true);

    const { rows } = await sqlQuery(token, "SELECT * FROM my_visible_mcp_call_log");
    const correlationIds = new Set(rows.map(row => row.correlation_id ?? row.correlationId));
    expect(correlationIds.has(seededCorrelationId)).toBe(false);
    expect(correlationIds.has(realCorrelationId)).toBe(true);
    expect(await findManualQaEntryIdByQuestion(token, seededQaQuestion)).toBeUndefined();
  });
});
