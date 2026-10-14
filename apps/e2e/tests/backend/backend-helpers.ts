import type { ProjectConfigOverride } from "@hexclave/shared/dist/config/schema";
import { AdminUserProjectsCrud } from "@hexclave/shared/dist/interface/crud/projects";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { getJwtInfo } from "@hexclave/shared/dist/utils/jwt";
import { publishableClientKeyNotNecessarySentinel } from "@hexclave/shared/dist/utils/oauth";
import { filterUndefined, omit } from "@hexclave/shared/dist/utils/objects";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { nicify } from "@hexclave/shared/dist/utils/strings";
import * as jose from "jose";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { expect } from "vitest";
import { Context, Mailbox, NiceRequestInit, NiceResponse, STACK_BACKEND_BASE_URL, STACK_INTERNAL_PROJECT_ADMIN_KEY, STACK_INTERNAL_PROJECT_CLIENT_KEY, STACK_INTERNAL_PROJECT_ID, STACK_INTERNAL_PROJECT_SERVER_KEY, STACK_SVIX_SERVER_URL, generatedEmailSuffix, localRedirectUrl, niceFetch, updateCookiesFromResponse } from "../helpers";
import { localhostUrl, withPortPrefix } from "../helpers/ports";

type BackendContext = {
  readonly projectKeys: ProjectKeys,
  readonly defaultProjectKeys: ProjectKeys,
  readonly currentBranchId: string | null,
  readonly mailbox: Mailbox,
  readonly userAuth: {
    readonly refreshToken?: string,
    readonly accessToken?: string,
  } | null,
  readonly ipData?: {
    readonly ipAddress: string,
    readonly country: string,
    readonly city: string,
    readonly region: string,
    readonly latitude: number,
    readonly longitude: number,
    readonly tzIdentifier: string,
  },
  readonly generatedMailboxNamesCount: number,
};

export const backendContext = new Context<BackendContext, Partial<BackendContext>>(
  () => ({
    defaultProjectKeys: InternalProjectKeys,
    projectKeys: InternalProjectKeys,
    currentBranchId: null,
    mailbox: createMailbox(`default-mailbox--${randomUUID()}${generatedEmailSuffix}`),
    generatedMailboxNamesCount: 0,
    userAuth: null,
    ipData: undefined,
  }),
  (acc, update) => {
    if ("defaultProjectKeys" in update) {
      throw new HexclaveAssertionError("Cannot set defaultProjectKeys");
    }
    if ("mailbox" in update && !(update.mailbox instanceof Mailbox)) {
      throw new HexclaveAssertionError("Must create a mailbox with createMailbox()!");
    }
    return {
      ...acc,
      ...update,
    };
  },
);

export function createMailbox(email?: string): Mailbox {
  if (email === undefined) {
    backendContext.set({ generatedMailboxNamesCount: backendContext.value.generatedMailboxNamesCount + 1 });
    email = `mailbox-${backendContext.value.generatedMailboxNamesCount}--${randomUUID()}${generatedEmailSuffix}`;
  }
  if (!email.includes("@")) throw new HexclaveAssertionError(`Invalid mailbox email: ${email}`);
  return new Mailbox("(we can ignore the disclaimer here)" as any, email);
}

export type ProjectKeys = "no-project" | {
  projectId: string,
  branchId?: string,
  publishableClientKey?: string,
  secretServerKey?: string,
  superSecretAdminKey?: string,
  adminAccessToken?: string,
};

export const InternalProjectKeys = Object.freeze({
  projectId: STACK_INTERNAL_PROJECT_ID,
  publishableClientKey: STACK_INTERNAL_PROJECT_CLIENT_KEY,
  secretServerKey: STACK_INTERNAL_PROJECT_SERVER_KEY,
  superSecretAdminKey: STACK_INTERNAL_PROJECT_ADMIN_KEY,
});

export async function withInternalProject<T>(fn: () => Promise<T>): Promise<T> {
  return await backendContext.with({ projectKeys: InternalProjectKeys, userAuth: null }, fn);
}

/**
 * Team that owns the internal project, mirroring `internalTeamId` in `apps/backend/prisma/seed.ts`.
 *
 * Platform-wide endpoints authorize on membership of this team (see `isPlatformAdmin` on the backend),
 * not on merely holding an internal-project session — the internal publishable key is public, so any
 * signed-in internal user would otherwise qualify. Tests that need a platform admin must therefore join
 * the seeded team rather than just signing up.
 */
export const INTERNAL_PROJECT_OWNER_TEAM_ID = "a23e1b7f-ab18-41fc-9ee6-7a9ca9fa543c";

export const InternalProjectClientKeys = Object.freeze({
  projectId: STACK_INTERNAL_PROJECT_ID,
  publishableClientKey: STACK_INTERNAL_PROJECT_CLIENT_KEY,
});

// These prefixes must match getMockTurnstileVerificationResponse in apps/mock-oauth-server/src/index.ts
export const mockTurnstileTokens = Object.freeze({
  signUpOk: "mock-turnstile-ok:sign_up_with_credential",
  magicLinkOk: "mock-turnstile-ok:send_magic_link_email",
  oauthOk: "mock-turnstile-ok:oauth_authenticate",
  invalid: "mock-turnstile-invalid",
  error: "mock-turnstile-error",
  visibleSignUpOk: "mock-turnstile-visible-ok:sign_up_with_credential",
  visibleMagicLinkOk: "mock-turnstile-visible-ok:send_magic_link_email",
  visibleOAuthOk: "mock-turnstile-visible-ok:oauth_authenticate",
});

type TurnstileTestOptions = {
  turnstileToken?: string,
  turnstilePhase?: "invisible" | "visible",
};

function expectSnakeCase(obj: unknown, path: string): void {
  if (typeof obj !== "object" || obj === null) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      expectSnakeCase(obj[i], `${path}[${i}]`);
    }
  } else {
    for (const [key, value] of Object.entries(obj)) {
      if (key.match(/^[a-z0-9][A-Z][a-z0-9]+$/) && !key.includes("_") && !["newUser", "afterCallbackRedirectUrl"].includes(key)) {
        throw new HexclaveAssertionError(`Object has camelCase key (expected snake_case): ${path}.${key}`);
      }
      if (["client_metadata", "server_metadata", "options_json", "credential", "authentication_response", "metadata", "variables", "skipped_details"].includes(key)) continue;
      // because email templates
      if (path === "req.body.content.root") continue;
      if (path === "res.body.content.root") continue;
      expectSnakeCase(value, `${path}.${key}`);
    }
  }
}

export async function niceBackendFetch(url: string | URL, options?: Omit<NiceRequestInit, "body" | "headers"> & {
  accessType?: null | "client" | "server" | "admin",
  body?: unknown,
  rawBody?: Uint8Array,
  rawContentType?: string,
  headers?: Record<string, string | undefined>,
  omitPublishableClientKey?: boolean,
  userAuth?: {
    accessToken?: string,
    refreshToken?: string,
  },
}): Promise<NiceResponse> {
  const { body, rawBody, rawContentType, headers, accessType, omitPublishableClientKey, userAuth: userAuthOverride, ...otherOptions } = options ?? {};
  if (body !== undefined && rawBody !== undefined) {
    throw new HexclaveAssertionError("niceBackendFetch: pass either body or rawBody, not both");
  }
  if (rawContentType !== undefined && rawBody === undefined) {
    throw new HexclaveAssertionError("niceBackendFetch: rawContentType only makes sense with rawBody");
  }
  if (typeof body === "object") {
    expectSnakeCase(body, "req.body");
  }
  const projectKeys = backendContext.value.projectKeys;
  let userAuth = userAuthOverride ?? backendContext.value.userAuth;
  // Access tokens live for only 60s in dev/CI (HEXCLAVE_ACCESS_TOKEN_EXPIRATION_TIME), and every request we send carries
  // the context user's access token, even server-access ones. So any test that spends more than a minute between signing a
  // user up and its next request fails with ACCESS_TOKEN_EXPIRED, no matter which access type it uses. Refresh the token
  // the way a real client would instead. Tests that want to observe an expired token can pass an explicit `userAuth`
  // (skipped below) or leave the refresh token unset.
  if (userAuthOverride === undefined && projectKeys !== "no-project" && userAuth?.accessToken && userAuth.refreshToken) {
    const jwtInfo = await getJwtInfo({ jwt: userAuth.accessToken });
    const expiresAt = jwtInfo.status === "ok" && typeof jwtInfo.data.payload.exp === "number"
      ? jwtInfo.data.payload.exp * 1000
      : undefined;
    if (expiresAt !== undefined && expiresAt <= Date.now() + 5_000) {
      const refreshResponse = await niceBackendFetch("/api/v1/auth/sessions/current/refresh", {
        method: "POST",
        accessType: "client",
        userAuth: {
          refreshToken: userAuth.refreshToken,
        },
      });
      if (refreshResponse.status === 200 && typeof refreshResponse.body === "object" && refreshResponse.body !== null && "access_token" in refreshResponse.body && typeof refreshResponse.body.access_token === "string") {
        userAuth = {
          ...userAuth,
          accessToken: refreshResponse.body.access_token,
        };
        backendContext.set({ userAuth });
      }
    }
  }
  const fullUrl = new URL(url, STACK_BACKEND_BASE_URL);
  if (fullUrl.origin !== new URL(STACK_BACKEND_BASE_URL).origin) throw new HexclaveAssertionError(`Invalid niceBackendFetch origin: ${fullUrl.origin}`);
  if (fullUrl.protocol !== new URL(STACK_BACKEND_BASE_URL).protocol) throw new HexclaveAssertionError(`Invalid niceBackendFetch protocol: ${fullUrl.protocol}`);
  const res = await niceFetch(fullUrl, {
    ...otherOptions,
    ...body !== undefined ? { body: JSON.stringify(body) } : {},
    ...rawBody !== undefined ? { body: rawBody as BodyInit } : {},
    headers: filterUndefined({
      "content-type": rawBody !== undefined
        ? (rawContentType ?? "application/octet-stream")
        : body !== undefined ? "application/json" : undefined,
      "x-stack-access-type": accessType ?? undefined,
      ...projectKeys !== "no-project" && accessType ? {
        "x-stack-project-id": projectKeys.projectId,
        "x-stack-publishable-client-key": omitPublishableClientKey ? undefined : projectKeys.publishableClientKey,
        "x-stack-secret-server-key": projectKeys.secretServerKey,
        "x-stack-super-secret-admin-key": projectKeys.superSecretAdminKey,
        'x-stack-admin-access-token': projectKeys.adminAccessToken,
      } : {},
      "x-stack-branch-id": backendContext.value.currentBranchId ?? undefined,
      "x-stack-access-token": userAuth?.accessToken,
      "x-stack-refresh-token": userAuth?.refreshToken,
      "x-stack-allow-anonymous-user": "true",
      ...backendContext.value.ipData ? {
        "user-agent": "Mozilla/5.0",  // pretend to be a browser so our IP gets tracked
        "x-forwarded-for": backendContext.value.ipData.ipAddress,
        "cf-connecting-ip": backendContext.value.ipData.ipAddress,
        "x-vercel-ip-country": backendContext.value.ipData.country,
        "cf-ipcountry": backendContext.value.ipData.country,
        "x-vercel-ip-country-region": backendContext.value.ipData.region,
        "x-vercel-ip-city": backendContext.value.ipData.city,
        "x-vercel-ip-latitude": backendContext.value.ipData.latitude.toString(),
        "x-vercel-ip-longitude": backendContext.value.ipData.longitude.toString(),
        "x-vercel-ip-timezone": backendContext.value.ipData.tzIdentifier,
      } : {},
      ...Object.fromEntries(new Headers(filterUndefined(headers ?? {}) as any).entries()),
    }),
  });
  if (res.status >= 500 && res.status < 600) {
    throw new HexclaveAssertionError(`API threw ISE in ${otherOptions.method ?? "GET"} ${url}: ${res.status} ${typeof res.body === "string" ? res.body : nicify(res.body)}`);
  }
  if (res.headers.has("x-stack-known-error")) {
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body).toMatchObject({
      code: res.headers.get("x-stack-known-error"),
    });
  }
  if (typeof res.body === "object" && res.body) {
    expectSnakeCase(res.body, "res.body");
  }
  return res;
}

export async function niceInternalToolFetch(url: string | URL, options?: Omit<NiceRequestInit, "body" | "headers"> & {
  body?: unknown,
  headers?: Record<string, string | undefined>,
}): Promise<NiceResponse> {
  const { body, headers, ...otherOptions } = options ?? {};
  const fullUrl = new URL(url, localhostUrl("41"));
  if (fullUrl.origin !== new URL(localhostUrl("41")).origin) {
    throw new HexclaveAssertionError(`Invalid niceInternalToolFetch origin: ${fullUrl.origin}`);
  }
  const userAuth = backendContext.value.userAuth;
  return await niceFetch(fullUrl, {
    ...otherOptions,
    ...body !== undefined ? { body: JSON.stringify(body) } : {},
    headers: filterUndefined({
      "content-type": body !== undefined ? "application/json" : undefined,
      "x-stack-auth": JSON.stringify({
        accessToken: userAuth?.accessToken ?? null,
        refreshToken: userAuth?.refreshToken ?? null,
      }),
      ...headers,
    }),
  });
}


/**
 * Creates a new mailbox with a different email address, and sets it as the current mailbox.
 */
export async function bumpEmailAddress(options: { unindexed?: boolean } = {}) {
  let emailAddress = undefined;
  if (options.unindexed) {
    emailAddress = `unindexed-mailbox--${randomUUID()}${generatedEmailSuffix}`;
  }
  const mailbox = createMailbox(emailAddress);
  backendContext.set({ mailbox });
  return mailbox;
}

// Type for outbox email items (simplified - full type is EmailOutboxCrud["Server"]["Read"])
export type OutboxEmail = {
  id: string,
  subject?: string,
  status: string,
  simple_status: string,
  to?: {
    type: string,
    user_id?: string,
    [key: string]: unknown,
  },
  [key: string]: unknown,
};

// Helper to get emails from the outbox, filtered by subject if provided
export async function getOutboxEmails(options?: { subject?: string }): Promise<OutboxEmail[]> {
  const listResponse = await niceBackendFetch("/api/v1/emails/outbox", {
    method: "GET",
    accessType: "server",
  });
  const items = listResponse.body.items as OutboxEmail[];
  if (options?.subject) {
    return items.filter((e) => e.subject === options.subject);
  }
  return items;
}

// Helper to poll the outbox until the most recent email with the expected subject has the expected status.
// Note: emails are returned ordered by createdAt desc (newest first), so we check emails[0] specifically
// to ensure we're waiting for the MOST RECENT email, not an older one with the same subject.
export async function waitForOutboxEmailWithStatus(subject: string, status: string): Promise<OutboxEmail[]> {
  const maxRetries = 24;
  let emails: OutboxEmail[] = [];
  for (let i = 0; i < maxRetries; i++) {
    emails = await getOutboxEmails({ subject });
    // Check the most recent email (first in the list due to createdAt desc ordering)
    if (emails.length > 0 && emails[0].status === status) {
      return emails;
    }
    await wait(500);
  }
  throw new HexclaveAssertionError(
    `Timeout waiting for outbox email with subject "${subject}" and status "${status}"`,
    { foundEmails: emails }
  );
}

export namespace Auth {
  export async function fastSignUp(body: any = {}) {
    const { userId } = await User.create(body);
    const sessionResponse = await niceBackendFetch(`/api/v1/auth/sessions`, {
      method: "POST",
      accessType: "server",
      body: {
        user_id: userId,
        expires_in_millis: 1000 * 60 * 60 * 24 * 365,
        is_impersonation: false,
      },
    });
    expect(sessionResponse).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "access_token": <stripped field 'access_token'>,
          "refresh_token": <stripped field 'refresh_token'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    backendContext.set({ userAuth: { accessToken: sessionResponse.body.access_token, refreshToken: sessionResponse.body.refresh_token } });
    return {
      userId,
      accessToken: sessionResponse.body.access_token,
      refreshToken: sessionResponse.body.refresh_token,
    };
  }

  export async function fastSignUpWithEmail(email = backendContext.value.mailbox.emailAddress) {
    return await fastSignUp({
      primary_email: email,
      primary_email_verified: true,
    });
  }

  export async function ensureParsableAccessToken() {
    const accessToken = backendContext.value.userAuth?.accessToken;
    if (accessToken) {
      const aud = jose.decodeJwt(accessToken).aud;
      const jwks = jose.createRemoteJWKSet(
        new URL(`api/v1/projects/${aud}/.well-known/jwks.json`, STACK_BACKEND_BASE_URL),
        { timeoutDuration: 20_000 },
      );
      const expectedIssuer = new URL(`/api/v1/projects/${aud}`, STACK_BACKEND_BASE_URL).toString();
      const { payload } = await jose.jwtVerify(accessToken, jwks);
      expect(payload).toEqual({
        "exp": expect.any(Number),
        "iat": expect.any(Number),
        "iss": expectedIssuer,
        "branch_id": "main",
        "refresh_token_id": expect.any(String),
        "signed_up_at": expect.any(Number),
        "requires_totp_mfa": expect.any(Boolean),
        "aud": backendContext.value.projectKeys === "no-project" ? expect.any(String) : backendContext.value.projectKeys.projectId,
        "sub": expect.any(String),
        "role": "authenticated",
        "name": expect.toSatisfy(() => true),
        "email": expect.toSatisfy(() => true),
        "email_verified": expect.any(Boolean),
        "selected_team_id": expect.toSatisfy(() => true),
        "is_anonymous": expect.any(Boolean),
        "is_restricted": expect.any(Boolean),
        "restricted_reason": expect.toSatisfy(() => true),
        "project_id": payload.aud
      });
    }
  }

  export async function refreshAccessToken() {
    const response = await niceBackendFetch("/api/v1/auth/sessions/current/refresh", {
      method: "POST",
      accessType: "client",
      userAuth: {
        refreshToken: backendContext.value.userAuth?.refreshToken,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "access_token": <stripped field 'access_token'> },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    backendContext.set({ userAuth: { accessToken: response.body.access_token, refreshToken: response.body.refresh_token } });
    return {
      refreshAccessTokenResponse: response,
    };
  }

  /**
   * Valid session & valid access token: OK
   * Valid session & invalid access token: OK
   * Invalid session & valid access token: Error
   * Invalid session & invalid access token: Error
   */
  export async function expectSessionToBeValid() {
    const response = await niceBackendFetch("/api/v1/auth/sessions/current/refresh", { method: "POST", accessType: "client" });
    if (response.status !== 200) {
      throw new HexclaveAssertionError("Expected session to be valid, but was actually invalid.", { response });
    }
    expect(response).toMatchObject({
      status: 200,
      headers: expect.objectContaining({}),
      body: expect.objectContaining({}),
    });
  }

  /**
   * Valid session & valid access token: Error
   * Valid session & invalid access token: Error
   * Invalid session & valid access token: OK
   * Invalid session & invalid access token: OK
   */
  export async function expectSessionToBeInvalid() {
    const response = await niceBackendFetch("/api/v1/auth/sessions/current/refresh", { method: "POST", accessType: "client" });
    expect(response.status).not.toEqual(200);
  }

  /**
   * Valid session & valid access token: OK
   * Valid session & invalid access token: Error
   * Invalid session & valid access token: OK
   * Invalid session & invalid access token: Error
   */
  export async function expectAccessTokenToBeInvalid() {
    await ensureParsableAccessToken();
    const response = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
    if (response.status === 200) {
      throw new HexclaveAssertionError("Expected access token to be invalid, but was actually valid.", { response });
    }
  }

  /**
   * Valid session & valid access token: OK
   * Valid session & invalid access token: Error
   * Invalid session & valid access token: OK
   * Invalid session & invalid access token: Error
   */
  export async function expectAccessTokenToBeValid() {
    await ensureParsableAccessToken();
    const response = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
    if (response.status !== 200) {
      throw new HexclaveAssertionError("Expected access token to be valid, but was actually invalid.", { response });
    }
  }

  /**
   * Valid session & valid access token: OK
   * Valid session & invalid access token: Error
   * Invalid session & valid access token: Error
   * Invalid session & invalid access token: Error
   *
   * (see comment in the function for rationale, and why "invalid refresh token but valid access token" is not
   * considered "signed in")
   */
  export async function expectToBeSignedIn() {
    // there is a world where we would accept either access token OR session to be "signed in", instead of both
    // however, it's better to be strict and throw an error if either is invalid; this helps catch bugs
    // if you really want to check only one of them, use expectSessionToBeValid or expectAccessTokenToBeValid
    // for more information, see the comment in expectToBeSignedOut
    await Auth.expectAccessTokenToBeValid();
    await Auth.expectSessionToBeValid();
  }

  /**
   * Valid session & valid access token: Error
   * Valid session & invalid access token: Error
   * Invalid session & valid access token: Error
   * Invalid session & invalid access token: OK
   */
  export async function expectToBeSignedOut() {
    await Auth.expectAccessTokenToBeInvalid();

    // usually, when we mean "signed out" we mean "both access token AND session are invalid"; we'd rather be strict
    // so, we additionally check the session
    // this has the weird side effect that expectToBeSignedIn (which is also strict, checking that access token AND
    // session are valid) may throw, even if expectToBeSignedOut also throws
    // if you run into something like that in your tests, use expectSessionToBeInvalid instead
    await Auth.expectSessionToBeInvalid();
  }

  export async function signOut() {
    const response = await niceBackendFetch("/api/v1/auth/sessions/current", {
      method: "DELETE",
      accessType: "client",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "success": true },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    if (backendContext.value.userAuth) backendContext.set({ userAuth: { ...backendContext.value.userAuth, accessToken: undefined } });
    await Auth.expectToBeSignedOut();
    return {
      signOutResponse: response,
    };
  }

  export namespace Otp {
    export async function sendSignInCode(options: TurnstileTestOptions = {}) {
      const mailbox = backendContext.value.mailbox;
      const response = await niceBackendFetch("/api/v1/auth/otp/send-sign-in-code", {
        method: "POST",
        accessType: "client",
        body: filterUndefined({
          email: mailbox.emailAddress,
          callback_url: "http://localhost:12345/some-callback-url",
          bot_challenge_token: options.turnstileToken ?? mockTurnstileTokens.magicLinkOk,
          bot_challenge_phase: options.turnstilePhase,
        }),
      });
      expect(response).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 200,
          "body": { "nonce": <stripped field 'nonce'> },
          "headers": Headers { <some fields may have been hidden> },
        }
      `);
      const deadlineMs = 60_000;
      const intervalMs = 500;
      const deadline = performance.now() + deadlineMs;
      while (true) {
        const messages = await mailbox.fetchMessages();
        const containsSubstring = messages.some(message => message.subject.includes("Sign in to") && message.body?.html.includes(response.body.nonce));
        if (containsSubstring) {
          break;
        }
        if (performance.now() >= deadline) {
          throw new HexclaveAssertionError(`Sign-in code message not found within ${deadlineMs}ms`, {
            response,
            messages: messages.map(m => ({ ...m, body: m.body && omit(m.body, ["html"]) })),
          });
        }
        await wait(intervalMs);
      }
      return {
        sendSignInCodeResponse: response,
      };
    }

    export async function signIn() {
      const sendSignInCodeRes = await sendSignInCode();
      const signInResult = await signInWithCode(await getSignInCodeFromMailbox(sendSignInCodeRes.sendSignInCodeResponse.body.nonce));
      return {
        ...sendSignInCodeRes,
        ...signInResult,
      };
    }

    export async function getSignInCodeFromMailbox(nonce?: string) {
      const mailbox = backendContext.value.mailbox;
      const messages = await mailbox.fetchMessages();
      const message = messages.filter(message => nonce === undefined || message.body?.html.includes(nonce)).findLast((message) => message.subject.includes("Sign in to")) ?? throwErr("Sign-in code message not found");
      const signInCode = message.body?.text.match(/http:\/\/localhost:12345\/some-callback-url\?code=([a-zA-Z0-9]+)/)?.[1] ?? throwErr("Sign-in URL not found");
      return signInCode;
    }

    export async function signInWithCode(signInCode: string) {
      const projectKeys = backendContext.value.projectKeys;
      if (projectKeys === "no-project") throw new HexclaveAssertionError("Must provide project keys in the backend context before calling signInWithCode");

      const response = await niceBackendFetch("/api/v1/auth/otp/sign-in", {
        method: "POST",
        accessType: "client",
        body: {
          code: signInCode,
        },
      });
      expect(response).toMatchObject({
        status: 200,
        body: {
          access_token: expect.any(String),
          refresh_token: expect.any(String),
          is_new_user: expect.any(Boolean),
          user_id: expect.any(String),
        },
        headers: expect.anything(),
      });

      backendContext.set({
        userAuth: {
          accessToken: response.body.access_token,
          refreshToken: response.body.refresh_token,
        },
      });

      return {
        userId: response.body.user_id,
        signInResponse: response,
      };
    }
  }

  export namespace Password {
    export async function signUpWithEmail(options: { password?: string, sendVerificationEmail?: boolean, waitForVerificationEmail?: boolean, turnstileToken?: string } = {}) {
      const mailbox = backendContext.value.mailbox;
      const email = mailbox.emailAddress;
      const password = options.password ?? generateSecureRandomString();
      const response = await niceBackendFetch("/api/v1/auth/password/sign-up", {
        method: "POST",
        accessType: "client",
        body: filterUndefined({
          email,
          password,
          verification_callback_url: options.sendVerificationEmail ? "http://localhost:12345/some-callback-url" : undefined,
          bot_challenge_token: options.turnstileToken ?? mockTurnstileTokens.signUpOk,
        }),
      });
      expect(response).toMatchObject({
        status: 200,
        body: {
          access_token: expect.any(String),
          refresh_token: expect.any(String),
          user_id: expect.any(String),
        },
        headers: expect.anything(),
      });

      // Verification emails dominated the baseline outbox and slowed the suite,
      // so only tests asserting verification behavior opt into sending one.
      if (options.sendVerificationEmail && options.waitForVerificationEmail !== false) {
        await mailbox.waitForMessagesWithSubject("Verify your email");
      }

      backendContext.set({
        userAuth: {
          accessToken: response.body.access_token,
          refreshToken: response.body.refresh_token,
        },
      });

      return {
        signUpResponse: response,
        userId: response.body.user_id,
        email,
        password,
      };
    }

    export async function signInWithEmail(options: { password: string }) {
      const mailbox = backendContext.value.mailbox;
      const email = mailbox.emailAddress;
      const response = await niceBackendFetch("/api/v1/auth/password/sign-in", {
        method: "POST",
        accessType: "client",
        body: {
          email,
          password: options.password,
        },
      });
      expect(response).toMatchObject({
        status: 200,
        body: {
          access_token: expect.any(String),
          refresh_token: expect.any(String),
          user_id: expect.any(String),
        },
        headers: expect.anything(),
      });

      backendContext.set({
        userAuth: {
          accessToken: response.body.access_token,
          refreshToken: response.body.refresh_token,
        },
      });

      return {
        signInResponse: response,
        userId: response.body.user_id,
      };
    }
  }

  export namespace Passkey {


    export async function register() {
      const initiateRegistrationRes = await Auth.Passkey.initiateRegistration();

      const response = await niceBackendFetch("/api/v1/auth/passkey/register", {
        method: "POST",
        accessType: "client",
        body: {
          "credential": {
            "id": "BBYYB_DKzPZHm1o6ILGo6Sk_cBc",
            "rawId": "BBYYB_DKzPZHm1o6ILGo6Sk_cBc",
            "response": {
              "attestationObject": "o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YViYSZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NdAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAQWGAfwysz2R5taOiCxqOkpP3AXpQECAyYgASFYIO7JJihe93CDhZOPFp9pVefZyBvy62JMjSs47id1q0vpIlggNMjLAQG7ESYqRZsBQbX07WWIImEzYFDsJgBOSYiQZL8",
              "clientDataJSON": "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiVFU5RFN3Iiwib3JpZ2luIjoiaHR0cDovL2xvY2FsaG9zdDo4MTAzIiwiY3Jvc3NPcmlnaW4iOmZhbHNlfQ",
              "transports": [
                "hybrid",
                "internal"
              ],
              "publicKeyAlgorithm": -7,
              "publicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7skmKF73cIOFk48Wn2lV59nIG_LrYkyNKzjuJ3WrS-k0yMsBAbsRJipFmwFBtfTtZYgiYTNgUOwmAE5JiJBkvw",
              "authenticatorData": "SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NdAAAAAAAAAAAAAAAAAAAAAAAAAAAAFAQWGAfwysz2R5taOiCxqOkpP3AXpQECAyYgASFYIO7JJihe93CDhZOPFp9pVefZyBvy62JMjSs47id1q0vpIlggNMjLAQG7ESYqRZsBQbX07WWIImEzYFDsJgBOSYiQZL8"
            },
            "type": "public-key",
            "clientExtensionResults": {
              "credProps": {
                "rk": true
              }
            },
            "authenticatorAttachment": "platform"
          },
          "code": initiateRegistrationRes.code,
        },
      });

      expect(response).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 200,
          "body": { "user_handle": "BBYYB_DKzPZHm1o6ILGo6Sk_cBc" },
          "headers": Headers { <some fields may have been hidden> },
        }
      `);
    }

    export async function initiateRegistration(): Promise<{ code: string }> {
      const response = await niceBackendFetch("/api/v1/auth/passkey/initiate-passkey-registration", {
        method: "POST",
        accessType: "client",
        body: {},
      });
      const original_code = response.body.code;
      response.body.options_json.user.id = "<stripped encoded UUID>";
      response.body.code = "<stripped code>";

      expect(response).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 200,
          "body": {
            "code": "<stripped code>",
            "options_json": {
              "attestation": "none",
              "authenticatorSelection": {
                "requireResidentKey": true,
                "residentKey": "required",
                "userVerification": "preferred",
              },
              "challenge": "TU9DSw",
              "excludeCredentials": [],
              "extensions": { "credProps": true },
              "pubKeyCredParams": [
                {
                  "alg": -8,
                  "type": "public-key",
                },
                {
                  "alg": -7,
                  "type": "public-key",
                },
                {
                  "alg": -257,
                  "type": "public-key",
                },
              ],
              "rp": {
                "id": "THIS_VALUE_WILL_BE_REPLACED.example.com",
                "name": "New Project",
              },
              "timeout": 60000,
              "user": {
                "displayName": "default-mailbox--<stripped UUID>@stack-generated.example.com",
                "id": "<stripped encoded UUID>",
                "name": "default-mailbox--<stripped UUID>@stack-generated.example.com",
              },
            },
          },
          "headers": Headers { <some fields may have been hidden> },
        }
      `);
      return {
        code: original_code,
      };
    }
  }


  export namespace OAuth {
    export const testCodeVerifier = "some-code-challenge";
    export const testCodeChallenge = createHash("sha256").update(testCodeVerifier).digest("base64url");

    export async function getAuthorizeQuery(options: TurnstileTestOptions & {
      forceBranchId?: string,
      includeClientSecret?: boolean,
    } = {}) {
      const projectKeys = backendContext.value.projectKeys;
      if (projectKeys === "no-project") throw new Error("No project keys found in the backend context");
      const branchId = options.forceBranchId ?? backendContext.value.currentBranchId;
      const userAuth = backendContext.value.userAuth;
      const includeClientSecret = options.includeClientSecret ?? true;
      const clientSecret = includeClientSecret
        ? (projectKeys.publishableClientKey ?? publishableClientKeyNotNecessarySentinel)
        : publishableClientKeyNotNecessarySentinel;

      return filterUndefined({
        client_id: !branchId ? projectKeys.projectId : `${projectKeys.projectId}#${branchId}`,
        client_secret: clientSecret,
        redirect_uri: localRedirectUrl,
        scope: "legacy",
        response_type: "code",
        state: "this-is-some-state",
        grant_type: "authorization_code",
        code_challenge: Auth.OAuth.testCodeChallenge,
        code_challenge_method: "S256",
        token: userAuth?.accessToken ?? undefined,
        bot_challenge_token: options.turnstileToken ?? mockTurnstileTokens.oauthOk,
        bot_challenge_phase: options.turnstilePhase,

      });
    }

    export async function authorize(options: TurnstileTestOptions & {
      redirectUrl?: string,
      errorRedirectUrl?: string,
      afterCallbackRedirectUrl?: string,
      forceBranchId?: string,
      includeClientSecret?: boolean,
    } = {}) {
      const response = await niceBackendFetch("/api/v1/auth/oauth/authorize/spotify", {
        redirect: "manual",
        query: {
          ...await Auth.OAuth.getAuthorizeQuery(options),
          ...filterUndefined({
            redirect_uri: options.redirectUrl ?? undefined,
            error_redirect_uri: options.errorRedirectUrl ?? undefined,
            after_callback_redirect_url: options.afterCallbackRedirectUrl ?? undefined,
          }),
        },
      });
      expect(response).toMatchObject({
        status: 307,
        headers: expect.any(Headers),
      });
      const location = response.headers.get("location");
      expect(location).toBeTruthy();
      const locationUrl = new URL(location!);
      expect(locationUrl.origin).toBe(localhostUrl("14"));
      expect(locationUrl.pathname).toBe("/auth");
      // Backend dual-writes oauth-inner cookies under both `stack-` and `hexclave-` prefixes
      // (cookie dual-write — see hexclave rename plan); assert via getSetCookie() to avoid
      // the comma-join ambiguity that Headers.get("set-cookie") creates with multiple
      // Set-Cookie headers whose values contain `, ` (e.g. inside Expires=).
      const oauthInnerSetCookies = response.headers.getSetCookie()
        .filter(c => /^(?:stack|hexclave)-oauth-inner-/.test(c));
      expect(oauthInnerSetCookies.length).toBeGreaterThan(0);
      for (const setCookie of oauthInnerSetCookies) {
        expect(setCookie).toMatch(/^(?:stack|hexclave)-oauth-inner-[^;]+=[^;]+; Path=\/; Expires=[^;]+; Max-Age=\d+;( Secure;)? HttpOnly$/);
      }
      return {
        authorizeResponse: response,
      };
    }

    export async function getInnerCallbackUrl(options: TurnstileTestOptions & {
      authorizeResponse?: NiceResponse,
      forceBranchId?: string,
      includeClientSecret?: boolean,
    } = {}) {
      const authorizeResponse = options.authorizeResponse ?? (await Auth.OAuth.authorize(options)).authorizeResponse;
      const providerPassword = generateSecureRandomString();
      const authLocation = new URL(authorizeResponse.headers.get("location")!);
      const redirectResponse1 = await niceFetch(authLocation, {
        redirect: "manual",
      });
      expect(redirectResponse1).toMatchObject({
        status: 303,
        headers: expect.any(Headers),
        body: expect.any(String),
      });
      const signInInteractionLocation = new URL(redirectResponse1.headers.get("location") ?? throwErr("missing redirect location", { redirectResponse1 }), authLocation);
      const signInInteractionCookies = updateCookiesFromResponse("", redirectResponse1);
      const response1 = await niceFetch(signInInteractionLocation, {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({
          prompt: "login",
          login: backendContext.value.mailbox.emailAddress,
          password: providerPassword,
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: signInInteractionCookies,
        },
      });
      expect(response1).toMatchObject({
        status: 303,
        headers: expect.any(Headers),
        body: expect.any(ArrayBuffer),
      });
      const redirectResponse2 = await niceFetch(new URL(response1.headers.get("location") ?? throwErr("missing redirect location", { response1 }), signInInteractionLocation), {
        redirect: "manual",
        headers: {
          cookie: updateCookiesFromResponse(signInInteractionCookies, response1),
        },
      });
      expect(redirectResponse2).toMatchObject({
        status: 303,
        headers: expect.any(Headers),
        body: expect.any(String),
      });
      const authorizeInteractionLocation = new URL(redirectResponse2.headers.get("location") ?? throwErr("missing redirect location", { redirectResponse2 }), authLocation);
      const authorizeInteractionCookies = updateCookiesFromResponse(signInInteractionCookies, redirectResponse2);
      const response2 = await niceFetch(authorizeInteractionLocation, {
        method: "POST",
        redirect: "manual",
        body: new URLSearchParams({
          prompt: "consent",
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: authorizeInteractionCookies,
        },
      });
      expect(response2).toMatchObject({
        status: 303,
        headers: expect.any(Headers),
        body: expect.any(ArrayBuffer),
      });
      const redirectResponse3 = await niceFetch(new URL(response2.headers.get("location") ?? throwErr("missing redirect location", { response2 }), authLocation), {
        redirect: "manual",
        headers: {
          cookie: updateCookiesFromResponse(authorizeInteractionCookies, response2),
        },
      });
      expect(redirectResponse3).toMatchObject({
        status: 303,
        headers: expect.any(Headers),
        body: expect.any(String),
      });
      const innerCallbackUrl = new URL(redirectResponse3.headers.get("location") ?? throwErr("missing redirect location", { redirectResponse3 }));
      expect(innerCallbackUrl.origin).toBe(localhostUrl("02"));
      expect(innerCallbackUrl.pathname).toBe("/api/v1/auth/oauth/callback/spotify");
      return {
        authorizeResponse,
        innerCallbackUrl,
      };
    }

    export async function getMaybeFailingAuthorizationCode(options: TurnstileTestOptions & {
      innerCallbackUrl?: URL,
      authorizeResponse?: NiceResponse,
      forceBranchId?: string,
      includeClientSecret?: boolean,
    } = {}) {
      let authorizeResponse, innerCallbackUrl;
      if (options.innerCallbackUrl && options.authorizeResponse) {
        innerCallbackUrl = options.innerCallbackUrl;
        authorizeResponse = options.authorizeResponse;
      } else if (!options.innerCallbackUrl) {
        ({ authorizeResponse, innerCallbackUrl } = await Auth.OAuth.getInnerCallbackUrl(options));
      } else {
        throw new Error("If innerCallbackUrl is provided, authorizeResponse must also be provided");
      }
      const cookie = updateCookiesFromResponse("", authorizeResponse!);
      const response = await niceBackendFetch(innerCallbackUrl.toString(), {
        redirect: "manual",
        headers: {
          cookie,
        },
      });
      return {
        authorizeResponse,
        innerCallbackUrl,
        response,
      };
    }

    export async function getAuthorizationCode(options: TurnstileTestOptions & {
      innerCallbackUrl?: URL,
      authorizeResponse?: NiceResponse,
      forceBranchId?: string,
      includeClientSecret?: boolean,
    } = {}) {
      const { response } = await Auth.OAuth.getMaybeFailingAuthorizationCode(options);
      expect(response).toMatchObject({
        status: 303,
        headers: expect.any(Headers),
        body: {},
      });
      const outerCallbackUrl = new URL(response.headers.get("location") ?? throwErr("missing redirect location", { response }));
      expect(outerCallbackUrl.origin).toBe(new URL(localRedirectUrl).origin);
      expect(outerCallbackUrl.pathname).toBe(new URL(localRedirectUrl).pathname);
      expect(Object.fromEntries(outerCallbackUrl.searchParams.entries())).toEqual({
        code: expect.any(String),
        state: "this-is-some-state",
      });

      return {
        callbackResponse: response,
        outerCallbackUrl,
        authorizationCode: outerCallbackUrl.searchParams.get("code")!,
      };
    }

    export async function signIn(options: TurnstileTestOptions & {
      forceBranchId?: string,
      includeClientSecret?: boolean,
    } = {}) {
      const getAuthorizationCodeResult = await Auth.OAuth.getAuthorizationCode(options);

      const projectKeys = backendContext.value.projectKeys;
      if (projectKeys === "no-project") throw new Error("No project keys found in the backend context");
      const includeClientSecret = options.includeClientSecret ?? true;
      const clientSecret = includeClientSecret
        ? (projectKeys.publishableClientKey ?? publishableClientKeyNotNecessarySentinel)
        : publishableClientKeyNotNecessarySentinel;

      const tokenResponse = await niceBackendFetch("/api/v1/auth/oauth/token", {
        method: "POST",
        accessType: "client",
        body: filterUndefined({
          client_id: projectKeys.projectId,
          client_secret: clientSecret,
          code: getAuthorizationCodeResult.authorizationCode,
          redirect_uri: localRedirectUrl,
          code_verifier: "some-code-challenge",
          grant_type: "authorization_code",
        }),
      });
      expect(tokenResponse).toMatchObject({
        status: 200,
        body: {
          access_token: expect.any(String),
          afterCallbackRedirectUrl: null,
          after_callback_redirect_url: null,
          refresh_token: expect.any(String),
          scope: "legacy",
          token_type: "Bearer"
        },
      });

      backendContext.set({
        userAuth: {
          accessToken: tokenResponse.body.access_token,
          refreshToken: tokenResponse.body.refresh_token,
        },
      });

      return {
        ...getAuthorizationCodeResult,
        tokenResponse,
      };
    }
  }

  export namespace Mfa {
    export async function setupTotpMfa() {
      const totpSecretBytes = crypto.getRandomValues(new Uint8Array(20));
      const totpSecretBase64 = encodeBase64(totpSecretBytes);
      const response = await niceBackendFetch("/api/v1/users/me", {
        accessType: "client",
        method: "PATCH",
        body: {
          totp_secret_base64: totpSecretBase64,
        },
      });
      expect(response).toMatchObject({
        status: 200,
      });

      return {
        setupTotpMfaResponse: response,
        totpSecret: totpSecretBytes,
      };
    }
  }

  export namespace Anonymous {
    export async function signUp() {
      const response = await niceBackendFetch("/api/v1/auth/anonymous/sign-up", {
        method: "POST",
        accessType: "client",
      });
      expect(response).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 200,
          "body": {
            "access_token": <stripped field 'access_token'>,
            "refresh_token": <stripped field 'refresh_token'>,
            "user_id": "<stripped UUID>",
          },
          "headers": Headers { <some fields may have been hidden> },
        }
      `);
      backendContext.set({
        userAuth: {
          accessToken: response.body.access_token,
          refreshToken: response.body.refresh_token,
        },
      });
      return {
        response,
        accessToken: response.body.access_token,
        refreshToken: response.body.refresh_token,
        userId: response.body.user_id,
      };
    }
  }
}

export namespace ContactChannels {
  export async function getTheOnlyContactChannel() {
    const contactChannels = await ContactChannels.listAllCurrentUserContactChannels();
    expect(contactChannels).toHaveLength(1);
    return contactChannels[0];
  }

  export async function listAllCurrentUserContactChannels() {
    const response = await niceBackendFetch("/api/v1/contact-channels?user_id=me", {
      accessType: "client",
    });
    return response.body.items;
  }

  export async function sendVerificationCode(options?: { contactChannelId?: string }) {
    const contactChannelId = options?.contactChannelId ?? (await ContactChannels.getTheOnlyContactChannel()).id;
    const mailbox = backendContext.value.mailbox;
    const messagesBefore = await mailbox.fetchMessages({ noBody: true });
    const countBefore = messagesBefore.filter(m => m.subject.includes("Verify your email")).length;
    const response = await niceBackendFetch(`/api/v1/contact-channels/me/${contactChannelId}/send-verification-code`, {
      method: "POST",
      accessType: "client",
      body: {
        callback_url: "http://localhost:12345/some-callback-url",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "success": true },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    // Wait for a new verification email to arrive
    const messages = await mailbox.waitForMessagesWithSubjectCount("Verify your email", countBefore + 1);
    expect(messages.length).toBeGreaterThanOrEqual(countBefore + 1);
    return {
      sendSignInCodeResponse: response,
    };
  }

  export async function verify(options?: { contactChannelId?: string }) {
    const mailbox = backendContext.value.mailbox;
    const sendVerificationCodeRes = await sendVerificationCode(options);
    const messages = await mailbox.waitForMessagesWithSubject("Verify your email");
    const message = messages.findLast((message) => message.subject.includes("Verify your email")) ?? throwErr("Verification code message not found");
    const verificationCode = message.body?.text.match(/http:\/\/localhost:12345\/some-callback-url\?code=([a-zA-Z0-9]+)/)?.[1] ?? throwErr("Verification code not found");
    const response = await niceBackendFetch("/api/v1/contact-channels/verify", {
      method: "POST",
      accessType: "client",
      body: {
        code: verificationCode,
      },
    });
    expect(response).toMatchInlineSnapshot(`
          NiceResponse {
            "status": 200,
            "body": { "success": true },
            "headers": Headers { <some fields may have been hidden> },
          }
        `);
    return {
      ...sendVerificationCodeRes,
      verifyResponse: response,
    };
  }
}

export namespace ProjectApiKey {
  export namespace User {
    export async function create(data?: any) {
      const response = await niceBackendFetch("/api/v1/user-api-keys", {
        method: "POST",
        accessType: "server",
        body: data,
      });
      expect(response).toMatchObject({
        status: 200,
        body: expect.objectContaining({
          created_at_millis: expect.any(Number),
          description: expect.any(String),
          id: expect.any(String),
          is_public: expect.any(Boolean),
          type: expect.any(String),
          user_id: expect.any(String),
          value: expect.any(String),
        }),
        headers: expect.any(Headers),
      });
      return {
        createUserApiKeyResponse: response,
      };
    }

    export async function check(apiKey: string) {
      const response = await niceBackendFetch(`/api/v1/user-api-keys/check`, {
        method: "POST",
        accessType: "server",
        body: {
          api_key: apiKey,
        },
      });
      expect(response.status).oneOf([200, 401, 404]);
      return response.body;
    }

    export async function revoke(apiKeyId: string) {
      const response = await niceBackendFetch(`/api/v1/user-api-keys/${apiKeyId}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          revoked: true,
        },
      });
      return response;
    }
  }

  export namespace Team {
    export async function create(body?: any) {
      const response = await niceBackendFetch("/api/v1/team-api-keys", {
        method: "POST",
        accessType: "client",
        body,
      });
      expect(response.status).toEqual(200);
      return {
        createTeamApiKeyResponse: response,
      };
    }

    export async function check(apiKey: string) {
      const response = await niceBackendFetch(`/api/v1/team-api-keys/check`, {
        method: "POST",
        accessType: "server",
        body: {
          api_key: apiKey,
        },
      });
      expect(response.status).oneOf([200, 401, 404]);
      return response.body;
    }


    export async function revoke(apiKeyId: string) {
      const response = await niceBackendFetch(`/api/v1/team-api-keys/${apiKeyId}`, {
        method: "PATCH",
        accessType: "server",
        body: {
          revoked: true,
        },
      });
      return response;
    }
  }
}

export namespace InternalApiKey {
  export async function create(adminAccessToken?: string, body?: any) {
    const oldProjectKeys = backendContext.value.projectKeys;
    if (oldProjectKeys === 'no-project') {
      throw new Error("Cannot set API key context without a project");
    }

    const response = await niceBackendFetch("/api/v1/internal/api-keys", {
      accessType: "admin",
      method: "POST",
      body: {
        description: "test api key",
        has_publishable_client_key: true,
        has_secret_server_key: true,
        has_super_secret_admin_key: true,
        expires_at_millis: new Date().getTime() + 1000 * 60 * 60 * 24,
        ...body,
      },
      headers: {
        'x-stack-admin-access-token': adminAccessToken ?? (backendContext.value.projectKeys !== "no-project" && backendContext.value.projectKeys.adminAccessToken || undefined),
      }
    });
    expect(response.status).equals(200);

    return {
      createApiKeyResponse: response,
      projectKeys: {
        projectId: oldProjectKeys.projectId,
        publishableClientKey: response.body.publishable_client_key,
        secretServerKey: response.body.secret_server_key,
        superSecretAdminKey: response.body.super_secret_admin_key,
      },
    };
  }

  export async function createAndSetProjectKeys(adminAccessToken?: string, body?: any) {
    const res = await InternalApiKey.create(adminAccessToken, body);
    backendContext.set({ projectKeys: res.projectKeys });
    return res;
  }

  export async function list() {
    const response = await niceBackendFetch("/api/v1/internal/api-keys", {
      accessType: "admin",
    });
    expect(response.status).toBe(200);
    return response.body;
  }
}

// A new project's billing team is granted the free plan in the same
// transaction as the team create, but the Bulldozer write that actually
// materializes the entitlement is fired asynchronously and its item
// quantities (auth_users, analytics_timeout_seconds, emails_per_month, ...)
// only appear once the subscription TimeFold catches up (see
// apps/backend/.../teams/crud.tsx and lib/payments/ensure-free-plan.ts).
// Until then the team's item quantities read as 0, and billing-gated
// endpoints transiently reject: analytics queries throw
// ITEM_QUANTITY_INSUFFICIENT_AMOUNT, user sign-ups trip the auth-users soft
// limit, email sends hit a zero email quota, etc. Tests create a project and
// immediately exercise those endpoints, so give the entitlement a chance to
// materialize here. All plan items are emitted atomically by the subscription
// TimeFold, so a single item crossing above zero implies the rest are present.
//
// This is a best-effort readiness wait, not an assertion: on timeout we return
// and let the caller proceed rather than throwing. Two reasons. (1) Not every
// created team has (or is expected to have) a free-plan entitlement — the grant
// only happens for internal-project teams with a configured `free` product (see
// teams/crud.tsx), so a hard failure here would wrongly break callers that only
// need a project record and never touch billing. (2) Materialization latency is
// an environment condition (Bulldozer load), not a test failure; under a heavily
// loaded CI shard it can exceed the timeout, and turning that into a thrown error
// makes otherwise-passing tests flake. If the entitlement really never lands, the
// caller's own billing-gated assertion is what should (and does) surface it.
//
// The free-plan grant rides the `runAsynchronouslyAndWaitUntil(bulldozerWriteSubscription(...))`
// fire-and-forget write in teams/crud.tsx, whose TimeFold can be badly backed up on a
// cold, freshly-started CI shard — we've observed it take seconds there while completing
// in well under a second locally. Since this loop returns the instant the entitlement
// appears, the cap adds no latency on the happy path; it only bounds the wait when
// materialization has genuinely stalled.
//
// The cap is fixed below the 30s minimum timeout declared by any e2e test. This wait runs
// *inside* Project.create, so keeping it below the suite-wide minimum ensures that slow
// materialization cannot consume an entire test budget — even for tests that never touch
// billing (e.g. outbox rendering-state tests). The deadline is enforced before each poll,
// by aborting the request when its remaining budget expires, and by clamping the sleep
// between polls to that remaining budget.
async function waitForBillingTeamPlanEntitlement(ownerTeamId: string): Promise<void> {
  const pollIntervalMs = 200;
  const timeoutMs = 15_000;
  const startedAt = performance.now();
  const deadline = startedAt + timeoutMs;
  const warnTimeout = () => {
    const elapsedMs = performance.now() - startedAt;
    console.warn(
      `[billing-entitlement-wait] Timed out waiting for team ${ownerTeamId} after ${elapsedMs.toFixed(0)} ms`,
    );
  };

  while (true) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) {
      warnTimeout();
      return;
    }

    const abortController = new AbortController();
    const abortTimeout = setTimeout(() => abortController.abort(), remainingMs);
    let quantity: number;
    try {
      quantity = await withInternalProject(async () => {
        const response = await niceBackendFetch(
          `/api/v1/payments/items/team/${encodeURIComponent(ownerTeamId)}/${ITEM_IDS.analyticsTimeoutSeconds}`,
          { accessType: "server", signal: abortController.signal },
        );
        if (response.status !== 200) {
          throw new HexclaveAssertionError("Failed to read billing-team item quantity while waiting for plan entitlement", { ownerTeamId, response });
        }
        const quantity = response.body.quantity;
        if (typeof quantity !== "number") {
          throw new HexclaveAssertionError("Expected billing-team item quantity to be a number", { ownerTeamId, quantity });
        }
        return quantity;
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        warnTimeout();
        return;
      }
      throw error;
    } finally {
      clearTimeout(abortTimeout);
    }
    if (quantity > 0) return;

    const remainingAfterPollMs = deadline - performance.now();
    if (remainingAfterPollMs <= 0) {
      warnTimeout();
      return;
    }

    await wait(Math.min(pollIntervalMs, remainingAfterPollMs));
  }
}

/**
 * Waits until a billing team's granted plan is visible to the backend.
 *
 * Subscriptions are read through bulldozer, which materializes a grant
 * asynchronously, so a test that deployed immediately after granting would race
 * the gate and see the Free-plan refusal. Unlike the Free-plan wait above this
 * one THROWS on timeout: a silent fallthrough here means the test quietly
 * exercises the Free path and fails later with an unrelated-looking 400.
 *
 * The team's own products are read in the internal project, which is where the
 * subscription lives — `plan-usage` would report the same thing, but only for a
 * project, and the caller may not have switched to one yet.
 */
async function waitForBillingTeamPlanId(ownerTeamId: string, planId: string): Promise<void> {
  const pollIntervalMs = 200;
  const timeoutMs = 15_000;
  const deadline = performance.now() + timeoutMs;
  let lastSeen: unknown = undefined;

  while (performance.now() < deadline) {
    const products = await withInternalProject(async () => {
      const response = await niceBackendFetch(
        `/api/v1/payments/products/team/${encodeURIComponent(ownerTeamId)}`,
        { accessType: "server" },
      );
      if (response.status !== 200) {
        throw new HexclaveAssertionError("Failed to read billing-team products while waiting for a granted plan", { ownerTeamId, response });
      }
      return (response.body as any)?.items ?? [];
    });
    lastSeen = products;
    if (Array.isArray(products) && products.some((item: any) => item?.id === planId)) return;
    await wait(pollIntervalMs);
  }

  throw new HexclaveAssertionError(
    `Timed out waiting ${timeoutMs} ms for billing team ${ownerTeamId} to show plan ${planId}`,
    { ownerTeamId, planId, lastSeen },
  );
}

export namespace Project {
  export async function create(body?: any) {
    const ownerTeamId = body?.owner_team_id ?? (await User.getCurrent()).selected_team_id;
    const response = await niceBackendFetch("/api/v1/internal/projects", {
      accessType: "client",
      method: "POST",
      body: {
        display_name: body?.display_name || 'New Project',
        owner_team_id: ownerTeamId,
        ...body,
        config: {
          credential_enabled: true,
          allow_localhost: true,
          ...body?.config,
        },
      },
    });
    expect(response).toMatchObject({
      status: 201,
      body: {
        id: expect.any(String),
      },
    });
    // Wait on the owner team the backend actually recorded, not the pre-request
    // value: the request body is merged with `...body`, so a caller could override
    // owner_team_id, and it's the created project's owner team that the free-plan
    // entitlement is granted to. Fall back to the resolved value if the response
    // omits it.
    const createdOwnerTeamId = response.body.owner_team_id ?? ownerTeamId;
    if (createdOwnerTeamId != null) {
      await waitForBillingTeamPlanEntitlement(createdOwnerTeamId);
    }
    return {
      createProjectResponse: response,
      projectId: response.body.id as string,
    };
  }

  export async function updateCurrent(adminAccessToken: string, body: Partial<AdminUserProjectsCrud["Admin"]["Create"]>) {
    const response = await niceBackendFetch(`/api/v1/internal/projects/current`, {
      accessType: "admin",
      method: "PATCH",
      body,
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      }
    });

    return {
      updateProjectResponse: response,
    };
  }

  export async function createAndGetAdminToken(body?: Partial<AdminUserProjectsCrud["Admin"]["Create"]>, useExistingUser?: boolean) {
    backendContext.set({ projectKeys: InternalProjectKeys });
    let userId: string | undefined;
    if (!useExistingUser) {
      backendContext.set({ userAuth: null });
      const { userId: newUserId } = await Auth.fastSignUp();
      userId = newUserId;
    }
    const adminAccessToken = backendContext.value.userAuth?.accessToken;
    expect(adminAccessToken).toBeDefined();
    const { projectId, createProjectResponse } = await Project.create(body);

    backendContext.set({
      projectKeys: {
        projectId,
      },
      userAuth: null,
    });

    return {
      creatorUserId: userId,
      projectId,
      adminAccessToken: adminAccessToken!,
      createProjectResponse,
    };
  }

  export async function createAndSwitch(body?: Partial<AdminUserProjectsCrud["Admin"]["Create"]>, useExistingUser?: boolean) {
    const createResult = await Project.createAndGetAdminToken(body, useExistingUser);
    backendContext.set({
      projectKeys: {
        projectId: createResult.projectId,
        adminAccessToken: createResult.adminAccessToken,
      },
      userAuth: null
    });
    const { projectKeys } = await InternalApiKey.create(createResult.adminAccessToken);
    backendContext.set({
      projectKeys,
      userAuth: null
    });
    return createResult;
  }

  /**
   * Puts a project's billing team on a paid base plan, and waits until the
   * backend can see it.
   *
   * `Project.create` always records an owner team and waits for its Free-plan
   * entitlement, so every project a test creates is plan-gated as Free. Tests
   * that exercise a paid-only capability — today, any `server` service or any
   * `minInstances` above 0 (see `assertServicesAllowedByPlan`) — have to buy in
   * explicitly with this.
   *
   * The grant is written in the INTERNAL project, whose team subscriptions are
   * what `getPlanIdForProjectOrNull` reads for every other project.
   */
  export async function grantBillingTeamPlan(ownerTeamId: string, planId: "team" | "growth" = "team"): Promise<void> {
    const response = await withInternalProject(async () => await niceBackendFetch(
      `/api/v1/payments/products/team/${encodeURIComponent(ownerTeamId)}`,
      { accessType: "server", method: "POST", body: { product_id: planId } },
    ));
    if (response.status !== 200) {
      throw new HexclaveAssertionError("Failed to grant a paid plan to a billing team", { ownerTeamId, planId, response });
    }
    await waitForBillingTeamPlanId(ownerTeamId, planId);
  }

  /**
   * Creates a project whose billing team is on a paid plan, and switches to it.
   *
   * The plain `createAndSwitch` deliberately stays on Free: that is what a real
   * new project is, and the Free-plan gate's own tests need it.
   */
  export async function createAndSwitchOnPaidPlan(body?: Partial<AdminUserProjectsCrud["Admin"]["Create"]>, useExistingUser?: boolean) {
    const createResult = await Project.createAndSwitch(body, useExistingUser);
    const ownerTeamId = createResult.createProjectResponse.body.owner_team_id;
    if (typeof ownerTeamId !== "string") {
      throw new HexclaveAssertionError("Cannot put a project on a paid plan: it has no owner team", { projectId: createResult.projectId });
    }
    await Project.grantBillingTeamPlan(ownerTeamId);
    return createResult;
  }

  export async function updateConfig(config: any) {
    const response = await niceBackendFetch(`/api/latest/internal/config/override/environment`, {
      accessType: "admin",
      method: "PATCH",
      body: { config_override_string: JSON.stringify(config) },
    });
    expect(response.body).toMatchInlineSnapshot(`{ "success": true }`);
    expect(response.status).toBe(200);
  }

  export async function updateProjectConfig(config: ProjectConfigOverride) {
    const response = await niceBackendFetch(`/api/latest/internal/config/override/project`, {
      accessType: "admin",
      method: "PATCH",
      body: { config_override_string: JSON.stringify(config) },
    });
    expect(response.body).toMatchInlineSnapshot(`{ "success": true }`);
    expect(response.status).toBe(200);
  }

  export type BranchConfigSource =
    | { type: "pushed-from-github", owner: string, repo: string, branch: string, commit_hash: string, config_file_path: string, workflow_path?: string }
    | { type: "pushed-from-unknown" }
    | { type: "unlinked" };

  /**
   * Push config to branch level. Source defaults to 'unlinked' if not specified.
   */
  export async function pushConfig(config: any, source: BranchConfigSource = { type: "unlinked" }) {
    const response = await niceBackendFetch(`/api/latest/internal/config/override/branch`, {
      accessType: "admin",
      method: "PUT",
      body: {
        config_string: JSON.stringify(config),
        source,
      },
    });
    expect(response.body).toMatchInlineSnapshot(`{ "success": true }`);
    expect(response.status).toBe(200);
  }

  /**
   * Update the pushed config (PATCH - preserves source)
   */
  export async function updatePushedConfig(config: any) {
    const response = await niceBackendFetch(`/api/latest/internal/config/override/branch`, {
      accessType: "admin",
      method: "PATCH",
      body: { config_override_string: JSON.stringify(config) },
    });
    expect(response.body).toMatchInlineSnapshot(`{ "success": true }`);
    expect(response.status).toBe(200);
  }

  /**
   * Get the current branch config source
   */
  export async function getConfigSource(): Promise<BranchConfigSource> {
    const response = await niceBackendFetch(`/api/latest/internal/config/source`, {
      accessType: "admin",
      method: "GET",
    });
    expect(response.status).toBe(200);
    return response.body.source;
  }

  /**
   * Unlink the branch config source (set to 'unlinked')
   */
  export async function unlinkConfigSource() {
    const response = await niceBackendFetch(`/api/latest/internal/config/source`, {
      accessType: "admin",
      method: "DELETE",
    });
    expect(response.body).toMatchInlineSnapshot(`{ "success": true }`);
    expect(response.status).toBe(200);
  }

  /**
   * Reset specific keys from a config override level.
   * Uses the same nested key logic as the override algorithm.
   */
  export async function resetConfigOverrideKeys(level: "branch" | "environment", keys: string[]) {
    const response = await niceBackendFetch(`/api/latest/internal/config/override/${level}/reset-keys`, {
      accessType: "admin",
      method: "POST",
      body: { keys },
    });
    expect(response.body).toMatchInlineSnapshot(`{ "success": true }`);
    expect(response.status).toBe(200);
  }
}

export namespace Team {
  export async function create(options: { accessType?: "client" | "server", addCurrentUser?: boolean, creatorUserId?: string } = {}, body?: any) {
    const displayName = body?.display_name || 'New Team';
    const response = await niceBackendFetch("/api/v1/teams", {
      accessType: options.accessType ?? "server",
      method: "POST",
      body: {
        display_name: displayName,
        creator_user_id: options.creatorUserId ?? (options.addCurrentUser ? 'me' : undefined),
        ...body,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 201,
        "body": {
          "client_metadata": null,
          "client_read_only_metadata": null,
          "created_at_millis": <stripped field 'created_at_millis'>,
          "display_name": ${JSON.stringify(displayName)},
          "id": "<stripped UUID>",
          "profile_image_url": null,
          "server_metadata": null,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    return {
      createTeamResponse: response,
      teamId: response.body.id,
    };
  }

  export async function createWithCurrentAsCreator(options: { accessType?: "client" | "server" } = {}, body?: any) {
    return await Team.create({ ...options, addCurrentUser: true }, body);
  }

  export async function addMember(teamId: string, userId: string) {
    const response = await niceBackendFetch(`/api/v1/team-memberships/${teamId}/${userId}`, {
      method: "POST",
      accessType: "server",
      body: {},
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 201,
        "body": {
          "team_id": "<stripped UUID>",
          "user_id": "<stripped UUID>",
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  }

  export async function addPermission(teamId: string, userId: string, permissionId: string) {
    const response = await niceBackendFetch(`/api/v1/team-permissions/${teamId}/${userId}/${permissionId}`, {
      method: "POST",
      accessType: "server",
      body: {},
    });
    return response;
  }

  export async function sendInvitation(mail: string | Mailbox, teamId: string) {
    const response = await niceBackendFetch("/api/v1/team-invitations/send-code", {
      method: "POST",
      accessType: "client",
      body: {
        email: typeof mail === 'string' ? mail : mail.emailAddress,
        team_id: teamId,
        callback_url: "http://localhost:12345/some-callback-url",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "id": "<stripped UUID>",
          "success": true,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);

    return {
      sendTeamInvitationResponse: response,
    };
  }

  export async function acceptInvitation() {
    const mailbox = backendContext.value.mailbox;
    const messages = await mailbox.waitForMessagesWithSubject("join");
    const message = messages.findLast((message) => message.subject.includes("join")) ?? throwErr("Team invitation message not found");
    const code = message.body?.text.match(/http:\/\/localhost:12345\/some-callback-url\?code=([a-zA-Z0-9]+)/)?.[1] ?? throwErr("Team invitation code not found");
    const response = await niceBackendFetch("/api/v1/team-invitations/accept", {
      method: "POST",
      accessType: "client",
      body: {
        code,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {},
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    return {
      acceptTeamInvitationResponse: response,
    };
  }
}

export namespace User {
  export async function getCurrent() {
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
    });
    expect(response).toMatchObject({
      status: 200,
    });
    return response.body;
  }

  export async function create(body?: Record<string, unknown>) {
    const createUserResponse = await niceBackendFetch("/api/v1/users", {
      method: "POST",
      accessType: "server",
      body: body ?? {},
    });
    expect(createUserResponse).toMatchObject({
      status: 201,
      body: {
        id: expect.any(String),
      },
    });
    return {
      userId: createUserResponse.body.id,
    };
  }

  export async function createMultiple(count: number) {
    const users = [];
    for (let i = 0; i < count; i++) {
      const user = await User.create();
      users.push(user);
    }
    return users;
  }

  export async function setClientReadOnlyMetadata(userId: string, metadata: Record<string, unknown>) {
    const response = await niceBackendFetch(`/api/v1/users/${userId}`, {
      method: "PATCH",
      accessType: "server",
      body: {
        client_read_only_metadata: metadata,
      },
    });
    expect(response).toMatchObject({ status: 200 });
    return response;
  }
}

export namespace Webhook {
  export async function createProjectWithEndpoint() {
    const { projectId } = await Project.createAndSwitch({
      config: {
        magic_link_enabled: true,
      }
    });

    const svixTokenResponse = await niceBackendFetch("/api/v1/webhooks/svix-token", {
      accessType: "admin",
      method: "POST",
      body: {},
    });

    const svixToken = svixTokenResponse.body.token;

    const createEndpointResponse = await niceFetch(STACK_SVIX_SERVER_URL + `/api/v1/app/${projectId}/endpoint`, {
      method: "POST",
      body: JSON.stringify({
        url: "http://localhost:12345/webhook"
      }),
      headers: {
        "Authorization": `Bearer ${svixToken}`,
        "Content-Type": "application/json",
      },
    });

    return {
      projectId,
      svixToken,
      endpointId: createEndpointResponse.body.id
    };
  }

  export async function findWebhookAttempt(projectId: string, endpointId: string, svixToken: string, fn: (msg: any) => boolean, retryCount: number = 5) {
    // retry many times because Svix sucks and is slow
    for (let i = 0; i < retryCount; i++) {
      const attempts = await Webhook.listWebhookAttempts(projectId, endpointId, svixToken);
      const filtered = attempts.filter(fn);
      if (filtered.length === 0) {
        await wait(500);
        continue;
      } else if (filtered.length === 1) {
        return filtered[0];
      } else {
        throw new Error(`Found ${filtered.length} webhook attempts for project ${projectId}, endpoint ${endpointId}`);
      }
    }
    throw new Error(`Webhook attempt not found for project ${projectId}, endpoint ${endpointId}`);
  }

  export async function listWebhookAttempts(projectId: string, endpointId: string, svixToken: string, retryCount: number = 5) {
    // retry many times because Svix sucks and is slow
    for (let i = 0; i < retryCount; i++) {
      const response = await niceFetch(STACK_SVIX_SERVER_URL + `/api/v1/app/${projectId}/attempt/endpoint/${endpointId}`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${svixToken}`,
          "Content-Type": "application/json",
        },
      });

      const messages = await Promise.all(response.body.data.map(async (attempt: any) => {
        const messageResponse = await niceFetch(STACK_SVIX_SERVER_URL + `/api/v1/app/${projectId}/msg/${attempt.msgId}?with_content=true`, {
          headers: {
            "Authorization": `Bearer ${svixToken}`,
            "Content-Type": "application/json",
          },
          method: "GET",
        });
        return messageResponse.body;
      }));

      if (messages.length === 0) {
        await wait(500);
        continue;
      }

      return messages.sort((a, b) => {
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });
    }
    return [];
  }
}

export namespace Payments {
  export async function setup() {
    const response = await niceBackendFetch("/api/latest/internal/payments/setup", {
      accessType: "admin",
      method: "POST",
      body: {},
    });
    expect(response.status).toBe(200);
    return response.body;
  }

  export async function createPurchaseUrlAndGetCode() {
    await Project.createAndSwitch();
    await Payments.setup();
    await Project.updateConfig({
      payments: {
        testMode: false,
        products: {
          "test-product": {
            displayName: "Test Product",
            customerType: "user",
            serverOnly: false,
            stackable: false,
            prices: {
              "monthly": {
                USD: "1000",
                interval: [1, "month"],
              },
            },
            includedItems: {},
          },
        },
      },
    });

    const { userId } = await User.create();
    const response = await niceBackendFetch("/api/latest/payments/purchases/create-purchase-url", {
      method: "POST",
      accessType: "server",
      body: {
        customer_type: "user",
        customer_id: userId,
        product_id: "test-product",
      },
    });
    expect(response.status).toBe(200);
    const body = response.body as { url: string };
    expect(body.url).toMatch(new RegExp(`^https?:\/\/localhost:${withPortPrefix("01")}\/purchase\/[a-z0-9-_]+$`));
    const codeMatch = body.url.match(/\/purchase\/([a-z0-9-_]+)/);
    const code = codeMatch ? codeMatch[1] : undefined;
    expect(code).toBeDefined();

    return {
      code,
    };
  }

  export async function sendStripeWebhook(
    payload: unknown,
    options?: {
      invalidSignature?: boolean,
      omitSignature?: boolean,
      secret?: string,
    }
  ) {
    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (!options?.omitSignature) {
      let header: string;
      if (options?.invalidSignature) {
        header = `t=${timestamp},v1=dead`;
      } else {
        const hmac = createHmac("sha256", options?.secret ?? "mock_stripe_webhook_secret");
        hmac.update(`${timestamp}.${JSON.stringify(payload)}`);
        const signature = hmac.digest("hex");
        header = `t=${timestamp},v1=${signature}`;
      }
      headers["stripe-signature"] = header;
    }
    const res = await niceBackendFetch("/api/latest/integrations/stripe/webhooks", {
      method: "POST",
      headers,
      body: payload,
    });
    // The webhook route acks Stripe immediately and processes the event in a
    // fire-and-forget background task. E2E tests read side effects (transactions,
    // subscriptions, ...) right after, so we deterministically wait for that
    // background work to finish before returning. Only do this when the event was
    // actually accepted for processing (a successful, non-deduplicated ack);
    // signature-rejection tests never spawn background work.
    if (res.status === 200 && res.body?.received === true && res.body?.deduplicated !== true) {
      await flushBackgroundTasks();
    }
    return res;
  }

}

// Waits for any in-flight background tasks (e.g. async Stripe webhook processing)
// to finish. Backed by the internal flush-background-tasks endpoint.
export async function flushBackgroundTasks() {
  const res = await withInternalProject(async () => {
    return await niceBackendFetch("/api/latest/internal/flush-background-tasks", {
      method: "POST",
      accessType: "admin",
      body: {},
    });
  });
  expect(res.status).toBe(200);
}
