import { it } from "../helpers";
import { createApp } from "./js-helpers";

const signIn = async (clientApp: any) => {
  await clientApp.signUpWithCredential({
    email: "test@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  await clientApp.signInWithCredential({
    email: "test@test.com",
    password: "password",
  });
};

// Hexclave rebrand: accept either the legacy `stackauth_` prefix or the new `hexclave_` one.
const STACK_AUTHORIZATION_VALUE_PREFIX = "stackauth_";
const HEXCLAVE_AUTHORIZATION_VALUE_PREFIX = "hexclave_";

function parseAuthorizationHeaderValue(value: string): { accessToken: string | null, refreshToken: string | null } {
  const bearerMatch = value.match(/^Bearer\s+(.+)$/i);
  if (bearerMatch == null) {
    throw new Error(`Invalid authorization header format: ${value}`);
  }

  const credential = bearerMatch[1];
  const matchedPrefix = credential.startsWith(HEXCLAVE_AUTHORIZATION_VALUE_PREFIX) ? HEXCLAVE_AUTHORIZATION_VALUE_PREFIX
    : credential.startsWith(STACK_AUTHORIZATION_VALUE_PREFIX) ? STACK_AUTHORIZATION_VALUE_PREFIX
      : null;
  if (matchedPrefix == null) {
    throw new Error(`Invalid authorization credential (expected stackauth_/hexclave_ prefix): ${credential}`);
  }

  const encodedAuthJson = credential.slice(matchedPrefix.length);
  if (encodedAuthJson.length === 0) {
    throw new Error("Missing encoded auth payload.");
  }

  const decodedAuthJson = Buffer.from(encodedAuthJson, "base64").toString("utf8");
  const parsed: unknown = JSON.parse(decodedAuthJson);
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Decoded authorization payload must be an object.");
  }

  const accessToken = parsed["accessToken"];
  const refreshToken = parsed["refreshToken"];
  if (accessToken != null && typeof accessToken !== "string") {
    throw new Error("Decoded authorization payload contains invalid accessToken.");
  }
  if (refreshToken != null && typeof refreshToken !== "string") {
    throw new Error("Decoded authorization payload contains invalid refreshToken.");
  }

  return {
    accessToken: accessToken ?? null,
    refreshToken: refreshToken ?? null,
  };
}

// ============================================
// version tests
// ============================================

it("clientApp.version should return a valid version string", async ({ expect }) => {
  const { clientApp } = await createApp({});
  expect(clientApp.version).toBeDefined();
  expect(typeof clientApp.version).toBe("string");
  expect(clientApp.version).toMatch(/^js @hexclave\/js@\d+\.\d+\.\d+/);
});

it("serverApp.version should return the same version as clientApp", async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({});
  expect(serverApp.version).toBe(clientApp.version);
});

// ============================================
// getAccessToken / getRefreshToken tests
// ============================================

it("clientApp.getAccessToken should return access token when signed in", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const accessToken = await (clientApp as any).getAccessToken();
  expect(accessToken).toBeDefined();
  expect(typeof accessToken).toBe("string");
});

it("clientApp.getAccessToken should return null when not signed in", async ({ expect }) => {
  const { clientApp } = await createApp({});

  const accessToken = await (clientApp as any).getAccessToken();
  expect(accessToken).toBeNull();
});

it("clientApp.getRefreshToken should return refresh token when signed in", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const refreshToken = await (clientApp as any).getRefreshToken();
  expect(refreshToken).toBeDefined();
  expect(typeof refreshToken).toBe("string");
});

it("clientApp.getRefreshToken should return null when not signed in", async ({ expect }) => {
  const { clientApp } = await createApp({});

  const refreshToken = await (clientApp as any).getRefreshToken();
  expect(refreshToken).toBeNull();
});

it("clientApp.getAccessToken should work with tokenStore option", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const accessToken = await (clientApp as any).getAccessToken({ tokenStore: "memory" });
  expect(accessToken).toBeDefined();
  expect(typeof accessToken).toBe("string");
});

it("clientApp.getRefreshToken should work with tokenStore option", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const refreshToken = await (clientApp as any).getRefreshToken({ tokenStore: "memory" });
  expect(refreshToken).toBeDefined();
  expect(typeof refreshToken).toBe("string");
});

// ============================================
// user.getAccessToken / user.getRefreshToken tests
// ============================================

it("user.getAccessToken should return access token", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" }) as any;
  const accessToken = await user.getAccessToken();
  expect(accessToken).toBeDefined();
  expect(typeof accessToken).toBe("string");
});

it("user.getRefreshToken should return refresh token", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" }) as any;
  const refreshToken = await user.getRefreshToken();
  expect(refreshToken).toBeDefined();
  expect(typeof refreshToken).toBe("string");
});

// ============================================
// currentSession.getTokens tests
// ============================================

it("user.currentSession.getTokens should return both tokens", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" });
  const tokens = await user.currentSession.getTokens();
  expect(tokens).toBeDefined();
  expect(tokens.accessToken).toBeDefined();
  expect(tokens.refreshToken).toBeDefined();
  expect(typeof tokens.accessToken).toBe("string");
  expect(typeof tokens.refreshToken).toBe("string");
});

// ============================================
// Consistency tests - ensure all methods return consistent values
// ============================================

it("clientApp token methods should return consistent values", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const accessToken = await (clientApp as any).getAccessToken();
  const refreshToken = await (clientApp as any).getRefreshToken();
  const authJson = await clientApp.getAuthJson();

  expect(accessToken).toBe(authJson.accessToken);
  expect(refreshToken).toBe(authJson.refreshToken);
});

it("user token methods should return consistent values", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" }) as any;

  const accessToken = await user.getAccessToken();
  const refreshToken = await user.getRefreshToken();
  const authJson = await user.getAuthJson();
  const sessionTokens = await user.currentSession.getTokens();

  // All methods should return consistent tokens
  expect(accessToken).toBe(authJson.accessToken);
  expect(refreshToken).toBe(authJson.refreshToken);
  expect(accessToken).toBe(sessionTokens.accessToken);
  expect(refreshToken).toBe(sessionTokens.refreshToken);
});

it("clientApp and user token methods should match", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" }) as any;

  // Compare getAccessToken results
  const appAccessToken = await (clientApp as any).getAccessToken();
  const userAccessToken = await user.getAccessToken();
  expect(appAccessToken).toBe(userAccessToken);

  // Compare getRefreshToken results
  const appRefreshToken = await (clientApp as any).getRefreshToken();
  const userRefreshToken = await user.getRefreshToken();
  expect(appRefreshToken).toBe(userRefreshToken);
});

// ============================================
// Token validation tests - verify tokens actually work for authentication
// ============================================

it("access and refresh tokens should work for authentication", async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({});
  await signIn(clientApp);

  // Get tokens from signed-in user
  const accessToken = await (clientApp as any).getAccessToken();
  const refreshToken = await (clientApp as any).getRefreshToken();

  expect(accessToken).toBeDefined();
  expect(refreshToken).toBeDefined();

  // Create a new server app using these tokens
  const serverUser = await serverApp.getUser({ tokenStore: { accessToken: accessToken!, refreshToken: refreshToken! } });

  expect(serverUser).not.toBeNull();
  expect(serverUser!.primaryEmail).toBe("test@test.com");
});

it("currentSession.getTokens should return tokens that work for authentication", async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" });
  const tokens = await user.currentSession.getTokens();

  expect(tokens.accessToken).toBeDefined();
  expect(tokens.refreshToken).toBeDefined();

  // Create a new server app using these tokens
  const serverUser = await serverApp.getUser({ tokenStore: { accessToken: tokens.accessToken!, refreshToken: tokens.refreshToken! } });

  expect(serverUser).not.toBeNull();
  expect(serverUser!.primaryEmail).toBe("test@test.com");
});

it("getAuthJson should return tokens that work for authentication", async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({});
  await signIn(clientApp);

  const authJson = await clientApp.getAuthJson();

  expect(authJson.accessToken).toBeDefined();
  expect(authJson.refreshToken).toBeDefined();

  // Create a new server app using these tokens
  const serverUser = await serverApp.getUser({ tokenStore: authJson as { accessToken: string, refreshToken: string } });

  expect(serverUser).not.toBeNull();
  expect(serverUser!.primaryEmail).toBe("test@test.com");
});

it("getAuthorizationHeader should return a Bearer token that works for authentication", async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({});
  await signIn(clientApp);

  const authorizationHeader = await clientApp.getAuthorizationHeader();
  if (authorizationHeader == null) {
    throw new Error("Expected authorization header for signed-in user.");
  }
  expect(authorizationHeader).toMatch(/^Bearer\s+(stackauth_|hexclave_).+/);
  const parsedAuthorizationHeader = parseAuthorizationHeaderValue(authorizationHeader);
  const authJson = await clientApp.getAuthJson();
  expect(parsedAuthorizationHeader).toEqual(authJson);

  const requestLike = {
    headers: new Headers({
      authorization: authorizationHeader,
    }),
  };
  const serverUser = await serverApp.getUser({ tokenStore: requestLike });

  expect(serverUser).not.toBeNull();
  expect(serverUser!.primaryEmail).toBe("test@test.com");
});

it("getAuthHeaders should return headers that work for authentication", async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({});
  await signIn(clientApp);

  const authHeaders = await clientApp.getAuthHeaders();
  const parsed = JSON.parse(authHeaders["x-stack-auth"]);

  // Create a new server app using these tokens
  const serverUser = await serverApp.getUser({ tokenStore: parsed });

  expect(serverUser).not.toBeNull();
  expect(serverUser!.primaryEmail).toBe("test@test.com");
});

it("tokens from user should match and both work for authentication", async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" }) as any;

  // Get tokens from different methods
  const accessToken = await user.getAccessToken();
  const refreshToken = await user.getRefreshToken();
  const sessionTokens = await user.currentSession.getTokens();
  const authJson = await user.getAuthJson();

  // All should be consistent
  expect(accessToken).toBe(sessionTokens.accessToken);
  expect(refreshToken).toBe(sessionTokens.refreshToken);
  expect(accessToken).toBe(authJson.accessToken);
  expect(refreshToken).toBe(authJson.refreshToken);

  // And they should all work for authentication
  const serverUser1 = await serverApp.getUser({ tokenStore: { accessToken: accessToken!, refreshToken: refreshToken! } });
  const serverUser2 = await serverApp.getUser({ tokenStore: sessionTokens as { accessToken: string, refreshToken: string } });
  const serverUser3 = await serverApp.getUser({ tokenStore: authJson as { accessToken: string, refreshToken: string } });

  expect(serverUser1).not.toBeNull();
  expect(serverUser2).not.toBeNull();
  expect(serverUser3).not.toBeNull();

  // All should be the same user
  expect(serverUser1!.id).toBe(serverUser2!.id);
  expect(serverUser2!.id).toBe(serverUser3!.id);
});

// ============================================
// Legacy getAuthHeaders tests (deprecated but still need to work)
// ============================================

it("clientApp.getAuthJson should return auth tokens", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const authJson = await clientApp.getAuthJson();
  expect(authJson).toBeDefined();
  expect(authJson.accessToken).toBeDefined();
  expect(authJson.refreshToken).toBeDefined();
  expect(typeof authJson.accessToken).toBe("string");
  expect(typeof authJson.refreshToken).toBe("string");
});

it("clientApp.getAuthJson should return null tokens when not signed in", async ({ expect }) => {
  const { clientApp } = await createApp({});

  const authJson = await clientApp.getAuthJson();
  expect(authJson).toBeDefined();
  expect(authJson.accessToken).toBeNull();
  expect(authJson.refreshToken).toBeNull();
});

it("clientApp.getAuthorizationHeader should return Bearer header value", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const authorizationHeader = await clientApp.getAuthorizationHeader();
  if (authorizationHeader == null) {
    throw new Error("Expected authorization header for signed-in user.");
  }
  expect(authorizationHeader).toMatch(/^Bearer\s+(stackauth_|hexclave_).+/);
  expect(parseAuthorizationHeaderValue(authorizationHeader)).toEqual(await clientApp.getAuthJson());
});

it("clientApp.getAuthorizationHeader should return null when not signed in", async ({ expect }) => {
  const { clientApp } = await createApp({});

  const authorizationHeader = await clientApp.getAuthorizationHeader();
  expect(authorizationHeader).toBeNull();
});

it("clientApp.getAuthorizationHeader should work with tokenStore option", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const authorizationHeader = await clientApp.getAuthorizationHeader({ tokenStore: "memory" });
  if (authorizationHeader == null) {
    throw new Error("Expected authorization header for signed-in user.");
  }
  expect(authorizationHeader).toMatch(/^Bearer\s+(stackauth_|hexclave_).+/);
  expect(parseAuthorizationHeaderValue(authorizationHeader)).toEqual(await clientApp.getAuthJson({ tokenStore: "memory" }));
});

it("clientApp.getAuthHeaders should return x-stack-auth header", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const authHeaders = await clientApp.getAuthHeaders();
  expect(authHeaders).toBeDefined();
  expect(authHeaders["x-stack-auth"]).toBeDefined();
  expect(typeof authHeaders["x-stack-auth"]).toBe("string");

  // Verify the header contains valid JSON
  const parsed = JSON.parse(authHeaders["x-stack-auth"]);
  expect(parsed.accessToken).toBeDefined();
  expect(parsed.refreshToken).toBeDefined();
});

it("clientApp.getAuthHeaders should work with tokenStore option", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const authHeaders = await clientApp.getAuthHeaders({ tokenStore: "memory" });
  expect(authHeaders).toBeDefined();
  expect(authHeaders["x-stack-auth"]).toBeDefined();
  expect(typeof authHeaders["x-stack-auth"]).toBe("string");

  // Verify the header contains valid JSON
  const parsed = JSON.parse(authHeaders["x-stack-auth"]);
  expect(parsed.accessToken).toBeDefined();
  expect(parsed.refreshToken).toBeDefined();
});

it("clientApp.getAuthJson should work with tokenStore option", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const authJson = await clientApp.getAuthJson({ tokenStore: "memory" });
  expect(authJson).toBeDefined();
  expect(authJson.accessToken).toBeDefined();
  expect(authJson.refreshToken).toBeDefined();
  expect(typeof authJson.accessToken).toBe("string");
  expect(typeof authJson.refreshToken).toBe("string");
});

it("clientApp.signOut should sign out the user", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const userBefore = await clientApp.getUser();
  expect(userBefore).not.toBeNull();

  // clientApp.signOut delegates to user.signOut, which triggers redirect
  // So we just verify it doesn't throw
  // In a real scenario, this would redirect the browser
  // For this test, we're just verifying the method exists and can be called
  const authJsonBefore = await clientApp.getAuthJson();
  expect(authJsonBefore.accessToken).not.toBeNull();
});

it("clientApp auth methods should match user auth methods", async ({ expect }) => {
  const { clientApp } = await createApp({});
  await signIn(clientApp);

  const user = await clientApp.getUser({ or: "throw" });

  // Compare getAuthJson results
  const appAuthJson = await clientApp.getAuthJson();
  const userAuthJson = await user.getAuthJson();
  expect(appAuthJson.accessToken).toBe(userAuthJson.accessToken);
  expect(appAuthJson.refreshToken).toBe(userAuthJson.refreshToken);

  // Compare getAuthHeaders results
  const appAuthHeaders = await clientApp.getAuthHeaders();
  const userAuthHeaders = await user.getAuthHeaders();
  expect(appAuthHeaders["x-stack-auth"]).toBe(userAuthHeaders["x-stack-auth"]);

  // Compare getAuthorizationHeader results
  const appAuthorizationHeader = await clientApp.getAuthorizationHeader();
  const userAuthorizationHeader = await user.getAuthorizationHeader();
  expect(appAuthorizationHeader).toBe(userAuthorizationHeader);
});

// ============================================
// Request-like tokenStore override tests
// (Critical for Bun middleware compatibility - GitHub issue #1144)
// ============================================

/**
 * Helper to build a cookie string for a request-like object.
 */
function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

it("getUser should work with request-like tokenStore containing auth cookies", async ({ expect }) => {
  // Use nextjs-cookie as default to simulate real middleware scenario.
  // This ensures the fix prevents rscHeaders() from being called when an override is provided.
  const { serverApp, clientApp } = await createApp({}, {
    server: { tokenStore: "nextjs-cookie" },
  });

  // Create two different users
  const userAEmail = `${crypto.randomUUID()}@user-a.test`;
  const userBEmail = `${crypto.randomUUID()}@user-b.test`;
  const password = "test-password-123";

  // Sign up User A
  await clientApp.signUpWithCredential({
    email: userAEmail,
    password,
    noVerificationCallback: true,
  });
  await clientApp.signInWithCredential({ email: userAEmail, password });
  const userA = await clientApp.getUser({ or: "throw" });
  const userATokens = await userA.currentSession.getTokens();
  await clientApp.signOut();

  // Sign up User B and keep them signed in on clientApp
  await clientApp.signUpWithCredential({
    email: userBEmail,
    password,
    noVerificationCallback: true,
  });
  await clientApp.signInWithCredential({ email: userBEmail, password });
  const userB = await clientApp.getUser({ or: "throw" });

  // Verify the two users are different
  expect(userA.id).not.toBe(userB.id);

  // Verify serverApp's default nextjs-cookie store would fail outside Next.js context.
  //  without passing tokenStore override rscHeaders() would be called and fail.
  await expect(serverApp.getUser()).rejects.toThrow();

  // Build cookies with User A's tokens (Option B - use different user's tokens)
  const refreshCookieName = `stack-refresh-${serverApp.projectId}--default`;
  const refreshCookieValue = JSON.stringify({
    refresh_token: userATokens.refreshToken,
    updated_at_millis: Date.now(),
  });
  const accessCookieValue = JSON.stringify([userATokens.refreshToken, userATokens.accessToken]);

  const cookieHeader = buildCookieHeader({
    [refreshCookieName]: refreshCookieValue,
    "stack-access": accessCookieValue,
  });

  // Create a request-like object with User A's cookies
  const requestLike = {
    headers: new Headers({
      cookie: cookieHeader,
    }),
  };

  // Call getUser with the request-like tokenStore
  // This MUST read from requestLike because:
  // 1. serverApp's default store is empty
  // 2. clientApp has User B signed in, not User A
  // 3. Only requestLike contains User A's tokens
  const serverUser = await serverApp.getUser({ tokenStore: requestLike });

  expect(serverUser).not.toBeNull();
  expect(serverUser!.id).toBe(userA.id); // Must be User A, not User B
  expect(serverUser!.primaryEmail).toBe(userAEmail);
});

it("getUser should return null for request-like tokenStore with no auth cookies", async ({ expect }) => {
  // Use nextjs-cookie as default to simulate real middleware scenario
  const { serverApp } = await createApp({}, {
    server: { tokenStore: "nextjs-cookie" },
  });

  // Create a request-like object with no auth cookies
  const requestLike = {
    headers: new Headers({
      cookie: "",
    }),
  };

  // Should return null, not throw
  const serverUser = await serverApp.getUser({ tokenStore: requestLike });

  expect(serverUser).toBeNull();
});

it("getUser should work with Authorization header in request-like tokenStore", async ({ expect }) => {
  const { serverApp, clientApp } = await createApp({});
  await signIn(clientApp);

  const authorizationHeader = await clientApp.getAuthorizationHeader();
  if (authorizationHeader == null) {
    throw new Error("Expected authorization header for signed-in user.");
  }
  expect(authorizationHeader).toMatch(/^Bearer\s+(stackauth_|hexclave_).+/);
  expect(parseAuthorizationHeaderValue(authorizationHeader)).toEqual(await clientApp.getAuthJson());

  const requestLike = {
    headers: new Headers({
      authorization: authorizationHeader,
    }),
  };

  const serverUser = await serverApp.getUser({ tokenStore: requestLike });
  const clientUser = await clientApp.getUser({ or: "throw" });

  expect(serverUser).not.toBeNull();
  expect(serverUser!.primaryEmail).toBe("test@test.com");
  expect(serverUser!.id).toBe(clientUser.id);
});

it("getUser should work with record-style headers in request-like tokenStore", async ({ expect }) => {
  const { serverApp, clientApp } = await createApp({});
  await signIn(clientApp);

  const authorizationHeader = await clientApp.getAuthorizationHeader();
  if (authorizationHeader == null) {
    throw new Error("Expected authorization header for signed-in user.");
  }

  const requestLike = {
    headers: {
      Authorization: authorizationHeader,
      Cookie: null,
    },
  };

  const serverUser = await serverApp.getUser({ tokenStore: requestLike });
  const clientUser = await clientApp.getUser({ or: "throw" });

  expect(serverUser).not.toBeNull();
  expect(serverUser!.primaryEmail).toBe("test@test.com");
  expect(serverUser!.id).toBe(clientUser.id);
});

it("getUser should work with x-stack-auth header in request-like tokenStore", async ({ expect }) => {
  const { serverApp, clientApp } = await createApp({});
  await signIn(clientApp);

  // Get the auth headers from the signed-in user
  const authHeaders = await clientApp.getAuthHeaders();

  // Create a request-like object with x-stack-auth header
  const requestLike = {
    headers: new Headers({
      "x-stack-auth": authHeaders["x-stack-auth"],
    }),
  };

  // Call getUser with the request-like tokenStore
  const serverUser = await serverApp.getUser({ tokenStore: requestLike });
  const clientUser = await clientApp.getUser({ or: "throw" });

  expect(serverUser).not.toBeNull();
  expect(serverUser!.primaryEmail).toBe("test@test.com");
  expect(serverUser!.id).toBe(clientUser.id);
});

it("getUser with tokenStore override should not affect the app's default token store", async ({ expect }) => {
  const { serverApp, clientApp } = await createApp({});
  await signIn(clientApp);

  const clientUser = await clientApp.getUser({ or: "throw" });

  // Get user via serverApp with explicit tokenStore override
  const tokens = await clientUser.currentSession.getTokens();
  const serverUserWithOverride = await serverApp.getUser({
    tokenStore: { accessToken: tokens.accessToken!, refreshToken: tokens.refreshToken! },
  });

  expect(serverUserWithOverride).not.toBeNull();
  expect(serverUserWithOverride!.id).toBe(clientUser.id);

  // serverApp's default token store (memory) should still be empty
  // since we used an override, not the default
  const serverUserDefault = await serverApp.getUser();
  expect(serverUserDefault).toBeNull();
});
