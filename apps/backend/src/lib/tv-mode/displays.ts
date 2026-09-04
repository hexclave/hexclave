import { Prisma } from "@/generated/prisma/client";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import { lockTvProfileDisplayAssignment, resolveTvProfile } from "@/lib/tv-mode/profiles";
import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { signJWT, verifyJWT } from "@hexclave/shared/dist/utils/jwt";
import { yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import type { TvDisplayResource } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { createHmac } from "node:crypto";
import { logEvent, SystemEventTypes, type TvDisplaySecurityAction } from "@/lib/events";
import { getBillingTeamId } from "@/lib/plan-entitlements";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { captureError, HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";

export const TV_DISPLAY_POLLING_INTERVAL_SECONDS = 5;
export const TV_DISPLAY_REFRESH_COOKIE = "hexclave-tv-display-refresh";
const TV_DISPLAY_AUDIENCE = "hexclave-tv-display";
const TV_DISPLAY_ISSUER = "hexclave-tv-display";
const CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;
const PAIRING_CODE_INSERT_ATTEMPTS = 5;
const REFRESH_IDLE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const USED_CREDENTIAL_REPLAY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const USED_CREDENTIAL_CLEANUP_LIMIT = 100;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

type DisplayRow = {
  id: string,
  tenancyId: string,
  profileId: string,
  displayName: string,
  pairedAt: Date,
  lastSeenAt: Date | null,
  credentialVersion: number,
  financialVisibilityAcknowledgedAt: Date | null,
};

type ChallengeRow = {
  id: string,
  pairingCode: string,
  state: "PENDING" | "APPROVED" | "CONSUMED" | "REJECTED",
  expiresAt: Date,
  lastPolledAt: Date | null,
  invalidAttempts: number,
  approvedTenancyId: string | null,
  approvedProfileId: string | null,
  approvedDisplayName: string | null,
  approvedByAdminUserId: string | null,
  financialVisibilityAcknowledgedAt: Date | null,
};

type CredentialRow = {
  id: string,
  displayId: string,
  familyId: string,
  expiresAt: Date,
  usedAt: Date | null,
  revokedAt: Date | null,
};

type CredentialWithDisplayRow = CredentialRow & Omit<DisplayRow, "id">;

type PairingPollResult =
  | { status: "waiting", retryAfterSeconds: number }
  | { status: "expired" | "rejected" | "used" }
  | { status: "paired", accessToken: string, refreshToken: string, display: DisplayRow };

type RefreshRotationResult =
  | { status: "unavailable" }
  | { status: "reused" }
  | { status: "rotated", id: string, rawToken: string };

export type TvDisplayOperationErrorCode =
  | "tv_display_profile_not_found"
  | "tv_display_exact_financials_acknowledgement_required"
  | "tv_display_pairing_code_invalid";

export class TvDisplayOperationError extends Error {
  override name = "TvDisplayOperationError";

  constructor(readonly code: TvDisplayOperationErrorCode) {
    super(code);
  }
}

export function requireTvDisplayAdminUserId(adminUserId: string | undefined): string {
  if (adminUserId == null) {
    throw new StatusError(StatusError.Forbidden, "tv_display_user_bound_admin_auth_required");
  }
  return adminUserId;
}

function logTvDisplayAuditInBackground(tenancy: Tenancy, options: {
  action: TvDisplaySecurityAction,
  displayId: string | null,
  actorUserId: string | null,
}): void {
  runAsynchronouslyAndWaitUntil((async () => {
    try {
      await logEvent([SystemEventTypes.TvDisplaySecurity], {
        projectId: tenancy.project.id,
        branchId: tenancy.branchId,
        action: options.action,
        displayId: options.displayId,
        actorUserId: options.actorUserId,
      }, { billingTeamId: getBillingTeamId(tenancy.project) });
    } catch (cause) {
      captureError("tv-display-audit-log-failed", new HexclaveAssertionError(
        "Failed to record a TV display security event.",
        { cause, action: options.action, displayId: options.displayId },
      ));
    }
  })());
}

const DisplayAccessTokenSchema = yupObject({
  aud: yupString().oneOf([TV_DISPLAY_AUDIENCE]).defined(),
  displayId: yupString().uuid().defined(),
  credentialVersion: yupNumber().integer().min(1).defined(),
  credentialId: yupString().uuid().defined(),
}).defined();

function secretHash(purpose: string, value: string): string {
  return createHmac("sha256", getEnvVariable("STACK_SERVER_SECRET"))
    .update(`tv-display:${purpose}:`)
    .update(value)
    .digest("hex");
}

function generatePairingCode(): string {
  return generateSecureRandomString(40).toUpperCase().slice(0, 8);
}

async function signDisplayAccessToken(display: DisplayRow, credentialId: string): Promise<string> {
  return await signJWT({
    issuer: TV_DISPLAY_ISSUER,
    audience: TV_DISPLAY_AUDIENCE,
    expirationTime: "10min",
    payload: {
      displayId: display.id,
      credentialVersion: display.credentialVersion,
      credentialId,
    },
  });
}

export async function decodeDisplayAccessToken(token: string): Promise<{
  displayId: string,
  credentialVersion: number,
  credentialId: string,
} | null> {
  try {
    const payload = await verifyJWT({ allowedIssuers: [TV_DISPLAY_ISSUER], jwt: token });
    return await DisplayAccessTokenSchema.validate(payload, { strict: true });
  } catch {
    return null;
  }
}

export async function createTvDisplayPairingChallenge(
  now = new Date(),
  pairingCodeFactory: () => string = generatePairingCode,
) {
  const deviceSecret = generateSecureRandomString();
  const expiresAt = new Date(now.getTime() + CHALLENGE_LIFETIME_MS);
  for (let attempt = 0; attempt < PAIRING_CODE_INSERT_ATTEMPTS; attempt += 1) {
    const id = crypto.randomUUID();
    const pairingCode = pairingCodeFactory();
    const inserted = await globalPrismaClient.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "TvDisplayPairingChallenge" (
        "id", "pairingCode", "deviceSecretHash", "expiresAt", "updatedAt"
      ) VALUES (
        ${id}::UUID, ${pairingCode}, ${secretHash("device-secret", deviceSecret)}, ${expiresAt}, ${now}
      )
      ON CONFLICT ("pairingCode") DO NOTHING
      RETURNING "id"
    `;
    if (inserted.length === 0) continue;
    await globalPrismaClient.$executeRaw`
      DELETE FROM "TvDisplayPairingChallenge"
      WHERE "id" IN (
        SELECT "id" FROM "TvDisplayPairingChallenge"
        WHERE "expiresAt" < ${now}
        ORDER BY "expiresAt"
        LIMIT 100
      )
    `;
    return { challengeId: id, pairingCode, deviceSecret, expiresAt };
  }
  throw new HexclaveAssertionError("TV display pairing code generation exhausted its bounded collision retries.");
}

export async function consumeTvDisplayPairingRateLimit(options: {
  identity: string,
  operation: "challenge-create-minute" | "challenge-create-hour" | "approval-admin" | "approval-ip",
  windowMs: number,
  limit: number,
  now?: Date,
}): Promise<boolean> {
  const now = options.now ?? new Date();
  const windowStart = new Date(Math.floor(now.getTime() / options.windowMs) * options.windowMs);
  const expiresAt = new Date(windowStart.getTime() + options.windowMs * 2);
  const rows = await globalPrismaClient.$queryRaw<Array<{ attempts: number }>>(Prisma.sql`
    INSERT INTO "TvDisplayPairingRateLimitBucket" (
      "keyHash", "operation", "windowStart", "attempts", "expiresAt"
    ) VALUES (
      ${secretHash("rate-limit", options.identity)}, ${options.operation}, ${windowStart}, 1, ${expiresAt}
    )
    ON CONFLICT ("keyHash", "operation", "windowStart")
    DO UPDATE SET "attempts" = "TvDisplayPairingRateLimitBucket"."attempts" + 1
    RETURNING "attempts"
  `);
  // Pairing traffic is rare, so bounded opportunistic cleanup avoids adding a
  // permanent scheduler solely for ephemeral security buckets. It is hygiene,
  // not part of the security decision, so it must not invalidate this increment.
  try {
    await globalPrismaClient.$executeRaw`
      DELETE FROM "TvDisplayPairingRateLimitBucket"
      WHERE ("keyHash", "operation", "windowStart") IN (
        SELECT "keyHash", "operation", "windowStart"
        FROM "TvDisplayPairingRateLimitBucket"
        WHERE "expiresAt" < ${now}
        ORDER BY "expiresAt"
        LIMIT 100
      )
    `;
  } catch (cause) {
    captureError("tv-display-rate-limit-cleanup-failed", new HexclaveAssertionError(
      "Opportunistic TV display rate-limit bucket cleanup failed.",
      { cause },
    ));
  }
  return (rows.at(0) ?? throwErr("TV display rate-limit upsert returned no bucket.")).attempts <= options.limit;
}

export async function refundTvDisplayPairingRateLimit(options: {
  identity: string,
  operation: "approval-admin" | "approval-ip",
  windowMs: number,
  now?: Date,
}): Promise<void> {
  const now = options.now ?? new Date();
  const windowStart = new Date(Math.floor(now.getTime() / options.windowMs) * options.windowMs);
  await globalPrismaClient.$executeRaw`
    UPDATE "TvDisplayPairingRateLimitBucket"
    SET "attempts" = GREATEST(0, "attempts" - 1)
    WHERE "keyHash" = ${secretHash("rate-limit", options.identity)}
      AND "operation" = ${options.operation}
      AND "windowStart" = ${windowStart}
  `;
}

export async function approveTvDisplayPairing(options: {
  tenancy: Tenancy,
  pairingCode: string,
  profileId: string,
  displayName: string,
  adminUserId: string,
  acknowledgeExactFinancials: boolean,
  now?: Date,
}): Promise<{ approvedAt: Date, expiresAt: Date }> {
  const now = options.now ?? new Date();
  const approval = await retryTransaction(globalPrismaClient, async (transaction) => {
    await lockTvProfileDisplayAssignment(transaction, options.tenancy.id, options.profileId);
    const profile = await resolveTvProfile(options.tenancy, options.profileId, transaction);
    if (profile == null) throw new TvDisplayOperationError("tv_display_profile_not_found");
    const exact = profile.configuration.financialVisibility === "exact";
    if (exact && !options.acknowledgeExactFinancials) {
      throw new TvDisplayOperationError("tv_display_exact_financials_acknowledgement_required");
    }
    const updated = await transaction.$queryRaw<Array<{ expiresAt: Date }>>(Prisma.sql`
      UPDATE "TvDisplayPairingChallenge"
      SET
        "state" = 'APPROVED'::"TvDisplayPairingState",
        "approvedTenancyId" = ${options.tenancy.id}::UUID,
        "approvedProfileId" = ${profile.id},
        "approvedDisplayName" = ${options.displayName.trim()},
        "approvedByAdminUserId" = ${options.adminUserId}::UUID,
        "approvedAt" = ${now},
        "financialVisibilityAcknowledgedAt" = ${exact ? now : null},
        "updatedAt" = ${now}
      WHERE "pairingCode" = ${options.pairingCode.replaceAll("-", "").toUpperCase()}
        AND "state" = 'PENDING'::"TvDisplayPairingState"
        AND "expiresAt" > ${now}
      RETURNING "expiresAt"
    `);
    const approved = updated.at(0);
    if (approved == null) throw new TvDisplayOperationError("tv_display_pairing_code_invalid");
    return { approvedAt: now, expiresAt: approved.expiresAt };
  });
  logTvDisplayAuditInBackground(options.tenancy, {
    action: "pairing-approved",
    displayId: null,
    actorUserId: options.adminUserId,
  });
  return approval;
}

async function getChallenge(challengeId: string): Promise<ChallengeRow | null> {
  const rows = await globalPrismaClient.$queryRaw<ChallengeRow[]>(Prisma.sql`
    SELECT "id", "pairingCode", "state", "expiresAt", "lastPolledAt", "invalidAttempts",
      "approvedTenancyId", "approvedProfileId", "approvedDisplayName", "approvedByAdminUserId",
      "financialVisibilityAcknowledgedAt"
    FROM "TvDisplayPairingChallenge"
    WHERE "id" = ${challengeId}::UUID
    LIMIT 1
  `);
  return rows.at(0) ?? null;
}

export async function pollTvDisplayPairing(options: {
  challengeId: string,
  deviceSecret: string,
  now?: Date,
}): Promise<PairingPollResult> {
  const now = options.now ?? new Date();
  const challenge = await getChallenge(options.challengeId);
  if (challenge == null) return { status: "expired" };
  if (challenge.expiresAt <= now) return { status: "expired" };
  if (challenge.state === "REJECTED") return { status: "rejected" };
  if (challenge.state === "CONSUMED") return { status: "used" };
  const validSecretRows = await globalPrismaClient.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
    SELECT EXISTS(
      SELECT 1 FROM "TvDisplayPairingChallenge"
      WHERE "id" = ${options.challengeId}::UUID
        AND "deviceSecretHash" = ${secretHash("device-secret", options.deviceSecret)}
    ) AS "valid"
  `);
  if (validSecretRows.at(0)?.valid !== true) {
    // The challenge UUID is not an authenticator. Mutating shared challenge
    // state on an invalid high-entropy secret would let UUID disclosure become
    // a denial-of-service primitive against the legitimate display.
    return { status: "rejected" };
  }
  if (challenge.lastPolledAt != null && now.getTime() - challenge.lastPolledAt.getTime() < TV_DISPLAY_POLLING_INTERVAL_SECONDS * 1000) {
    return { status: "waiting", retryAfterSeconds: TV_DISPLAY_POLLING_INTERVAL_SECONDS };
  }
  await globalPrismaClient.$executeRaw`
    UPDATE "TvDisplayPairingChallenge" SET "lastPolledAt" = ${now}, "updatedAt" = ${now}
    WHERE "id" = ${options.challengeId}::UUID AND "state" <> 'CONSUMED'::"TvDisplayPairingState"
  `;
  if (challenge.state === "PENDING") return { status: "waiting", retryAfterSeconds: TV_DISPLAY_POLLING_INTERVAL_SECONDS };

  if (challenge.approvedTenancyId == null || challenge.approvedProfileId == null
    || challenge.approvedDisplayName == null || challenge.approvedByAdminUserId == null) {
    throw new Error("Approved TV pairing challenge has incomplete assignment data.");
  }
  const approvedTenancyId = challenge.approvedTenancyId;
  const approvedProfileId = challenge.approvedProfileId;
  const approvedDisplayName = challenge.approvedDisplayName;
  const approvedByAdminUserId = challenge.approvedByAdminUserId;
  const result = await retryTransaction(globalPrismaClient, async (transaction) => {
    const tenancyRows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "Tenancy"
      WHERE "id" = ${approvedTenancyId}::UUID
      FOR KEY SHARE
    `);
    if (tenancyRows.length === 0) {
      await transaction.$executeRaw`
        UPDATE "TvDisplayPairingChallenge"
        SET "state" = 'REJECTED'::"TvDisplayPairingState", "rejectedAt" = ${now}, "updatedAt" = ${now}
        WHERE "id" = ${challenge.id}::UUID
          AND "state" = 'APPROVED'::"TvDisplayPairingState"
      `;
      const rejected: PairingPollResult = { status: "rejected" };
      return rejected;
    }
    const claimed = await transaction.$queryRaw<ChallengeRow[]>(Prisma.sql`
      UPDATE "TvDisplayPairingChallenge"
      SET "state" = 'CONSUMED'::"TvDisplayPairingState", "consumedAt" = ${now}, "updatedAt" = ${now}
      WHERE "id" = ${challenge.id}::UUID
        AND "state" = 'APPROVED'::"TvDisplayPairingState"
        AND "expiresAt" > ${now}
      RETURNING "id", "pairingCode", "state", "expiresAt", "lastPolledAt", "invalidAttempts",
        "approvedTenancyId", "approvedProfileId", "approvedDisplayName", "approvedByAdminUserId",
        "financialVisibilityAcknowledgedAt"
    `);
    if (claimed.length === 0) {
      const used: PairingPollResult = { status: "used" };
      return used;
    }
    const displayId = crypto.randomUUID();
    const displays = await transaction.$queryRaw<DisplayRow[]>(Prisma.sql`
      INSERT INTO "TvDisplay" (
        "id", "tenancyId", "profileId", "displayName",
        "pairedByAdminUserId", "pairedAt", "financialVisibilityAcknowledgedAt",
        "financialVisibilityAcknowledgedByAdminUserId", "updatedAt"
      ) VALUES (
        ${displayId}::UUID, ${approvedTenancyId}::UUID, ${approvedProfileId}, ${approvedDisplayName},
        ${approvedByAdminUserId}::UUID, ${now}, ${challenge.financialVisibilityAcknowledgedAt},
        ${challenge.financialVisibilityAcknowledgedAt == null ? null : approvedByAdminUserId}::UUID, ${now}
      )
      RETURNING "id", "tenancyId", "profileId", "displayName", "pairedAt", "lastSeenAt",
        "credentialVersion", "financialVisibilityAcknowledgedAt"
    `);
    const display = displays.at(0) ?? throwErr("TV display insert returned no display.");
    const rawToken = generateSecureRandomString();
    const credentialId = crypto.randomUUID();
    const familyId = crypto.randomUUID();
    await transaction.$executeRaw`
      INSERT INTO "TvDisplayCredential" (
        "id", "displayId", "familyId", "tokenHash", "expiresAt"
      ) VALUES (
        ${credentialId}::UUID, ${display.id}::UUID, ${familyId}::UUID,
        ${secretHash("refresh", rawToken)}, ${new Date(now.getTime() + REFRESH_IDLE_LIFETIME_MS)}
      )
    `;
    const paired: PairingPollResult = {
      status: "paired",
      accessToken: await signDisplayAccessToken(display, credentialId),
      refreshToken: rawToken,
      display,
    };
    return paired;
  });
  if (result.status === "paired") {
    const tenancy = await getTenancy(result.display.tenancyId);
    if (tenancy != null) {
      logTvDisplayAuditInBackground(tenancy, {
        action: "credential-issued",
        displayId: result.display.id,
        actorUserId: approvedByAdminUserId,
      });
    }
  }
  return result;
}

export async function getAuthorizedTvDisplay(accessToken: string, now = new Date()): Promise<{
  display: DisplayRow,
  tenancy: Tenancy,
} | null> {
  const token = await decodeDisplayAccessToken(accessToken);
  if (token == null) return null;
  // This is intentionally a primary, data-modifying CTE: display deletion and
  // credential-version checks must be immediate, while last-seen writes remain
  // throttled to once per minute per display.
  const rows = await globalPrismaClient.$queryRaw<DisplayRow[]>(Prisma.sql`
    WITH authorized AS (
      SELECT "id", "tenancyId", "profileId", "displayName", "pairedAt", "lastSeenAt",
        "credentialVersion", "financialVisibilityAcknowledgedAt"
      FROM "TvDisplay"
      WHERE "id" = ${token.displayId}::UUID
        AND "credentialVersion" = ${token.credentialVersion}
      LIMIT 1
    ), touched AS (
      UPDATE "TvDisplay" AS display
      SET "lastSeenAt" = ${now}, "updatedAt" = ${now}
      FROM authorized
      WHERE display."id" = authorized."id"
        AND (authorized."lastSeenAt" IS NULL OR authorized."lastSeenAt" <= ${new Date(now.getTime() - LAST_SEEN_WRITE_INTERVAL_MS)})
      RETURNING display."id", display."lastSeenAt"
    )
    SELECT authorized."id", authorized."tenancyId", authorized."profileId", authorized."displayName",
      authorized."pairedAt", COALESCE(touched."lastSeenAt", authorized."lastSeenAt") AS "lastSeenAt",
      authorized."credentialVersion", authorized."financialVisibilityAcknowledgedAt"
    FROM authorized
    LEFT JOIN touched ON touched."id" = authorized."id"
  `);
  const display = rows.at(0);
  if (display == null) return null;
  const tenancy = await getTenancy(display.tenancyId);
  return tenancy == null ? null : { display, tenancy };
}

export async function refreshTvDisplayCredential(rawRefreshToken: string, now = new Date()): Promise<{
  accessToken: string,
  refreshToken: string,
} | null> {
  const rows = await globalPrismaClient.$queryRaw<CredentialWithDisplayRow[]>(Prisma.sql`
    SELECT c."id", c."displayId", c."familyId", c."expiresAt", c."usedAt", c."revokedAt",
      d."tenancyId", d."profileId", d."displayName", d."pairedAt", d."lastSeenAt",
      d."credentialVersion", d."financialVisibilityAcknowledgedAt"
    FROM "TvDisplayCredential" c
    JOIN "TvDisplay" d ON d."id" = c."displayId"
    WHERE c."tokenHash" = ${secretHash("refresh", rawRefreshToken)}
    LIMIT 1
  `);
  const credential = rows.at(0);
  if (credential == null || credential.revokedAt != null) return null;
  const replayHistoryCutoff = new Date(now.getTime() - USED_CREDENTIAL_REPLAY_LIFETIME_MS);
  // Expired replay-history rows may remain while a display is offline because
  // cleanup is deliberately rotation-scoped. They are still unauthorized and
  // must not revoke a legitimate descendant credential after the 24-hour window.
  if (credential.usedAt != null && credential.usedAt < replayHistoryCutoff) return null;
  if (credential.usedAt != null) {
    const familyWasRevoked = await retryTransaction(globalPrismaClient, async (transaction) => {
      // Parent-first lock ordering matches display deletion's cascade order. If
      // credential mutation locked the child first, concurrent unpairing could
      // form a child→parent / parent→child deadlock.
      const displays = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "TvDisplay"
        WHERE "id" = ${credential.displayId}::UUID
        FOR UPDATE
      `;
      if (displays.length === 0) return false;
      if (displays.length !== 1) throw new HexclaveAssertionError("TV display credential lock returned an unexpected row set.");
      await transaction.$executeRaw`
        UPDATE "TvDisplayCredential" SET "revokedAt" = ${now}
        WHERE "displayId" = ${credential.displayId}::UUID AND "familyId" = ${credential.familyId}::UUID AND "revokedAt" IS NULL
      `;
      await transaction.$executeRaw`
        UPDATE "TvDisplay" SET "credentialVersion" = "credentialVersion" + 1, "updatedAt" = ${now}
        WHERE "id" = ${credential.displayId}::UUID
      `;
      return true;
    });
    if (familyWasRevoked) {
      const tenancy = await getTenancy(credential.tenancyId);
      if (tenancy != null) {
        logTvDisplayAuditInBackground(tenancy, {
          action: "refresh-reuse-detected",
          displayId: credential.displayId,
          actorUserId: null,
        });
      }
    }
    return null;
  }
  if (credential.expiresAt <= now) return null;
  const replacement = await retryTransaction(globalPrismaClient, async (transaction): Promise<RefreshRotationResult> => {
    // Lock the parent before the child credential for the same reason as the
    // replay path above. A missing parent means unpairing already committed.
    const displays = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "TvDisplay"
      WHERE "id" = ${credential.displayId}::UUID
      FOR UPDATE
    `;
    if (displays.length === 0) return { status: "unavailable" };
    if (displays.length !== 1) throw new HexclaveAssertionError("TV display credential lock returned an unexpected row set.");
    const consumed = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE "TvDisplayCredential" SET "usedAt" = ${now}
      WHERE "id" = ${credential.id}::UUID AND "usedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > ${now}
      RETURNING "id"
    `);
    if (consumed.length === 0) {
      // A request that lost the single-use compare-and-swap is itself replay
      // evidence. Revoke while this transaction still owns the credential row
      // lock so a concurrent winner's replacement cannot survive the family bump.
      await transaction.$executeRaw`
        UPDATE "TvDisplayCredential" SET "revokedAt" = ${now}
        WHERE "displayId" = ${credential.displayId}::UUID
          AND "familyId" = ${credential.familyId}::UUID
          AND "revokedAt" IS NULL
      `;
      await transaction.$executeRaw`
        UPDATE "TvDisplay" SET "credentialVersion" = "credentialVersion" + 1, "updatedAt" = ${now}
        WHERE "id" = ${credential.displayId}::UUID
      `;
      return { status: "reused" };
    }
    const rawToken = generateSecureRandomString();
    const id = crypto.randomUUID();
    await transaction.$executeRaw`
      INSERT INTO "TvDisplayCredential" (
        "id", "displayId", "familyId", "tokenHash", "parentId", "expiresAt"
      ) VALUES (
        ${id}::UUID, ${credential.displayId}::UUID, ${credential.familyId}::UUID,
        ${secretHash("refresh", rawToken)}, ${credential.id}::UUID,
        ${new Date(now.getTime() + REFRESH_IDLE_LIFETIME_MS)}
      )
    `;
    await transaction.$executeRaw`
      UPDATE "TvDisplayCredential" SET "replacementId" = ${id}::UUID WHERE "id" = ${credential.id}::UUID
    `;
    const deletedCredentialCount = await transaction.$executeRaw`
      DELETE FROM "TvDisplayCredential"
      WHERE "displayId" = ${credential.displayId}::UUID
        AND "familyId" = ${credential.familyId}::UUID
        AND "id" IN (
          SELECT "id"
          FROM "TvDisplayCredential"
          WHERE "displayId" = ${credential.displayId}::UUID
            AND "familyId" = ${credential.familyId}::UUID
            AND "usedAt" < ${replayHistoryCutoff}
          ORDER BY "usedAt", "id"
          LIMIT ${USED_CREDENTIAL_CLEANUP_LIMIT}
        )
    `;
    if (deletedCredentialCount > USED_CREDENTIAL_CLEANUP_LIMIT) {
      throw new HexclaveAssertionError("TV display credential cleanup exceeded its per-family bound.");
    }
    return { status: "rotated", id, rawToken };
  });
  if (replacement.status === "unavailable") return null;
  if (replacement.status === "reused") {
    const tenancy = await getTenancy(credential.tenancyId);
    if (tenancy != null) {
      logTvDisplayAuditInBackground(tenancy, {
        action: "refresh-reuse-detected",
        displayId: credential.displayId,
        actorUserId: null,
      });
    }
    return null;
  }
  const display: DisplayRow = {
    id: credential.displayId,
    tenancyId: credential.tenancyId,
    profileId: credential.profileId,
    displayName: credential.displayName,
    pairedAt: credential.pairedAt,
    lastSeenAt: credential.lastSeenAt,
    credentialVersion: credential.credentialVersion,
    financialVisibilityAcknowledgedAt: credential.financialVisibilityAcknowledgedAt,
  };
  return {
    accessToken: await signDisplayAccessToken(display, replacement.id),
    refreshToken: replacement.rawToken,
  };
}

export async function listTvDisplays(tenancy: Tenancy, now = new Date()) {
  // This low-volume admin list follows pairing mutations, so read it from the primary for read-after-write consistency.
  const rows = await globalPrismaClient.$primary().$queryRaw<DisplayRow[]>(Prisma.sql`
    SELECT "id", "tenancyId", "profileId", "displayName", "pairedAt", "lastSeenAt",
      "credentialVersion", "financialVisibilityAcknowledgedAt"
    FROM "TvDisplay"
    WHERE "tenancyId" = ${tenancy.id}::UUID
    ORDER BY "updatedAt" DESC, "id"
  `);
  return await Promise.all(rows.map(async (display) => await getTvDisplayResource(tenancy, display, now)));
}

export async function getTvDisplayResource(tenancy: Tenancy, display: DisplayRow, now = new Date()): Promise<TvDisplayResource> {
  const profile = await resolveTvProfile(tenancy, display.profileId);
  const acknowledgementIsCurrent = profile?.configuration.financialVisibility !== "exact"
    || (display.financialVisibilityAcknowledgedAt != null
      && (profile.updatedAt == null || display.financialVisibilityAcknowledgedAt >= new Date(profile.updatedAt)));
  return {
    id: display.id,
    displayName: display.displayName,
    profileId: display.profileId,
    profileDisplayName: profile?.configuration.displayName ?? "Profile Unavailable",
    profileFinancialVisibility: profile?.configuration.financialVisibility ?? "redacted",
    state: display.lastSeenAt == null
      ? "never-connected"
      : now.getTime() - display.lastSeenAt.getTime() <= 2 * 60 * 1000
        ? "online"
        : "offline",
    pairedAt: display.pairedAt.toISOString(),
    lastSeenAt: display.lastSeenAt?.toISOString() ?? null,
    exactFinancialsAcknowledged: acknowledgementIsCurrent,
  };
}

export async function deleteTvDisplay(
  tenancy: Tenancy,
  displayId: string,
  actorUserId: string | null = null,
): Promise<boolean> {
  const rows = await globalPrismaClient.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    DELETE FROM "TvDisplay"
    WHERE "id" = ${displayId}::UUID
      AND "tenancyId" = ${tenancy.id}::UUID
    RETURNING "id"
  `);
  if (rows.length === 0) return false;
  if (rows.length !== 1) {
    throw new HexclaveAssertionError("TV display deletion returned an unexpected row set.");
  }
  logTvDisplayAuditInBackground(tenancy, {
    action: "display-revoked",
    displayId: rows[0]?.id ?? throwErr("TV display deletion returned no display ID."),
    actorUserId,
  });
  return true;
}

export async function updateTvDisplay(options: {
  tenancy: Tenancy,
  displayId: string,
  displayName: string,
  profileId: string,
  adminUserId: string,
  acknowledgeExactFinancials: boolean,
  now?: Date,
}): Promise<boolean> {
  const now = options.now ?? new Date();
  const result = await retryTransaction(globalPrismaClient, async (transaction) => {
    await lockTvProfileDisplayAssignment(transaction, options.tenancy.id, options.profileId);
    const profile = await resolveTvProfile(options.tenancy, options.profileId, transaction);
    if (profile == null) throw new TvDisplayOperationError("tv_display_profile_not_found");
    const exact = profile.configuration.financialVisibility === "exact";
    if (exact && !options.acknowledgeExactFinancials) {
      throw new TvDisplayOperationError("tv_display_exact_financials_acknowledgement_required");
    }
    const rows = await transaction.$queryRaw<Array<{ displayName: string, profileId: string }>>(Prisma.sql`
      SELECT "displayName", "profileId"
      FROM "TvDisplay"
      WHERE "id" = ${options.displayId}::UUID
        AND "tenancyId" = ${options.tenancy.id}::UUID
      FOR UPDATE
    `);
    const existing = rows.at(0);
    if (existing == null) return { previous: null, assignedProfileId: profile.id };
    await transaction.$executeRaw`
      UPDATE "TvDisplay"
      SET "displayName" = ${options.displayName.trim()},
        "profileId" = ${profile.id},
        "financialVisibilityAcknowledgedAt" = ${exact ? now : null},
        "financialVisibilityAcknowledgedByAdminUserId" = ${exact ? options.adminUserId : null}::UUID,
        "updatedAt" = ${now}
      WHERE "id" = ${options.displayId}::UUID
    `;
    return { previous: existing, assignedProfileId: profile.id };
  });
  const previous = result.previous;
  if (previous != null && previous.displayName !== options.displayName.trim()) {
    logTvDisplayAuditInBackground(options.tenancy, {
      action: "display-renamed",
      displayId: options.displayId,
      actorUserId: options.adminUserId,
    });
  }
  if (previous != null && previous.profileId !== result.assignedProfileId) {
    logTvDisplayAuditInBackground(options.tenancy, {
      action: "profile-reassigned",
      displayId: options.displayId,
      actorUserId: options.adminUserId,
    });
  }
  return previous != null;
}
