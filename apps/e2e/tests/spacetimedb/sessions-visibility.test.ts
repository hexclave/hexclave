import { afterEach, beforeEach, describe } from "vitest";
import { it } from "../helpers";
import { callReducer, createCleanupScope, isSpacetimedbReachable, signMemberToken, mintIdentity, sqlQuery, touchSession, type CleanupScope } from "./helpers";

const canRun = await isSpacetimedbReachable();

function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe.skipIf(!canRun)("session-gated view visibility", () => {
  let scope: CleanupScope;
  beforeEach(() => {
    scope = createCleanupScope();
  });
  afterEach(async () => {
    await scope.cleanup();
  });

  it("a project member with a touched session sees my_visible_qa_entries rows", async ({ expect }) => {
    const memberToken = await signMemberToken();
    const marker = uniqueMarker("session-visibility");
    scope.trackMcpQuestion(marker);
    const seed = await callReducer(memberToken, "add_manual_qa", [marker, "a", false, marker]);
    expect(seed.ok, seed.body).toBe(true);

    const touch = await touchSession(memberToken);
    expect(touch.ok, touch.body).toBe(true);

    const { rows } = await sqlQuery(memberToken, "SELECT * FROM my_visible_qa_entries");
    expect(rows.some(r => r.question === marker)).toBe(true);
  });

  it("a SpacetimeDB-native identity without Stack Auth claims sees zero rows", async ({ expect }) => {
    const memberToken = await signMemberToken();
    const marker = uniqueMarker("stranger-visibility");
    scope.trackMcpQuestion(marker);
    const seed = await callReducer(memberToken, "add_manual_qa", [marker, "a", false, marker]);
    expect(seed.ok, seed.body).toBe(true);

    // touch_session with a non-member token must not create a session row.
    const stranger = await mintIdentity();
    await touchSession(stranger.token).catch(() => undefined);
    const { rows } = await sqlQuery(stranger.token, "SELECT * FROM my_visible_qa_entries");
    expect(rows.length).toBe(0);
  });

  it("a project member without a touched session sees zero rows (views gate on the session row)", async ({ expect }) => {
    const seedMemberToken = await signMemberToken();
    const marker = uniqueMarker("untouched-session");
    scope.trackMcpQuestion(marker);
    const seed = await callReducer(seedMemberToken, "add_manual_qa", [marker, "a", false, marker]);
    expect(seed.ok, seed.body).toBe(true);

    // A different member that never touched a session: even with a valid
    // member token, the SQL views return nothing until a session exists.
    const freshMemberToken = await signMemberToken();
    const { rows } = await sqlQuery(freshMemberToken, "SELECT * FROM my_visible_qa_entries");
    expect(rows.length).toBe(0);
  });
});
