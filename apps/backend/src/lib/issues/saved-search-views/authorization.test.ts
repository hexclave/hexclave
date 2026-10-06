import { describe, expect, it } from "vitest";
import { createSavedIssueSearchViewMutationAuthorization } from "./persistence";

const ACTOR_USER_ID = "11111111-1111-4111-8111-111111111111";

describe("saved issue search view mutation authorization", () => {
  it("maps an authenticated client or server request to creator-only access", () => {
    expect(createSavedIssueSearchViewMutationAuthorization({
      authType: "client",
      actorUserId: ACTOR_USER_ID,
    })).toEqual({ kind: "creator", actorUserId: ACTOR_USER_ID });
    expect(createSavedIssueSearchViewMutationAuthorization({
      authType: "server",
      actorUserId: ACTOR_USER_ID,
    })).toEqual({ kind: "creator", actorUserId: ACTOR_USER_ID });
  });

  it("maps only explicit admin access to unrestricted mutation access", () => {
    expect(createSavedIssueSearchViewMutationAuthorization({
      authType: "admin",
      actorUserId: null,
    })).toEqual({ kind: "admin" });
  });

  it("rejects a bare server key and malformed user identity", () => {
    expect(() => createSavedIssueSearchViewMutationAuthorization({
      authType: "server",
      actorUserId: null,
    })).toThrow("require an authenticated user");
    expect(() => createSavedIssueSearchViewMutationAuthorization({
      authType: "client",
      actorUserId: "not-a-uuid",
    })).toThrow("owner is invalid");
  });
});
