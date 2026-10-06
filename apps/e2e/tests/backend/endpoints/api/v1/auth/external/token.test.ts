import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import * as http from "node:http";
import { afterAll, beforeAll, describe } from "vitest";
import { it } from "../../../../../../helpers";
import { Auth, Project, backendContext, niceBackendFetch } from "../../../../../backend-helpers";

let jwksServer: http.Server;
let issuer: string;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let publicJwk: JWK;

beforeAll(async () => {
  const keyPair = await generateKeyPair("ES256");
  privateKey = keyPair.privateKey;
  publicJwk = {
    ...await exportJWK(keyPair.publicKey),
    alg: "ES256",
    kid: "external-auth-e2e",
    use: "sig",
  };

  jwksServer = http.createServer((request, response) => {
    if (request.url !== "/jwks" && request.url !== "/.well-known/jwks.json") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve, reject) => {
    jwksServer.once("error", reject);
    jwksServer.listen(0, "127.0.0.1", resolve);
  });
  const address = jwksServer.address();
  if (address == null || typeof address === "string") {
    throw new Error("Expected the external-auth JWKS test server to listen on a TCP port");
  }
  issuer = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close(error => error == null ? resolve() : reject(error));
  });
});

async function configureProject(options: { enabled?: boolean } = {}) {
  await Project.createAndSwitch();
  await Project.updateConfig({
    "apps.installed.better-auth-integration.enabled": options.enabled ?? true,
    "better-auth-integration.issuer": issuer,
    "better-auth-integration.audience": "hexclave-external-auth-e2e",
    "better-auth-integration.jwksUrl": new URL("/jwks", issuer).toString(),
  });
  backendContext.set({ userAuth: null });
}

async function createProviderToken(options: {
  subject?: string,
  sessionId?: string,
  issuer?: string,
  audience?: string,
  expirationTime?: string,
  authorizedParty?: string,
  email?: unknown,
  name?: unknown,
  emailVerified?: unknown,
} = {}) {
  return await new SignJWT({
    sid: options.sessionId ?? "provider-session-1",
    ...options.authorizedParty == null ? {} : { azp: options.authorizedParty },
    ...options.email === undefined ? {} : { email: options.email },
    ...options.name === undefined ? {} : { name: options.name },
    ...options.emailVerified === undefined ? {} : { email_verified: options.emailVerified },
  })
    .setProtectedHeader({ alg: "ES256", kid: publicJwk.kid ?? throwErr("Test JWK has no kid") })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? "hexclave-external-auth-e2e")
    .setSubject(options.subject ?? "external-user-1")
    .setIssuedAt()
    .setExpirationTime(options.expirationTime ?? "10m")
    .sign(privateKey);
}

async function exchange(token: string, providerId = "better-auth-integration") {
  return await niceBackendFetch("/api/latest/auth/external/token", {
    method: "POST",
    accessType: "client",
    body: {
      provider_id: providerId,
      token,
    },
  });
}

describe("external authentication token exchange", () => {
  it("creates one user and reuses provider sessions idempotently", async ({ expect }) => {
    await configureProject();
    const firstToken = await createProviderToken({
      email: "provider-user@example.com",
      name: "Provider User",
      emailVerified: false,
    });
    const first = await exchange(firstToken);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      is_new_user: true,
    });
    expect(first.body.user_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.body.session_id).toMatch(/^[0-9a-f-]{36}$/);

    const createdUser = await niceBackendFetch(`/api/v1/users/${first.body.user_id}`, {
      accessType: "server",
    });
    expect(createdUser.status).toBe(200);
    expect(createdUser.body).toMatchObject({
      primary_email: "provider-user@example.com",
      primary_email_verified: false,
      primary_email_auth_enabled: false,
      display_name: "Provider User",
      external_auth_providers: [{ id: "better-auth-integration" }],
    });

    backendContext.set({ userAuth: { accessToken: first.body.access_token } });
    const currentUser = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
    });
    expect(currentUser.status).toBe(200);
    expect(currentUser.body).toMatchObject({
      external_auth_providers: [{ id: "better-auth-integration" }],
    });

    const repeated = await exchange(firstToken);
    expect(repeated.status).toBe(200);
    expect(repeated.body).toMatchObject({
      is_new_user: false,
      user_id: first.body.user_id,
      session_id: first.body.session_id,
    });

    const secondSession = await exchange(await createProviderToken({ sessionId: "provider-session-2" }));
    expect(secondSession.status).toBe(200);
    expect(secondSession.body.user_id).toBe(first.body.user_id);
    expect(secondSession.body.session_id).not.toBe(first.body.session_id);

    backendContext.set({ userAuth: { accessToken: secondSession.body.access_token } });
    const sessions = await niceBackendFetch("/api/v1/auth/sessions", {
      method: "GET",
      accessType: "client",
      query: {
        user_id: first.body.user_id,
      },
    });
    expect(sessions.status).toBe(200);
    expect(sessions.body.items).toHaveLength(2);
    expect(sessions.body.items.filter((session: { is_current_session: boolean }) => session.is_current_session)).toHaveLength(1);
  });

  it("re-establishes an external session after either kind of Hexclave revocation", async ({ expect }) => {
    await configureProject();
    const providerToken = await createProviderToken({
      sessionId: "provider-session-revocation",
      email: "revocation@example.com",
      name: "Revocation User",
    });
    const first = await exchange(providerToken);
    expect(first.status).toBe(200);

    backendContext.set({ userAuth: { accessToken: first.body.access_token } });
    const signOut = await niceBackendFetch("/api/v1/auth/sessions/current", {
      method: "DELETE",
      accessType: "client",
    });
    expect(signOut.status).toBe(200);

    const afterSignOut = await exchange(providerToken);
    expect(afterSignOut.status).toBe(200);
    expect(afterSignOut.body).toMatchObject({
      user_id: first.body.user_id,
      session_id: first.body.session_id,
    });

    backendContext.set({ userAuth: { accessToken: afterSignOut.body.access_token } });
    const sessionsAfterSignOut = await niceBackendFetch("/api/v1/auth/sessions", {
      method: "GET",
      accessType: "client",
      query: { user_id: first.body.user_id },
    });
    expect(sessionsAfterSignOut.status).toBe(200);
    expect(sessionsAfterSignOut.body.items).toHaveLength(1);
    expect(sessionsAfterSignOut.body.items[0]).toMatchObject({
      id: first.body.session_id,
      is_current_session: true,
    });

    const second = await exchange(await createProviderToken({
      sessionId: "provider-session-revocation-crud",
    }));
    expect(second.status).toBe(200);
    backendContext.set({ userAuth: { accessToken: second.body.access_token } });
    const sessionsBeforeDelete = await niceBackendFetch("/api/v1/auth/sessions", {
      method: "GET",
      accessType: "client",
      query: { user_id: first.body.user_id },
    });
    expect(sessionsBeforeDelete.status).toBe(200);
    const secondSession = sessionsBeforeDelete.body.items.find((session: { id: string }) => session.id === second.body.session_id);
    expect(secondSession).toBeDefined();

    const deleteSession = await niceBackendFetch(`/api/v1/auth/sessions/${second.body.session_id}`, {
      method: "DELETE",
      accessType: "client",
      query: { user_id: first.body.user_id },
    });
    expect(deleteSession.status).toBe(200);

    const afterCrudDelete = await exchange(await createProviderToken({
      sessionId: "provider-session-revocation-crud",
    }));
    expect(afterCrudDelete.status).toBe(200);
    expect(afterCrudDelete.body).toMatchObject({
      user_id: first.body.user_id,
      session_id: second.body.session_id,
    });
    backendContext.set({ userAuth: { accessToken: afterCrudDelete.body.access_token } });
    const sessionsAfterCrudDelete = await niceBackendFetch("/api/v1/auth/sessions", {
      method: "GET",
      accessType: "client",
      query: { user_id: first.body.user_id },
    });
    expect(sessionsAfterCrudDelete.status).toBe(200);
    expect(sessionsAfterCrudDelete.body.items).toContainEqual(expect.objectContaining({
      id: second.body.session_id,
      is_current_session: true,
    }));
  });

  it("does not overwrite a profile edited after the first exchange", async ({ expect }) => {
    await configureProject();
    const first = await exchange(await createProviderToken({
      email: "original@example.com",
      name: "Original Name",
      emailVerified: true,
    }));
    expect(first.status).toBe(200);

    const updated = await niceBackendFetch(`/api/v1/users/${first.body.user_id}`, {
      method: "PATCH",
      accessType: "server",
      body: {
        primary_email: "edited@example.com",
        display_name: "Edited Name",
        primary_email_verified: true,
        primary_email_auth_enabled: false,
      },
    });
    expect(updated.status).toBe(200);

    const repeated = await exchange(await createProviderToken({
      email: "provider-update@example.com",
      name: "Provider Update",
      emailVerified: false,
    }));
    expect(repeated.status).toBe(200);
    expect(repeated.body.user_id).toBe(first.body.user_id);

    const user = await niceBackendFetch(`/api/v1/users/${first.body.user_id}`, {
      accessType: "server",
    });
    expect(user.body).toMatchObject({
      primary_email: "edited@example.com",
      display_name: "Edited Name",
    });
  });

  it("preserves an anonymous profile when provider claims are absent", async ({ expect }) => {
    await configureProject();
    const anonymous = await Auth.Anonymous.signUp();
    const updated = await niceBackendFetch("/api/v1/users/me", {
      method: "PATCH",
      accessType: "client",
      body: {
        display_name: "Anonymous Name",
        primary_email: "anonymous@example.com",
      },
    });
    expect(updated.status).toBe(200);

    const response = await exchange(await createProviderToken(), "better-auth-integration");
    expect(response.status).toBe(200);
    expect(response.body.user_id).toBe(anonymous.userId);

    const user = await niceBackendFetch(`/api/v1/users/${anonymous.userId}`, {
      accessType: "server",
    });
    expect(user.body).toMatchObject({
      display_name: "Anonymous Name",
      primary_email: "anonymous@example.com",
      primary_email_auth_enabled: false,
    });
  });

  it("maps provider claims when upgrading an anonymous user", async ({ expect }) => {
    await configureProject();
    const anonymous = await Auth.Anonymous.signUp();
    const response = await exchange(await createProviderToken({
      email: "upgraded@example.com",
      name: "Upgraded Provider User",
      emailVerified: true,
    }));
    expect(response.status).toBe(200);
    expect(response.body.user_id).toBe(anonymous.userId);

    const user = await niceBackendFetch(`/api/v1/users/${anonymous.userId}`, {
      accessType: "server",
    });
    expect(user.body).toMatchObject({
      display_name: "Upgraded Provider User",
      primary_email: "upgraded@example.com",
      primary_email_verified: true,
      primary_email_auth_enabled: false,
    });
  });

  it("ignores malformed or absent profile claims", async ({ expect }) => {
    await configureProject();
    const response = await exchange(await createProviderToken({
      email: "   ",
      name: "n".repeat(257),
      emailVerified: "true",
    }));
    expect(response.status).toBe(200);

    const user = await niceBackendFetch(`/api/v1/users/${response.body.user_id}`, {
      accessType: "server",
    });
    expect(user.body).toMatchObject({
      primary_email: null,
      display_name: null,
      primary_email_verified: false,
      primary_email_auth_enabled: false,
    });
  });

  it("ignores syntactically invalid email claims", async ({ expect }) => {
    await configureProject();
    const response = await exchange(await createProviderToken({
      email: "not-an-email",
      name: "Valid Name",
      emailVerified: true,
    }));
    expect(response.status).toBe(200);

    const user = await niceBackendFetch(`/api/v1/users/${response.body.user_id}`, {
      accessType: "server",
    });
    expect(user.body).toMatchObject({
      primary_email: null,
      display_name: "Valid Name",
      primary_email_verified: false,
    });
  });

  it("ignores email_verified when the email claim is absent or invalid", async ({ expect }) => {
    await configureProject();
    const absentEmail = await exchange(await createProviderToken({
      emailVerified: true,
    }));
    const invalidEmail = await exchange(await createProviderToken({
      subject: "invalid-email-user",
      sessionId: "invalid-email-session",
      email: "not-an-email",
      emailVerified: true,
    }));

    expect(absentEmail.status).toBe(200);
    expect(invalidEmail.status).toBe(200);

    const users = await Promise.all([
      niceBackendFetch(`/api/v1/users/${absentEmail.body.user_id}`, { accessType: "server" }),
      niceBackendFetch(`/api/v1/users/${invalidEmail.body.user_id}`, { accessType: "server" }),
    ]);
    expect(users[0].body).toMatchObject({
      primary_email: null,
      primary_email_verified: false,
    });
    expect(users[1].body).toMatchObject({
      primary_email: null,
      primary_email_verified: false,
    });
  });

  it("allows a provider email to collide with another user", async ({ expect }) => {
    await configureProject();
    const first = await exchange(await createProviderToken({
      subject: "provider-user-1",
      sessionId: "provider-session-1",
      email: "same@example.com",
      name: "First Provider User",
    }));
    const second = await exchange(await createProviderToken({
      subject: "provider-user-2",
      sessionId: "provider-session-2",
      email: "same@example.com",
      name: "Second Provider User",
    }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.user_id).not.toBe(first.body.user_id);
  });

  it("projects a new external identity once under concurrent exchanges", async ({ expect }) => {
    await configureProject();
    const token = await createProviderToken();
    const responses = await Promise.all(Array.from({ length: 4 }, async () => await exchange(token)));

    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200]);
    expect([...new Set(responses.map(response => response.body.user_id))]).toHaveLength(1);
    expect([...new Set(responses.map(response => response.body.session_id))]).toHaveLength(1);
    expect(responses.filter(response => response.body.is_new_user)).toHaveLength(1);

    // Losing racers create a user before discovering the identity was already projected; that user
    // must be cleaned up again, so exactly one user may remain in the project.
    const users = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
    });
    expect(users.status).toBe(200);
    expect(users.body.items).toHaveLength(1);
    expect(users.body.items[0].id).toBe(responses[0].body.user_id);
  });

  it("rejects malformed and claim-invalid provider tokens", async ({ expect }) => {
    await configureProject();

    for (const [token, reason] of [
      ["not-a-jwt", "malformed_token"],
      [await createProviderToken({ issuer: "https://wrong-issuer.example.com" }), "issuer_mismatch"],
      [await createProviderToken({ audience: "wrong-audience" }), "audience_mismatch"],
      [await createProviderToken({ expirationTime: "-1s" }), "expired"],
    ] as const) {
      const response = await exchange(token);
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("INVALID_EXTERNAL_AUTH_TOKEN");
      expect(response.body.details).toMatchObject({ reason });
    }
  });

  it("enforces Clerk authorized parties even when azp is absent", async ({ expect }) => {
    await Project.createAndSwitch();
    await Project.updateConfig({
      "apps.installed.clerk-integration.enabled": true,
      "clerk-integration.issuer": issuer,
      "clerk-integration.authorizedParties": "https://app.example.com",
    });
    backendContext.set({ userAuth: null });

    const missingAuthorizedParty = await exchange(await createProviderToken(), "clerk-integration");
    expect(missingAuthorizedParty.status).toBe(401);
    expect(missingAuthorizedParty.body.code).toBe("INVALID_EXTERNAL_AUTH_TOKEN");
    expect(missingAuthorizedParty.body.details).toMatchObject({ reason: "authorized_party_mismatch" });

    const allowed = await exchange(await createProviderToken({
      authorizedParty: "https://app.example.com",
    }), "clerk-integration");
    expect(allowed.status).toBe(200);
  });

  it("normalizes configured Clerk authorized parties to their origin", async ({ expect }) => {
    await Project.createAndSwitch();
    await Project.updateConfig({
      "apps.installed.clerk-integration.enabled": true,
      "clerk-integration.issuer": issuer,
      // A trailing slash (or path) in the dashboard config is cosmetic; the azp claim always
      // contains a bare origin, so the comparison must be origin-to-origin.
      "clerk-integration.authorizedParties": "https://app.example.com/some/path",
    });
    backendContext.set({ userAuth: null });

    const allowed = await exchange(await createProviderToken({
      authorizedParty: "https://app.example.com",
    }), "clerk-integration");
    expect(allowed.status).toBe(200);

    const rejected = await exchange(await createProviderToken({
      authorizedParty: "https://evil.example.com",
    }), "clerk-integration");
    expect(rejected.status).toBe(401);
    expect(rejected.body.code).toBe("INVALID_EXTERNAL_AUTH_TOKEN");
  });

  it("requires the integration app to be enabled", async ({ expect }) => {
    await configureProject({ enabled: false });
    const response = await exchange(await createProviderToken());
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("EXTERNAL_AUTH_PROVIDER_NOT_CONFIGURED");
  });

  // The WorkOS verifier always fetches signing keys from api.workos.com (only the issuer can be
  // overridden), so a token signed by this file's local JWKS server can never verify. These tests
  // therefore only cover the configuration gates, which are rejected before any network access.
  it("requires the WorkOS integration app to be enabled", async ({ expect }) => {
    await Project.createAndSwitch();
    await Project.updateConfig({
      "apps.installed.workos-integration.enabled": false,
      "workos-integration.clientId": "client_e2e",
    });
    backendContext.set({ userAuth: null });

    const response = await exchange(await createProviderToken(), "workos-integration");
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("EXTERNAL_AUTH_PROVIDER_NOT_CONFIGURED");
    expect(response.body.details).toMatchObject({ reason: "provider_disabled" });
  });

  it("requires a WorkOS client ID once the WorkOS integration app is enabled", async ({ expect }) => {
    await Project.createAndSwitch();
    await Project.updateConfig({
      "apps.installed.workos-integration.enabled": true,
    });
    backendContext.set({ userAuth: null });

    const response = await exchange(await createProviderToken(), "workos-integration");
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("EXTERNAL_AUTH_PROVIDER_NOT_CONFIGURED");
    expect(response.body.details).toMatchObject({ reason: "required_setting_missing" });
  });
});
