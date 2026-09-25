import { afterEach, beforeEach, describe } from "vitest";
import { it } from "../helpers";
import { callReducer, createCleanupScope, findManualQaEntryIdByQuestion, isSpacetimedbReachable, signMemberToken, mintIdentity, sqlQuery, touchSession, type CleanupScope } from "./helpers";

const canRun = await isSpacetimedbReachable();

function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function publishedQaContains(question: string): Promise<boolean> {
  const stranger = await mintIdentity();
  const { rows } = await sqlQuery(stranger.token, "SELECT * FROM published_qa");
  return rows.some(r => r.question === question);
}

async function createMemberSessionToken(): Promise<string> {
  const reviewerToken = await signMemberToken();
  const touch = await touchSession(reviewerToken);
  if (!touch.ok) throw new Error(`touch_session failed: ${touch.body}`);
  return reviewerToken;
}

describe.skipIf(!canRun)("published_qa visibility", () => {
  let scope: CleanupScope;
  beforeEach(() => {
    scope = createCleanupScope();
  });
  afterEach(async () => {
    await scope.cleanup();
  });

  it("does not expose rows added with publish:false", async ({ expect }) => {
    const reviewerToken = await createMemberSessionToken();

    const marker = uniqueMarker("unpublished");
    scope.trackMcpQuestion(marker);
    const add = await callReducer(reviewerToken, "add_manual_qa", [marker, "x", false, marker]);
    expect(add.ok, add.body).toBe(true);

    expect(await publishedQaContains(marker)).toBe(false);
  });

  it("removes a row from published_qa when update_qa_entry_with_publish sets publish:false", async ({ expect }) => {
    const reviewerToken = await createMemberSessionToken();

    const marker = uniqueMarker("to-unpublish");
    scope.trackMcpQuestion(marker);
    const add = await callReducer(reviewerToken, "add_manual_qa", [marker, "x", true, marker]);
    expect(add.ok, add.body).toBe(true);
    expect(await publishedQaContains(marker)).toBe(true);

    const qaId = await findManualQaEntryIdByQuestion(reviewerToken, marker);
    expect(qaId).toBeDefined();

    const update = await callReducer(reviewerToken, "update_qa_entry_with_publish", [
      qaId!,
      marker,
      "x",
      false,
    ]);
    expect(update.ok, update.body).toBe(true);

    expect(await publishedQaContains(marker)).toBe(false);
  });

  it("removes a row from published_qa when deleted", async ({ expect }) => {
    const reviewerToken = await createMemberSessionToken();

    const marker = uniqueMarker("to-delete");
    scope.trackMcpQuestion(marker);
    const add = await callReducer(reviewerToken, "add_manual_qa", [marker, "x", true, marker]);
    expect(add.ok, add.body).toBe(true);
    expect(await publishedQaContains(marker)).toBe(true);

    const qaId = await findManualQaEntryIdByQuestion(reviewerToken, marker);
    expect(qaId).toBeDefined();

    const del = await callReducer(reviewerToken, "delete_qa_entry", [qaId!]);
    expect(del.ok, del.body).toBe(true);

    expect(await publishedQaContains(marker)).toBe(false);
  });

  it("lets reviewer B delete a row published by reviewer A (cross-reviewer integrity)", async ({ expect }) => {
    // A publishes.
    const reviewerAToken = await createMemberSessionToken();

    const marker = uniqueMarker("cross-reviewer");
    scope.trackMcpQuestion(marker);
    const add = await callReducer(reviewerAToken, "add_manual_qa", [marker, "x", true, marker]);
    expect(add.ok, add.body).toBe(true);
    expect(await publishedQaContains(marker)).toBe(true);

    const qaId = await findManualQaEntryIdByQuestion(reviewerAToken, marker);
    expect(qaId).toBeDefined();

    // B deletes with their own token.
    const reviewerBToken = await signMemberToken();
    const del = await callReducer(reviewerBToken, "delete_qa_entry", [qaId!]);
    expect(del.ok, del.body).toBe(true);

    expect(await publishedQaContains(marker)).toBe(false);
  });
});
