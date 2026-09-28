import { afterEach, beforeEach, describe } from "vitest";
import { it } from "../helpers";
import {
  callReducer,
  createCleanupScope,
  decodeOptional,
  findCorrelationIdByQuestion,
  findManualQaEntryIdByQuestion,
  isSpacetimedbReachable, opt, signMemberToken,
  sqlQuery,
  touchSession,
  type CleanupScope,
} from "./helpers";

const canRun = await isSpacetimedbReachable();

function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readManualEntry(token: string, qaId: bigint) {
  const { rows } = await sqlQuery(token, "SELECT * FROM my_visible_qa_entries");
  const match = rows.find(r => {
    const raw = r.id;
    const id = typeof raw === "string" ? BigInt(raw) : typeof raw === "number" ? BigInt(raw) : raw;
    return id === qaId;
  });
  if (!match) throw new Error(`qa_entries row ${qaId.toString()} not found`);
  return match as Record<string, unknown>;
}

const readOptional = decodeOptional;

async function createMemberSessionToken(): Promise<string> {
  const token = await signMemberToken();
  const touch = await touchSession(token);
  if (!touch.ok) throw new Error(`touch_session failed: ${touch.body}`);
  return token;
}

describe.skipIf(!canRun)("qa_entries CRUD invariants", () => {
  let scope: CleanupScope;
  beforeEach(() => {
    scope = createCleanupScope();
  });
  afterEach(async () => {
    await scope.cleanup();
  });

  it("firstPublishedAt is immutable; lastPublishedAt updates per republish; both survive unpublish", async ({ expect }) => {
    const reviewerToken = await createMemberSessionToken();

    const marker = uniqueMarker("publish-history");
    scope.trackMcpQuestion(marker);
    const add = await callReducer(reviewerToken, "add_manual_qa", [marker, "a", true, marker]);
    expect(add.ok, add.body).toBe(true);

    const qaId = await findManualQaEntryIdByQuestion(reviewerToken, marker);
    expect(qaId).toBeDefined();

    const initial = await readManualEntry(reviewerToken, qaId!);
    const firstPublishedAt = readOptional<unknown>(initial.first_published_at ?? initial.firstPublishedAt);
    const lastPublishedAt1 = readOptional<unknown>(initial.last_published_at ?? initial.lastPublishedAt);
    expect(firstPublishedAt).toBeDefined();
    expect(lastPublishedAt1).toBeDefined();

    // Unpublish: both timestamps must survive.
    const unpub = await callReducer(reviewerToken, "update_qa_entry_with_publish", [qaId!, marker, "a", false]);
    expect(unpub.ok, unpub.body).toBe(true);
    const afterUnpub = await readManualEntry(reviewerToken, qaId!);
    expect(readOptional(afterUnpub.first_published_at ?? afterUnpub.firstPublishedAt)).toEqual(firstPublishedAt);
    expect(readOptional(afterUnpub.last_published_at ?? afterUnpub.lastPublishedAt)).toEqual(lastPublishedAt1);

    // Republish: firstPublishedAt unchanged; lastPublishedAt advances.
    await new Promise(r => setTimeout(r, 10));
    const rep = await callReducer(reviewerToken, "update_qa_entry_with_publish", [qaId!, marker, "a", true]);
    expect(rep.ok, rep.body).toBe(true);
    const afterRep = await readManualEntry(reviewerToken, qaId!);
    expect(readOptional(afterRep.first_published_at ?? afterRep.firstPublishedAt)).toEqual(firstPublishedAt);
    const lastPublishedAt2 = readOptional<unknown>(afterRep.last_published_at ?? afterRep.lastPublishedAt);
    expect(lastPublishedAt2).toBeDefined();
    expect(lastPublishedAt2).not.toEqual(lastPublishedAt1);
  });

  it("delete_qa_entry preserves the originating mcp_call_log row when present", async ({ expect }) => {
    // Manual entries have no mcp_call_log row; this test asserts the inverse — that the
    // delete reducer's scope is qa_entries only. Since manual entries have nothing to
    // preserve in mcp_call_log, the test asserts via the row-count of qa_entries dropping
    // by exactly 1, with no side effect on other tables.
    const reviewerToken = await createMemberSessionToken();

    const marker = uniqueMarker("delete-scope");
    scope.trackMcpQuestion(marker);
    const add = await callReducer(reviewerToken, "add_manual_qa", [marker, "a", true, marker]);
    expect(add.ok, add.body).toBe(true);

    const qaId = await findManualQaEntryIdByQuestion(reviewerToken, marker);
    expect(qaId).toBeDefined();

    // Seed an mcp_call_log row of our own and assert it survives the qa-entry
    // delete. Scoped by marker (NOT global row counts): the spacetimedb test
    // files run concurrently against the shared DB, so other tests inserting
    // or deleting their own rows would race a count-based assertion.
    const mcpMarker = uniqueMarker("delete-scope-mcp");
    scope.trackMcpQuestion(mcpMarker);
    const seedMcp = await callReducer(reviewerToken, "log_mcp_call", [
      mcpMarker, opt(null), "delete-scope-tool", "reason", "prompt", mcpMarker, "response", 0, "[]", 0n, "model", opt(null),
    ]);
    expect(seedMcp.ok, seedMcp.body).toBe(true);

    const del = await callReducer(reviewerToken, "delete_qa_entry", [qaId!]);
    expect(del.ok, del.body).toBe(true);

    expect(await findManualQaEntryIdByQuestion(reviewerToken, marker)).toBeUndefined();
    expect(await findCorrelationIdByQuestion(reviewerToken, mcpMarker)).toBe(mcpMarker);
  });
});
