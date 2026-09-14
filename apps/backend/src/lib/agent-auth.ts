import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { getHostedHandlerTrustedDomain } from "./redirect-urls";
import { getApiUrlForRequest } from "./request-api-url";
import { Tenancy } from "./tenancies";
import { createAuthTokens, generateAccessTokenFromRefreshTokenIfValid } from "./tokens";

/**
 * Agent auth lets an AI agent obtain its own session on a Hexclave project.
 *
 * The flow deliberately does not invent a new principal type or token format.
 * An agent is a *session* on a real user's account, tagged with the agent's
 * name (ProjectUserRefreshToken.agentName), so every existing Hexclave
 * mechanism — RBAC, teams, account settings, session revocation, audit — works
 * for agents unchanged. What is new is how that session comes to exist:
 *
 *   1. register  — the agent describes itself and immediately gets an
 *                  anonymous session (so it can start right away if the app
 *                  allows anonymous users) plus a short claim code.
 *   2. confirm   — a signed-in user opens the confirm page, sees which agent
 *                  is asking, and approves or denies.
 *   3. poll      — the agent exchanges its poll token, exactly once, for the
 *                  new session on the approving user's account.
 *
 * The shape mirrors the CLI device flow (auth/cli), which is well understood
 * by tools already. It differs in that the agent receives a *new* session
 * rather than a copy of the browser's refresh token, so revoking the agent
 * never signs the human out.
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

export function getAgentConfirmUrl(tenancy: Tenancy, claimCode: string): string {
  // Prefer the developer's own app so the user approves where they are already
  // signed in; fall back to the Hexclave-hosted handler, which exists for every
  // project and needs no deployment at all.
  const firstDomain = Object.values(tenancy.config.domains.trustedDomains)
    .find((domain) => domain.baseUrl != null && !domain.baseUrl.includes("*"));
  const base = firstDomain?.baseUrl != null
    ? new URL(firstDomain.handlerPath, firstDomain.baseUrl)
    : new URL("/handler", getHostedHandlerTrustedDomain(tenancy.project.id));
  const url = new URL(`${base.pathname.replace(/\/$/, "")}/agent-auth-confirm`, base);
  url.searchParams.set("code", claimCode);
  return url.toString();
}

export type AgentAuthAttemptStatus = "pending" | "approved" | "denied" | "expired" | "used";

export function getAgentAuthAttemptStatus(attempt: {
  usedAt: Date | null,
  deniedAt: Date | null,
  approvedAt: Date | null,
  expiresAt: Date,
}): AgentAuthAttemptStatus {
  if (attempt.usedAt != null) return "used";
  if (attempt.deniedAt != null) return "denied";
  if (attempt.approvedAt != null) return "approved";
  if (attempt.expiresAt < new Date()) return "expired";
  return "pending";
}

export type AgentDescriptor = {
  name: string,
  description: string | null,
  url: string | null,
};

export async function createAgentAuthAttempt(options: {
  tenancy: Tenancy,
  agent: AgentDescriptor,
  userHint: string | null,
  expiresInMillis: number,
  fullReq: { headers: Record<string, string[] | undefined> },
}) {
  const { tenancy } = options;
  const prisma = await getPrismaClientForTenancy(tenancy);

  const anonymousUser = await usersCrudHandlers.adminCreate({
    tenancy,
    data: { is_anonymous: true },
    allowedErrorTypes: [],
  });

  const pollToken = generateSecureRandomString();
  const expiresAt = new Date(Date.now() + options.expiresInMillis);

  // Claim codes are short, so a collision within one tenancy is unlikely but
  // possible. Retry a few times before giving up.
  for (let attemptNumber = 0; ; attemptNumber++) {
    const claimCode = generateClaimCode();
    const existing = await prisma.agentAuthAttempt.findUnique({
      where: { tenancyId_claimCode: { tenancyId: tenancy.id, claimCode } },
      select: { id: true },
    });
    if (existing != null) {
      if (attemptNumber >= 5) {
        throw new HexclaveAssertionError("Could not generate a unique agent auth claim code after several tries", { tenancyId: tenancy.id });
      }
      continue;
    }
    const attempt = await prisma.agentAuthAttempt.create({
      data: {
        tenancyId: tenancy.id,
        agentName: options.agent.name,
        agentDescription: options.agent.description,
        agentUrl: options.agent.url,
        userHint: options.userHint,
        claimCode,
        pollToken,
        anonProjectUserId: anonymousUser.id,
        expiresAt,
      },
    });
    // The anonymous session is minted last: if the attempt row fails to write,
    // no refresh token exists that nobody can revoke through the flow. If
    // token minting itself fails, the attempt is a pending row with a claim
    // code nobody knows, which simply expires.
    const anonymousTokens = await createAuthTokens({
      tenancy,
      projectUserId: anonymousUser.id,
      apiUrl: getApiUrlForRequest(options.fullReq),
      agentName: options.agent.name,
    });
    return {
      attempt,
      anonymousSession: {
        userId: anonymousUser.id,
        accessToken: anonymousTokens.accessToken,
        refreshToken: anonymousTokens.refreshToken,
      },
    };
  }
}

export async function getPendingAgentAuthAttemptByClaimCode(tenancy: Tenancy, rawClaimCode: string) {
  const claimCode = normalizeClaimCode(rawClaimCode) ?? throwErr(new KnownErrors.AgentAuthInvalidClaimCode());
  const prisma = await getPrismaClientForTenancy(tenancy);
  const attempt = await prisma.agentAuthAttempt.findUnique({
    where: { tenancyId_claimCode: { tenancyId: tenancy.id, claimCode } },
  });
  if (attempt == null || getAgentAuthAttemptStatus(attempt) !== "pending") {
    throw new KnownErrors.AgentAuthInvalidClaimCode();
  }
  return attempt;
}

/**
 * Approves a pending attempt on behalf of `approvingUserId`, minting the
 * agent's session. The UPDATE is conditional on the attempt still being
 * pending so two concurrent approvals (or an approval racing a denial) cannot
 * both succeed; the loser sees the attempt as no longer pending.
 */
export async function approveAgentAuthAttempt(options: {
  tenancy: Tenancy,
  attemptId: string,
  agentName: string,
  approvingUserId: string,
  fullReq: { headers: Record<string, string[] | undefined> },
}) {
  const { tenancy } = options;
  const prisma = await getPrismaClientForTenancy(tenancy);

  const tokens = await createAuthTokens({
    tenancy,
    projectUserId: options.approvingUserId,
    expiresAt: new Date(Date.now() + agentAuthDefaults.agentSessionExpiresInMillis),
    apiUrl: getApiUrlForRequest(options.fullReq),
    agentName: options.agentName,
  });

  const revokeMintedSession = async () => {
    await globalPrismaClient.projectUserRefreshToken.deleteMany({
      where: { tenancyId: tenancy.id, refreshToken: tokens.refreshToken },
    });
  };

  let updated;
  try {
    updated = await prisma.agentAuthAttempt.updateMany({
      where: {
        tenancyId: tenancy.id,
        id: options.attemptId,
        approvedAt: null,
        deniedAt: null,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: {
        approvedAt: new Date(),
        approvedByUserId: options.approvingUserId,
        refreshToken: tokens.refreshToken,
      },
    });
  } catch (error) {
    // The session was minted before the attempt could reference it; without
    // that reference nobody would ever hand it to the agent, so it must not
    // linger as a live session on the user's account.
    await revokeMintedSession();
    throw error;
  }

  if (updated.count === 0) {
    // We lost the race; the session we just minted must not outlive it.
    await revokeMintedSession();
    throw new KnownErrors.AgentAuthInvalidClaimCode();
  }
}

export async function denyAgentAuthAttempt(options: { tenancy: Tenancy, attemptId: string }) {
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const updated = await prisma.agentAuthAttempt.updateMany({
    where: {
      tenancyId: options.tenancy.id,
      id: options.attemptId,
      approvedAt: null,
      deniedAt: null,
      usedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { deniedAt: new Date() },
  });
  if (updated.count === 0) {
    throw new KnownErrors.AgentAuthInvalidClaimCode();
  }

  // A denied agent should not keep acting as the anonymous user it got at
  // registration, so revoke that user's sessions as part of the denial.
  const attempt = await prisma.agentAuthAttempt.findUnique({
    where: { tenancyId_id: { tenancyId: options.tenancy.id, id: options.attemptId } },
    select: { anonProjectUserId: true },
  });
  if (attempt?.anonProjectUserId != null) {
    await globalPrismaClient.projectUserRefreshToken.deleteMany({
      where: { tenancyId: options.tenancy.id, projectUserId: attempt.anonProjectUserId },
    });
  }
}

export type AgentAuthPollResult =
  | { status: "pending" }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "used" }
  | { status: "approved", refreshToken: string, accessToken: string, userId: string };

/**
 * Hands the agent's session to the poller exactly once. The refresh token is
 * cleared in the same conditional UPDATE that sets usedAt, so a second poller
 * (or a replay) can never retrieve it.
 *
 * Everything that can fail (looking up the session, signing the access token)
 * happens *before* that UPDATE. Consuming first would turn a transient error
 * into a permanent one: the agent would retry and only ever see `used`.
 */
export async function pollAgentAuthAttempt(options: {
  tenancy: Tenancy,
  pollToken: string,
  fullReq: { headers: Record<string, string[] | undefined> },
}): Promise<AgentAuthPollResult> {
  const { tenancy } = options;
  const prisma = await getPrismaClientForTenancy(tenancy);
  const attempt = await prisma.agentAuthAttempt.findUnique({ where: { pollToken: options.pollToken } });
  if (attempt == null || attempt.tenancyId !== tenancy.id) {
    throw new KnownErrors.AgentAuthInvalidPollToken();
  }

  const status = getAgentAuthAttemptStatus(attempt);
  if (status !== "approved") {
    return { status };
  }

  const refreshToken = attempt.refreshToken ?? throwErr("Approved agent auth attempt has no refresh token; approveAgentAuthAttempt always sets both together", { attemptId: attempt.id });
  const userId = attempt.approvedByUserId ?? throwErr("Approved agent auth attempt has no approving user; approveAgentAuthAttempt always sets both together", { attemptId: attempt.id });

  const refreshTokenObj = await globalPrismaClient.projectUserRefreshToken.findUnique({
    where: { refreshToken },
    select: { id: true, projectUserId: true, expiresAt: true },
  });
  const accessToken = await generateAccessTokenFromRefreshTokenIfValid({
    tenancy,
    refreshTokenObj,
    apiUrl: getApiUrlForRequest(options.fullReq),
  });
  if (accessToken == null) {
    // The approving user revoked the agent session (or was deleted) between
    // approval and the agent's first poll. Nothing is left to hand over, so
    // consume the attempt and report it like an expired one; the agent has
    // to register again.
    await prisma.agentAuthAttempt.updateMany({
      where: { tenancyId: tenancy.id, id: attempt.id, usedAt: null },
      data: { usedAt: new Date(), refreshToken: null },
    });
    return { status: "expired" };
  }

  const claimed = await prisma.agentAuthAttempt.updateMany({
    where: { tenancyId: tenancy.id, id: attempt.id, usedAt: null, refreshToken: { not: null } },
    data: { usedAt: new Date(), refreshToken: null },
  });
  if (claimed.count === 0) {
    return { status: "used" };
  }

  return { status: "approved", refreshToken, accessToken, userId };
}
