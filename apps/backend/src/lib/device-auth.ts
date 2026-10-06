import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { Prisma } from "@/generated/prisma/client";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { Tenancy } from "./tenancies";
import { revokeRefreshTokenSession } from "./tokens";

/**
 * The "sign in on another device" flow shared by CLI login and agent auth.
 *
 *   1. The device (CLI, agent) creates an attempt and gets two codes: a
 *      `pollingCode` it keeps secret and a `loginCode` it shows to the human.
 *   2. A human opens the confirm page in a browser and *completes* the attempt,
 *      which attaches a refresh token to it. The human may also *deny* it.
 *   3. The device polls with its polling code and receives that refresh token
 *      exactly once (`usedAt`), after which the attempt is spent.
 *
 * An attempt can carry an anonymous session (`anonRefreshToken`) that the
 * device is already using before the human confirms; what happens to it on
 * completion is up to the flow (the CLI lets the browser claim it, agents get
 * theirs revoked once they hold the real session).
 *
 * Attempts live in the tenancy's source-of-truth database. Everything that
 * changes state is a single conditional UPDATE so two racing callers (two
 * polls, approve vs. deny, ...) cannot both win.
 */

export type DeviceAuthAttempt = Prisma.DeviceAuthAttemptGetPayload<Record<string, never>>;

/**
 * `waiting` — nobody has confirmed yet; `success` — confirmed, refresh token
 * not yet picked up by the device; the rest are terminal. Same vocabulary the
 * poll endpoints use on the wire.
 */
export const deviceAuthAttemptStatuses = ["waiting", "success", "denied", "expired", "used"] as const;
export type DeviceAuthAttemptStatus = typeof deviceAuthAttemptStatuses[number];

export function getDeviceAuthAttemptStatus(attempt: Pick<DeviceAuthAttempt, "usedAt" | "deniedAt" | "refreshToken" | "expiresAt">, now = new Date()): DeviceAuthAttemptStatus {
  if (attempt.usedAt != null) return "used";
  if (attempt.deniedAt != null) return "denied";
  if (attempt.expiresAt < now) return "expired";
  if (attempt.refreshToken != null) return "success";
  return "waiting";
}

const pendingAttemptWhere = (tenancyId: string, attemptId: string) => ({
  tenancyId,
  id: attemptId,
  refreshToken: null,
  deniedAt: null,
  usedAt: null,
  expiresAt: { gt: new Date() },
});

export type DeviceAuthAgentDescriptor = {
  name: string,
  description: string | null,
  url: string | null,
  userHint: string | null,
};

export async function createDeviceAuthAttempt(options: {
  tenancy: Tenancy,
  expiresInMillis: number,
  anonRefreshToken: string | null,
  /**
   * Generates the code the human will see. Defaults to a long random string
   * (fine when the code only travels inside a URL). Flows whose code is meant
   * to be read aloud or typed pass a short-code generator; collisions with
   * older rows are then possible and retried.
   */
  generateLoginCode?: () => string,
  agent?: DeviceAuthAgentDescriptor,
}): Promise<DeviceAuthAttempt> {
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const generateLoginCode = options.generateLoginCode ?? generateSecureRandomString;
  const maxTries = 5;
  for (let tryNumber = 1; ; tryNumber++) {
    try {
      return await prisma.deviceAuthAttempt.create({
        data: {
          tenancyId: options.tenancy.id,
          pollingCode: generateSecureRandomString(),
          loginCode: generateLoginCode(),
          expiresAt: new Date(Date.now() + options.expiresInMillis),
          anonRefreshToken: options.anonRefreshToken,
          agentName: options.agent?.name ?? null,
          agentDescription: options.agent?.description ?? null,
          agentUrl: options.agent?.url ?? null,
          userHint: options.agent?.userHint ?? null,
        },
      });
    } catch (error) {
      const isLoginCodeCollision = error instanceof Prisma.PrismaClientKnownRequestError
        && error.code === "P2002"
        && options.generateLoginCode != null
        && tryNumber < maxTries;
      if (!isLoginCodeCollision) {
        throw error;
      }
    }
  }
}

export async function getDeviceAuthAttemptByPollingCode(tenancy: Tenancy, pollingCode: string): Promise<DeviceAuthAttempt | null> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const attempt = await prisma.deviceAuthAttempt.findUnique({ where: { pollingCode } });
  // pollingCode is globally unique, so a hit for another tenancy means the
  // caller is using the wrong project keys; treat it as unknown.
  return attempt?.tenancyId === tenancy.id ? attempt : null;
}

/** Returns the attempt for a human-facing code, or null unless it is still waiting for confirmation. */
export async function getWaitingDeviceAuthAttemptByLoginCode(tenancy: Tenancy, loginCode: string): Promise<DeviceAuthAttempt | null> {
  const prisma = await getPrismaClientForTenancy(tenancy);
  const attempt = await prisma.deviceAuthAttempt.findUnique({ where: { loginCode } });
  if (attempt == null || attempt.tenancyId !== tenancy.id || getDeviceAuthAttemptStatus(attempt) !== "waiting") {
    return null;
  }
  return attempt;
}

/** Attaches the refresh token the device will receive. @returns false if the attempt was no longer waiting. */
export async function completeDeviceAuthAttempt(options: { tenancy: Tenancy, attemptId: string, refreshToken: string }): Promise<boolean> {
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const updated = await prisma.deviceAuthAttempt.updateMany({
    where: pendingAttemptWhere(options.tenancy.id, options.attemptId),
    data: { refreshToken: options.refreshToken },
  });
  return updated.count === 1;
}

/** @returns false if the attempt was no longer waiting. */
export async function denyDeviceAuthAttempt(options: { tenancy: Tenancy, attemptId: string }): Promise<boolean> {
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const updated = await prisma.deviceAuthAttempt.updateMany({
    where: pendingAttemptWhere(options.tenancy.id, options.attemptId),
    data: { deniedAt: new Date() },
  });
  return updated.count === 1;
}

/**
 * Marks a completed attempt as picked up by the device. @returns the refresh
 * token, or null if another poll already took it. Flows call this *after*
 * everything else that could fail (e.g. minting an access token), because a
 * consumed attempt can never be retried.
 */
export async function consumeDeviceAuthAttempt(options: { tenancy: Tenancy, attemptId: string }): Promise<string | null> {
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const claimed = await prisma.deviceAuthAttempt.updateManyAndReturn({
    where: { tenancyId: options.tenancy.id, id: options.attemptId, usedAt: null, refreshToken: { not: null } },
    data: { usedAt: new Date() },
    select: { refreshToken: true },
  });
  if (claimed.length === 0) return null;
  return claimed[0].refreshToken ?? throwErr("consumeDeviceAuthAttempt matched a row without a refresh token; the WHERE clause excludes those", { attemptId: options.attemptId });
}

/**
 * Detaches the anonymous session from a waiting attempt so it can be handed
 * out only once. @returns false if it was already taken or the attempt is no
 * longer waiting.
 */
export async function takeAnonRefreshTokenFromDeviceAuthAttempt(options: { tenancy: Tenancy, attemptId: string, anonRefreshToken: string }): Promise<boolean> {
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const updated = await prisma.deviceAuthAttempt.updateMany({
    where: { ...pendingAttemptWhere(options.tenancy.id, options.attemptId), anonRefreshToken: options.anonRefreshToken },
    data: { anonRefreshToken: null },
  });
  return updated.count === 1;
}

/** Revokes the session behind a refresh token, if it still exists. Used to clean up anonymous device sessions. */
export async function revokeSessionByRefreshToken(options: { tenancyId: string, refreshToken: string }): Promise<void> {
  const session = await globalPrismaClient.projectUserRefreshToken.findUnique({
    where: { refreshToken: options.refreshToken },
    select: { id: true, tenancyId: true },
  });
  if (session == null || session.tenancyId !== options.tenancyId) return;
  await revokeRefreshTokenSession({ tenancyId: options.tenancyId, refreshTokenId: session.id });
}

/**
 * Looks up an unexpired session by its refresh token. Sessions live in the
 * global database (see tokens.tsx); the tenancy check keeps a token from one
 * project from being replayed against another.
 *
 * @returns null if unknown or expired; throws if it belongs to another tenancy.
 */
export async function getRefreshTokenSessionForTenancy(tenancyId: string, refreshToken: string) {
  const session = await globalPrismaClient.$replica().projectUserRefreshToken.findUnique({
    where: { refreshToken },
    select: { id: true, tenancyId: true, projectUserId: true, refreshToken: true, expiresAt: true },
  });
  if (session == null) return null;
  if (session.tenancyId !== tenancyId) {
    throw new StatusError(400, "Refresh token does not belong to this project");
  }
  if (session.expiresAt != null && session.expiresAt < new Date()) return null;
  return session;
}

/**
 * Resolves a refresh token to the anonymous user it belongs to, or null if
 * the token is unknown/expired or the user is not (or no longer) anonymous.
 */
export async function getAnonymousSessionForRefreshToken(tenancy: Tenancy, refreshToken: string | null) {
  if (refreshToken == null) return null;
  const session = await getRefreshTokenSessionForTenancy(tenancy.id, refreshToken);
  if (session == null) return null;

  // ProjectUser lives in the tenancy's source-of-truth DB; the CRUD handler knows the topology.
  let user;
  try {
    user = await usersCrudHandlers.adminRead({
      tenancy,
      user_id: session.projectUserId,
      allowedErrorTypes: [KnownErrors.UserNotFound],
    });
  } catch (error) {
    if (error instanceof KnownErrors.UserNotFound) return null;
    throw error;
  }
  if (!user.is_anonymous) return null;
  return { session, userId: user.id };
}
