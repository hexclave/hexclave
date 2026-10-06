import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { globalPrismaClient } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { validateRedirectUrl as validateRedirectUrlAgainstTrustedDomains } from "@hexclave/shared/dist/utils/redirect-urls";
import { completeDeviceAuthAttempt, consumeDeviceAuthAttempt, createDeviceAuthAttempt, denyDeviceAuthAttempt, DeviceAuthAgentDescriptor, DeviceAuthAttempt, DeviceAuthAttemptStatus, getDeviceAuthAttemptByPollingCode, getDeviceAuthAttemptStatus, getWaitingDeviceAuthAttemptByLoginCode, revokeSessionByRefreshToken } from "./device-auth";
import { getHostedHandlerTrustedDomain, validateRedirectUrl } from "./redirect-urls";
import { getApiUrlForRequest } from "./request-api-url";
import { Tenancy } from "./tenancies";
import { createAuthTokens, generateAccessTokenFromRefreshTokenIfValid, revokeRefreshTokenSession } from "./tokens";

/**
 * Agent auth lets an AI agent obtain its own session on a Hexclave project.
 *
 * It is the device-auth flow (see device-auth.ts) with three twists:
 *   - the attempt describes the agent (`agentName` etc.) so the human can see
 *     who is asking on the confirm page, and the human may *deny* it;
 *   - the agent gets an anonymous session at registration so it can start
 *     right away if the app allows anonymous users;
 *   - approval mints a *new* session on the approving user's account, tagged
 *     with the agent's name (ProjectUserRefreshToken.agentName), instead of
 *     sharing the browser's session. Every existing mechanism — RBAC, teams,
 *     account settings, session revocation — works for agents unchanged, and
 *     revoking the agent never signs the human out.
 */

export const AGENT_AUTH_APP_ID = "agent-auth";

export const agentAuthDefaults = {
  attemptExpiresInMillis: 1000 * 60 * 15,
  maxAttemptExpiresInMillis: 1000 * 60 * 60,
  agentSessionExpiresInMillis: 1000 * 60 * 60 * 24 * 90,
} as const;

// No 0/O/1/I so codes survive being read aloud or retyped from a terminal.
const claimCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const claimCodeLength = 8;

export function isAgentAuthEnabled(tenancy: Tenancy): boolean {
  return tenancy.config.apps.installed[AGENT_AUTH_APP_ID]?.enabled === true;
}

export function assertAgentAuthEnabled(tenancy: Tenancy): void {
  if (!isAgentAuthEnabled(tenancy)) {
    throw new KnownErrors.AgentAuthNotEnabled();
  }
}

export function generateClaimCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(claimCodeLength));
  const chars = Array.from(bytes, (byte) => claimCodeAlphabet[byte % claimCodeAlphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/**
 * Accepts whatever a human typed (lowercase, missing dash, stray spaces) and
 * returns the canonical `XXXX-XXXX` form, or null if it cannot be a claim code.
 */
export function normalizeClaimCode(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (stripped.length !== claimCodeLength) return null;
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}

/**
 * Builds the URL the human opens to approve the agent. Like every other
 * backend-emitted deep link (email verification, team invites, CLI auth), it
 * points at the app's SDK handler (`<app>/<handlerPath>/agent-auth-confirm`),
 * which then redirects to a custom `urls.agentAuthConfirm` route if the
 * developer configured one — the backend never needs to know SDK-side routes.
 *
 * Which app? The CLI flow lets the caller pass `appUrl`; agents can do the
 * same (`app_url`, validated against the trusted domains) when they know
 * which site they are talking to. Otherwise we pick the trusted domain that
 * has a concrete (wildcard-free) base URL, falling back to the Hexclave-hosted
 * handler, which exists for every project and needs no deployment at all.
 */
export function getAgentConfirmHandlerUrl(tenancy: Tenancy, appUrl: string | null): URL {
  if (appUrl != null) {
    if (!validateRedirectUrl(appUrl, tenancy)) {
      throw new KnownErrors.RedirectUrlNotWhitelisted(appUrl);
    }
    // The handler path belongs to the trusted domain the app URL matched; a
    // localhost URL (allowed via allowLocalhost) matches none and gets the default.
    const domain = Object.values(tenancy.config.domains.trustedDomains)
      .find((domain) => validateRedirectUrlAgainstTrustedDomains(appUrl, { allowLocalhost: false, trustedDomains: [domain.baseUrl] }));
    return new URL(domain?.handlerPath ?? "/handler", appUrl);
  }
  const concreteDomain = Object.values(tenancy.config.domains.trustedDomains)
    .find((domain) => domain.baseUrl != null && !domain.baseUrl.includes("*"));
  return concreteDomain?.baseUrl != null
    ? new URL(concreteDomain.handlerPath, concreteDomain.baseUrl)
    : new URL("/handler", getHostedHandlerTrustedDomain(tenancy.project.id));
}

export function getAgentConfirmUrl(handlerUrl: URL, claimCode: string): string {
  const url = new URL(`${handlerUrl.pathname.replace(/\/$/, "")}/agent-auth-confirm`, handlerUrl);
  url.searchParams.set("code", claimCode);
  return url.toString();
}

export type AgentAuthAttempt = DeviceAuthAttempt & { agentName: string };

function isAgentAuthAttempt(attempt: DeviceAuthAttempt): attempt is AgentAuthAttempt {
  return attempt.agentName != null;
}

/**
 * Registers an agent: creates an anonymous user the agent can act as right
 * away, and a device-auth attempt whose login code is the short claim code
 * shown to the human. The anonymous session is minted last so a failed
 * attempt row never leaves behind a live session nobody can find.
 */
export async function registerAgent(options: {
  tenancy: Tenancy,
  agent: DeviceAuthAgentDescriptor,
  expiresInMillis: number,
  fullReq: { headers: Record<string, string[] | undefined> },
}) {
  const { tenancy } = options;
  const anonymousUser = await usersCrudHandlers.adminCreate({
    tenancy,
    data: { is_anonymous: true },
    allowedErrorTypes: [],
  });
  const anonymousTokens = await createAuthTokens({
    tenancy,
    projectUserId: anonymousUser.id,
    apiUrl: getApiUrlForRequest(options.fullReq),
    agentName: options.agent.name,
  });
  let attempt;
  try {
    attempt = await createDeviceAuthAttempt({
      tenancy,
      expiresInMillis: options.expiresInMillis,
      anonRefreshToken: anonymousTokens.refreshToken,
      generateLoginCode: generateClaimCode,
      agent: options.agent,
    });
  } catch (error) {
    // Without the attempt row nothing references this session, so nobody could
    // ever revoke it through the flow.
    await revokeRefreshTokenSession({ tenancyId: tenancy.id, refreshTokenId: anonymousTokens.refreshTokenId });
    throw error;
  }
  return {
    attempt,
    anonymousSession: {
      userId: anonymousUser.id,
      accessToken: anonymousTokens.accessToken,
      refreshToken: anonymousTokens.refreshToken,
    },
  };
}

export async function getWaitingAgentAuthAttemptByClaimCode(tenancy: Tenancy, rawClaimCode: string): Promise<AgentAuthAttempt> {
  const claimCode = normalizeClaimCode(rawClaimCode) ?? throwErr(new KnownErrors.AgentAuthInvalidClaimCode());
  const attempt = await getWaitingDeviceAuthAttemptByLoginCode(tenancy, claimCode);
  if (attempt == null || !isAgentAuthAttempt(attempt)) {
    throw new KnownErrors.AgentAuthInvalidClaimCode();
  }
  return attempt;
}

/**
 * Approves a waiting attempt on behalf of `approvingUserId` by minting a
 * *new* session on their account (tagged with the agent's name) and attaching
 * it to the attempt. Unlike the CLI, the browser's own session is never shared
 * with the agent, so revoking the agent never signs the human out.
 */
export async function approveAgentAuthAttempt(options: {
  tenancy: Tenancy,
  attempt: AgentAuthAttempt,
  approvingUserId: string,
  fullReq: { headers: Record<string, string[] | undefined> },
}): Promise<void> {
  const { tenancy, attempt } = options;
  const tokens = await createAuthTokens({
    tenancy,
    projectUserId: options.approvingUserId,
    expiresAt: new Date(Date.now() + agentAuthDefaults.agentSessionExpiresInMillis),
    apiUrl: getApiUrlForRequest(options.fullReq),
    agentName: attempt.agentName,
  });

  // The session exists before the attempt references it. If the reference is
  // never written (error, or we lost the race against another approve/deny),
  // nobody would ever hand the session to the agent, so it must not linger as
  // a live session on the user's account.
  let completed: boolean;
  try {
    completed = await completeDeviceAuthAttempt({ tenancy, attemptId: attempt.id, refreshToken: tokens.refreshToken });
  } catch (error) {
    await revokeRefreshTokenSession({ tenancyId: tenancy.id, refreshTokenId: tokens.refreshTokenId });
    throw error;
  }
  if (!completed) {
    await revokeRefreshTokenSession({ tenancyId: tenancy.id, refreshTokenId: tokens.refreshTokenId });
    throw new KnownErrors.AgentAuthInvalidClaimCode();
  }
}

/** Denies a waiting attempt and signs the agent out of the anonymous session it got at registration. */
export async function denyAgentAuthAttempt(options: { tenancy: Tenancy, attempt: AgentAuthAttempt }): Promise<void> {
  const { tenancy, attempt } = options;
  if (!await denyDeviceAuthAttempt({ tenancy, attemptId: attempt.id })) {
    throw new KnownErrors.AgentAuthInvalidClaimCode();
  }
  if (attempt.anonRefreshToken != null) {
    await revokeSessionByRefreshToken({ tenancyId: tenancy.id, refreshToken: attempt.anonRefreshToken });
  }
}

export type AgentAuthPollResult =
  | { status: Exclude<DeviceAuthAttemptStatus, "success"> }
  | { status: "success", refreshToken: string, accessToken: string, userId: string };

/**
 * Hands the approved session to the agent exactly once. Everything that can
 * fail (looking the session up, signing the access token) happens *before*
 * the attempt is consumed, because a consumed attempt can never be retried.
 */
export async function pollAgentAuthAttempt(options: {
  tenancy: Tenancy,
  pollToken: string,
  fullReq: { headers: Record<string, string[] | undefined> },
}): Promise<AgentAuthPollResult> {
  const { tenancy } = options;
  const attempt = await getDeviceAuthAttemptByPollingCode(tenancy, options.pollToken);
  if (attempt == null || !isAgentAuthAttempt(attempt)) {
    throw new KnownErrors.InvalidPollingCodeError();
  }

  const status = getDeviceAuthAttemptStatus(attempt);
  if (status !== "success") {
    return { status };
  }
  const refreshToken = attempt.refreshToken ?? throwErr("Device auth attempt in status 'success' has no refresh token; getDeviceAuthAttemptStatus guarantees otherwise", { attemptId: attempt.id });

  const refreshTokenObj = await globalPrismaClient.projectUserRefreshToken.findUnique({
    where: { refreshToken },
    select: { id: true, projectUserId: true, expiresAt: true },
  });
  const accessToken = await generateAccessTokenFromRefreshTokenIfValid({
    tenancy,
    refreshTokenObj,
    apiUrl: getApiUrlForRequest(options.fullReq),
  });
  if (accessToken == null || refreshTokenObj == null) {
    // The approving user revoked the agent's session (or was deleted) between
    // approval and the agent's first poll. Nothing is left to hand over, so
    // spend the attempt and report it like an expired one; the agent has to
    // register again.
    await consumeDeviceAuthAttempt({ tenancy, attemptId: attempt.id });
    return { status: "expired" };
  }

  if (await consumeDeviceAuthAttempt({ tenancy, attemptId: attempt.id }) == null) {
    return { status: "used" };
  }

  // Handoff is when the agent switches identities. The anonymous session it
  // used until now belongs to a throwaway user the human never sees in their
  // account settings, so this is the only place it can be cleaned up.
  if (attempt.anonRefreshToken != null) {
    await revokeSessionByRefreshToken({ tenancyId: tenancy.id, refreshToken: attempt.anonRefreshToken });
  }

  return { status: "success", refreshToken, accessToken, userId: refreshTokenObj.projectUserId };
}
