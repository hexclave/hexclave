import { describe, expect, it } from "vitest";
import { AccessToken, InternalSession } from "./sessions";

/**
 * Builds a decodable (unsigned) access-token JWT with a valid payload. `refreshTokenId` controls the
 * `refresh_token_id` claim (the session identifier); `iatOffsetSeconds` lets two tokens for the same session
 * differ as strings while sharing a `refresh_token_id`.
 */
function createAccessTokenString(refreshTokenId: string, options?: { iatOffsetSeconds?: number, sub?: string }): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const nowSeconds = Math.floor(Date.now() / 1000) + (options?.iatOffsetSeconds ?? 0);
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({
      sub: options?.sub ?? "user-id",
      exp: nowSeconds + 60,
      iat: nowSeconds,
      iss: "https://api.example.test",
      aud: "project-id",
      project_id: "project-id",
      branch_id: "main",
      refresh_token_id: refreshTokenId,
      role: "authenticated",
      name: null,
      email: null,
      email_verified: false,
      selected_team_id: null,
      signed_up_at: nowSeconds,
      is_anonymous: false,
      is_restricted: false,
      restricted_reason: null,
      requires_totp_mfa: false,
    }),
    "",
  ].join(".");
}

function createAccessToken(refreshTokenId: string, options?: { iatOffsetSeconds?: number, sub?: string }): AccessToken {
  const accessToken = AccessToken.createIfValid(createAccessTokenString(refreshTokenId, options));
  if (accessToken === null) {
    throw new Error("The test access token should satisfy the access token schema");
  }
  return accessToken;
}

function createAccessOnlySession(accessToken: string): InternalSession {
  return new InternalSession({
    refreshAccessTokenCallback: async () => null,
    refreshToken: null,
    accessToken,
  });
}

const currentToken = (session: InternalSession) => session.getAccessTokenIfNotExpiredYet(20_000, null)?.token;

describe("InternalSession.calculateSessionKey", () => {
  it("keys by the refresh token when one is present (ignoring any access token)", () => {
    expect(InternalSession.calculateSessionKey({ refreshToken: "rt-abc" })).toBe("refresh-rt-abc");
    expect(InternalSession.calculateSessionKey({ refreshToken: "rt-abc", accessToken: createAccessTokenString("rtid-1") }))
      .toBe("refresh-rt-abc");
  });

  it("returns not-logged-in when neither token is present", () => {
    expect(InternalSession.calculateSessionKey({ refreshToken: null })).toBe("not-logged-in");
    expect(InternalSession.calculateSessionKey({ refreshToken: null, accessToken: null })).toBe("not-logged-in");
  });

  it("keys an access-only session by its refresh_token_id", () => {
    expect(InternalSession.calculateSessionKey({ refreshToken: null, accessToken: createAccessTokenString("rtid-1") }))
      .toBe("access-session-rtid-1");
  });

  it("is stable across re-minted access tokens for the same session (the regression this fixes)", () => {
    const first = createAccessTokenString("rtid-1", { iatOffsetSeconds: 0 });
    const second = createAccessTokenString("rtid-1", { iatOffsetSeconds: 1 });
    expect(second).not.toBe(first);
    expect(InternalSession.calculateSessionKey({ refreshToken: null, accessToken: second }))
      .toBe(InternalSession.calculateSessionKey({ refreshToken: null, accessToken: first }));
  });

  it("distinguishes access-only sessions with different refresh_token_ids", () => {
    expect(InternalSession.calculateSessionKey({ refreshToken: null, accessToken: createAccessTokenString("rtid-1") }))
      .not.toBe(InternalSession.calculateSessionKey({ refreshToken: null, accessToken: createAccessTokenString("rtid-2") }));
  });

  it("falls back to the raw token when the access token can't be decoded", () => {
    expect(InternalSession.calculateSessionKey({ refreshToken: null, accessToken: "not-a-jwt" })).toBe("access-not-a-jwt");
  });
});

describe("InternalSession#updateAccessToken", () => {
  it("installs a fresh token for the same access-only session in place", () => {
    const initial = createAccessTokenString("rtid-1", { iatOffsetSeconds: 0 });
    const refreshed = createAccessTokenString("rtid-1", { iatOffsetSeconds: 1 });
    const session = createAccessOnlySession(initial);

    session.updateAccessToken({ accessToken: refreshed, refreshToken: null });
    expect(currentToken(session)).toBe(refreshed);
    // identity is unchanged — same session key, same object
    expect(session.sessionKey).toBe("access-session-rtid-1");
  });

  it("rejects a token pair belonging to a different access-only session", () => {
    const initial = createAccessTokenString("rtid-1");
    const foreign = createAccessTokenString("rtid-2", { sub: "other-user" });
    const session = createAccessOnlySession(initial);

    session.updateAccessToken({ accessToken: foreign, refreshToken: null });
    expect(currentToken(session)).toBe(initial);
  });

  it("is a no-op for an unchanged, null, or undecodable token", () => {
    const initial = createAccessTokenString("rtid-1");
    const session = createAccessOnlySession(initial);

    session.updateAccessToken({ accessToken: initial, refreshToken: null });
    session.updateAccessToken({ accessToken: null, refreshToken: null });
    session.updateAccessToken({ accessToken: "not-a-jwt", refreshToken: null });
    expect(currentToken(session)).toBe(initial);
  });

  it("never revives an invalidated session", () => {
    const session = createAccessOnlySession(createAccessTokenString("rtid-1"));
    session.markInvalid();

    session.updateAccessToken({ accessToken: createAccessTokenString("rtid-1", { iatOffsetSeconds: 1 }), refreshToken: null });
    expect(session.isKnownToBeInvalid()).toBe(true);
    expect(currentToken(session)).toBeUndefined();
  });

  it("updates a refresh-token-backed session's access token in place when the refresh token matches", () => {
    const session = new InternalSession({
      refreshAccessTokenCallback: async () => null,
      refreshToken: "rt-abc",
      accessToken: createAccessTokenString("rtid-1"),
    });
    const refreshed = createAccessTokenString("rtid-2", { iatOffsetSeconds: 1 });

    session.updateAccessToken({ accessToken: refreshed, refreshToken: "rt-abc" });
    expect(currentToken(session)).toBe(refreshed);
    expect(session.sessionKey).toBe("refresh-rt-abc");
  });

  it("rejects a token pair carrying a different refresh token for a refresh-backed session", () => {
    const initial = createAccessTokenString("rtid-1");
    const session = new InternalSession({
      refreshAccessTokenCallback: async () => null,
      refreshToken: "rt-abc",
      accessToken: initial,
    });

    session.updateAccessToken({ accessToken: createAccessTokenString("rtid-2"), refreshToken: "rt-other" });
    expect(currentToken(session)).toBe(initial);
  });
});

describe("InternalSession#getOrFetchLikelyValidTokens", () => {
  it("starts a new refresh after an earlier refresh rejects", async () => {
    let refreshCount = 0;
    const session = new InternalSession({
      refreshAccessTokenCallback: async () => {
        refreshCount += 1;
        if (refreshCount === 1) {
          throw new Error("Temporary refresh failure");
        }
        return createAccessToken("rtid-1");
      },
      refreshToken: "rt-abc",
    });

    await expect(session.getOrFetchLikelyValidTokens(20_000, null))
      .rejects.toThrow("Temporary refresh failure");
    await expect(session.getOrFetchLikelyValidTokens(20_000, null))
      .resolves.toMatchObject({ accessToken: { token: expect.any(String) } });
    expect(refreshCount).toBe(2);
  });

  it("retries once when a newly fetched access token is already too old", async () => {
    let refreshCount = 0;
    const session = new InternalSession({
      refreshAccessTokenCallback: async () => {
        refreshCount += 1;
        return createAccessToken("rtid-1", { iatOffsetSeconds: refreshCount === 1 ? -20 : 0 });
      },
      refreshToken: "rt-abc",
    });

    const tokens = await session.getOrFetchLikelyValidTokens(20_000, 15_000);

    expect(refreshCount).toBe(2);
    expect(tokens?.accessToken.issuedMillisAgo).toBeLessThan(15_000);
  });

  it("throws after one retry when the newly fetched access token is still too old", async () => {
    let refreshCount = 0;
    const session = new InternalSession({
      refreshAccessTokenCallback: async () => {
        refreshCount += 1;
        return createAccessToken("rtid-1", { iatOffsetSeconds: -20 });
      },
      refreshToken: "rt-abc",
    });

    await expect(session.getOrFetchLikelyValidTokens(20_000, 15_000))
      .rejects.toThrow("access token issuance is too slow");
    expect(refreshCount).toBe(2);
  });
});
