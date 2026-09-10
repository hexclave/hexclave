import { BooleanTrue, Prisma } from "@/generated/prisma/client";
import { buildCreatedFieldsAuditMetadata, buildUpdatedFieldsAuditMetadata, recordAuditEvent, shouldRecordAdminAudit, type AuditActorSource } from "@/lib/audit-log";
import { getRenderedOrganizationConfigQuery, getRenderedProjectConfigQuery } from "@/lib/config";
import { demoteAllContactChannelsToNonPrimary, setContactChannelAsPrimaryByValue } from "@/lib/contact-channel";
import { normalizeEmail } from "@/lib/emails";
import { arePlanLimitsEnforced, getBillingTeamId, getTeamWideAuthUsersCapacity, getTeamWideNonAnonymousUserCount } from "@/lib/plan-entitlements";
import { recordExternalDbSyncContactChannelDeletionsForUser, recordExternalDbSyncDeletion, recordExternalDbSyncNotificationPreferenceDeletionsForUser, recordExternalDbSyncOAuthAccountDeletionsForUser, recordExternalDbSyncProjectPermissionDeletionsForUser, recordExternalDbSyncRefreshTokenDeletionsForUser, recordExternalDbSyncTeamMemberDeletionsForUser, recordExternalDbSyncTeamPermissionDeletionsForUser, withExternalDbSyncUpdate } from "@/lib/external-db-sync";
import { grantDefaultProjectPermissions } from "@/lib/permissions";
import { ensureTeamMembershipExists, ensureUserExists } from "@/lib/request-checks";
import { Tenancy } from "@/lib/tenancies";
import { PrismaTransaction } from "@/lib/types";
import { sendTeamMembershipDeletedWebhook, sendUserCreatedWebhook, sendUserDeletedWebhook, sendUserUpdatedWebhook } from "@/lib/webhooks";
import { enqueueWorkflowEvent } from "@/lib/workflows/events";
import { PrismaClientTransaction, RawQuery, getPrismaClientForSourceOfTruth, getPrismaClientForTenancy, getPrismaSchemaForSourceOfTruth, globalPrismaClient, rawQuery, retryTransaction, sqlQuoteIdent } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { uploadAndGetUrl } from "@/s3";
import { log } from "@/utils/telemetry";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { KnownErrors } from "@hexclave/shared";
import { currentUserCrud } from "@hexclave/shared/dist/interface/crud/current-user";
import { UsersCrud, usersCrud } from "@hexclave/shared/dist/interface/crud/users";
import type { RestrictedReason } from "@hexclave/shared/dist/schema-fields";
import { userIdOrMeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { validateBase64Image } from "@hexclave/shared/dist/utils/base64";
import { decodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError, captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { hashPassword, isPasswordHashValid } from "@hexclave/shared/dist/utils/hashes";
import { has } from "@hexclave/shared/dist/utils/objects";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import { teamPrismaToCrud, teamsCrudHandlers } from "../teams/crud";

// Secrets / opaque credentials — never put these in audit metadata (paths or values).
const USER_UPDATE_AUDIT_EXCLUDED_FIELDS = new Set([
  "password",
  "password_hash",
  "totp_secret_base64",
]);

async function recordUserDirectoryAuditsFromUpdate(options: {
  auth: AuditActorSource & { tenancy: Tenancy },
  targetUserId: string,
  data: UsersCrud["Admin"]["Update"],
  beforeUser: UsersCrud["Admin"]["Read"],
  afterUser: UsersCrud["Admin"]["Read"],
}): Promise<void> {
  if (!shouldRecordAdminAudit(options.auth)) {
    return;
  }

  const { auth, targetUserId, data } = options;
  const coveredBySpecializedAction = new Set<string>();

  if (data.restricted_by_admin === true) {
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "user.restricted",
      targetUserId,
      reason: typeof data.restricted_by_admin_reason === "string" ? data.restricted_by_admin_reason : null,
      metadata: { source: "users.update" },
    });
    coveredBySpecializedAction.add("restricted_by_admin");
    coveredBySpecializedAction.add("restricted_by_admin_reason");
    coveredBySpecializedAction.add("restricted_by_admin_private_details");
  } else if (data.restricted_by_admin === false) {
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "user.unrestricted",
      targetUserId,
      metadata: { source: "users.update" },
    });
    coveredBySpecializedAction.add("restricted_by_admin");
    coveredBySpecializedAction.add("restricted_by_admin_reason");
    coveredBySpecializedAction.add("restricted_by_admin_private_details");
  }

  if (data.password !== undefined || data.password_hash !== undefined) {
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "user.password.set",
      targetUserId,
      metadata: { source: "users.update" },
    });
    coveredBySpecializedAction.add("password");
    coveredBySpecializedAction.add("password_hash");
  }

  if (data.totp_secret_base64 === null) {
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "user.mfa.removed",
      targetUserId,
      metadata: { source: "users.update" },
    });
    coveredBySpecializedAction.add("totp_secret_base64");
  } else if (data.totp_secret_base64 !== undefined) {
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "user.mfa.enabled",
      targetUserId,
      metadata: { source: "users.update" },
    });
    coveredBySpecializedAction.add("totp_secret_base64");
  }

  // Secrets stay out of the patch entirely; non-sensitive leaves get before/after
  // from the pre/post CRUD snapshots so the Compliance details column can render them.
  const patchForAudit: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (USER_UPDATE_AUDIT_EXCLUDED_FIELDS.has(key)) continue;
    if (coveredBySpecializedAction.has(key)) continue;
    patchForAudit[key] = value;
  }
  const metadata = buildUpdatedFieldsAuditMetadata({
    source: "users.update",
    patch: patchForAudit,
    beforeRoot: options.beforeUser,
    afterRoot: options.afterUser,
  });
  if (metadata != null) {
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "user.updated",
      targetUserId,
      metadata,
    });
  }
}

export const userFullInclude = {
  projectUserOAuthAccounts: true,
  authMethods: {
    include: {
      passwordAuthMethod: true,
      otpAuthMethod: true,
      oauthAuthMethod: true,
      passkeyAuthMethod: true,
    }
  },
  contactChannels: true,
  teamMembers: {
    include: {
      team: true,
    },
    where: {
      isSelected: BooleanTrue.TRUE,
    },
  },
} satisfies Prisma.ProjectUserInclude;

const getPersonalTeamDisplayName = (userDisplayName: string | null, userPrimaryEmail: string | null) => {
  if (userDisplayName) {
    return `${userDisplayName}'s Team`;
  }
  if (userPrimaryEmail) {
    return `${userPrimaryEmail}'s Team`;
  }
  return personalTeamDefaultDisplayName;
};

const personalTeamDefaultDisplayName = "Personal Team";
// Keep in sync with the Users table parser. This validates exact domains only;
// excluding gmail.com intentionally does not exclude mail.gmail.com.
const emailDomainRegex = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const maxExcludedEmailDomains = 100; // to prevent abuse
// Prisma loads each userFullInclude relation with a follow-up query whose IN-list over
// the composite key (tenancyId, projectUserId) uses two bind parameters per user. The
// former whole-tenancy path hit PostgreSQL's 65535-parameter limit at ~32.7k users
// (32.5k OK, 33k -> "bind message has 465 parameter formats but 0 parameters") and
// already took 10.6s at 30k users.
const maxListPageSize = 1000;

function getSignedUpAtMillis(signedUpAt: Date): number {
  return signedUpAt.getTime();
}

// lowercases, strips leading @, handles duplicates to validate domains
function normalizeExcludedEmailDomains(rawDomains: string | undefined): string[] {
  if (rawDomains === undefined || rawDomains.trim() === "") {
    return [];
  }

  const normalizedDomains = new Map<string, true>();
  for (const rawDomain of rawDomains.split(",")) { // expects comma-separated list of domains
    const domain = rawDomain.trim().replace(/^@/, "").toLowerCase();
    if (domain === "") {
      continue;
    }
    if (!emailDomainRegex.test(domain)) {
      throw new StatusError(StatusError.BadRequest, "excluded_email_domains must be a comma-separated list of valid domains");
    }
    normalizedDomains.set(domain, true);
  }

  if (normalizedDomains.size > maxExcludedEmailDomains) {
    throw new StatusError(StatusError.BadRequest, `excluded_email_domains cannot contain more than ${maxExcludedEmailDomains} domains`);
  }

  return [...normalizedDomains.keys()];
}

async function createPersonalTeamIfEnabled(prisma: PrismaClientTransaction, tenancy: Tenancy, user: UsersCrud["Admin"]["Read"]) {
  if (tenancy.config.teams.createPersonalTeamOnSignUp) {
    const team = await teamsCrudHandlers.adminCreate({
      data: {
        display_name: getPersonalTeamDisplayName(user.display_name, user.primary_email),
        creator_user_id: 'me',
      },
      tenancy: tenancy,
      user,
    });

    await prisma.teamMember.update({
      where: {
        tenancyId_projectUserId_teamId: {
          tenancyId: tenancy.id,
          projectUserId: user.id,
          teamId: team.id,
        },
      },
      data: {
        isSelected: BooleanTrue.TRUE,
      },
    });
  }
}

type OnboardingConfig = {
  onboarding: {
    requireEmailVerification?: boolean,
  },
};

/**
 * Computes the restricted status and reason for a user based on their data and config.
 * A user can be "restricted" for various reasons, for example if they've signed up but haven't completed onboarding
 * requirements, or they've been restricted by an administrator via sign-up rules or manual admin action.
 *
 * The config parameter accepts any object with an optional `onboarding.requireEmailVerification` property.
 * This allows passing various config types (EnvironmentRenderedConfig, CompleteConfig, etc.) without type errors.
 */
export function computeRestrictedStatus<T extends OnboardingConfig>(
  isAnonymous: boolean,
  primaryEmailVerified: boolean,
  config: T,
  restrictedByAdmin?: boolean,
): { isRestricted: false, restrictedReason: null } | { isRestricted: true, restrictedReason: RestrictedReason } {
  // note: when you implement this function, make sure to also update the filter in the list users endpoint

  // Anonymous users are always restricted (they need to sign up first)
  if (isAnonymous) {
    return { isRestricted: true, restrictedReason: { type: "anonymous" } };
  }

  // Check email verification requirement (default to false if not configured)
  // This takes precedence over admin restriction because it's user-actionable
  if (config.onboarding.requireEmailVerification && !primaryEmailVerified) {
    return { isRestricted: true, restrictedReason: { type: "email_not_verified" } };
  }

  // Check if user was restricted by administrator (e.g., via sign-up rules or manual admin action)
  if (restrictedByAdmin) {
    return { isRestricted: true, restrictedReason: { type: "restricted_by_administrator" } };
  }

  // EXTENSIBILITY: Add more conditions here in the future
  // e.g., phone verification, manual approval, etc.

  return { isRestricted: false, restrictedReason: null };
}

export const userPrismaToCrud = (
  prisma: Prisma.ProjectUserGetPayload<{ include: typeof userFullInclude }>,
  config: OnboardingConfig,
): UsersCrud["Admin"]["Read"] => {
  const lastActiveAtMillis = prisma.lastActiveAt.getTime();
  const selectedTeamMembers = prisma.teamMembers;
  if (selectedTeamMembers.length > 1) {
    throw new HexclaveAssertionError("User cannot have more than one selected team; this should never happen");
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const primaryEmailContactChannel = prisma.contactChannels.find((c) => c.type === 'EMAIL' && c.isPrimary);
  const passwordAuth = prisma.authMethods.find((m) => m.passwordAuthMethod);
  const otpAuth = prisma.authMethods.find((m) => m.otpAuthMethod);
  const passkeyAuth = prisma.authMethods.find((m) => m.passkeyAuthMethod);

  const primaryEmailVerified = !!primaryEmailContactChannel?.isVerified;
  const { isRestricted, restrictedReason } = computeRestrictedStatus(
    prisma.isAnonymous,
    primaryEmailVerified,
    config,
    prisma.restrictedByAdmin,
  );

  const result = {
    id: prisma.projectUserId,
    display_name: prisma.displayName || null,
    primary_email: primaryEmailContactChannel?.value || null,
    primary_email_verified: primaryEmailVerified,
    primary_email_auth_enabled: !!primaryEmailContactChannel?.usedForAuth,
    profile_image_url: prisma.profileImageUrl,
    signed_up_at_millis: getSignedUpAtMillis(prisma.signedUpAt),
    client_metadata: prisma.clientMetadata,
    client_read_only_metadata: prisma.clientReadOnlyMetadata,
    server_metadata: prisma.serverMetadata,
    has_password: !!passwordAuth,
    otp_auth_enabled: !!otpAuth,
    auth_with_email: !!passwordAuth || !!otpAuth,
    requires_totp_mfa: prisma.requiresTotpMfa,
    passkey_auth_enabled: !!passkeyAuth,
    oauth_providers: prisma.projectUserOAuthAccounts.map((a) => ({
      id: a.configOAuthProviderId,
      account_id: a.providerAccountId,
      email: a.email,
    })),
    selected_team_id: selectedTeamMembers[0]?.teamId ?? null,
    selected_team: selectedTeamMembers[0] ? teamPrismaToCrud(selectedTeamMembers[0]?.team) : null,
    last_active_at_millis: lastActiveAtMillis,
    is_anonymous: prisma.isAnonymous,
    is_restricted: isRestricted,
    restricted_reason: restrictedReason,
    restricted_by_admin: prisma.restrictedByAdmin,
    restricted_by_admin_reason: prisma.restrictedByAdminReason,
    restricted_by_admin_private_details: prisma.restrictedByAdminPrivateDetails,
    country_code: prisma.signUpCountryCode,
    risk_scores: {
      sign_up: {
        bot: prisma.signUpRiskScoreBot,
        free_trial_abuse: prisma.signUpRiskScoreFreeTrialAbuse,
      },
    },
  };
  return result;
};

async function getPasswordHashFromData(data: {
  password?: string | null,
  password_hash?: string,
}) {
  if (data.password !== undefined) {
    if (data.password_hash !== undefined) {
      throw new StatusError(400, "Cannot set both password and password_hash at the same time.");
    }
    if (data.password === null) {
      return null;
    }
    return await hashPassword(data.password);
  } else if (data.password_hash !== undefined) {
    if (!await isPasswordHashValid(data.password_hash)) {
      throw new StatusError(400, "Invalid password hash. Make sure it's a supported algorithm in Modular Crypt Format.");
    }
    return data.password_hash;
  } else {
    return undefined;
  }
}

async function checkAuthData(
  tx: PrismaTransaction,
  data: {
    tenancyId: string,
    oldPrimaryEmail?: string | null,
    primaryEmail?: string | null,
    primaryEmailVerified: boolean,
    primaryEmailAuthEnabled: boolean,
  }
) {
  if (!data.primaryEmail && data.primaryEmailAuthEnabled) {
    throw new StatusError(400, "primary_email_auth_enabled cannot be true without primary_email");
  }
  if (!data.primaryEmail && data.primaryEmailVerified) {
    throw new StatusError(400, "primary_email_verified cannot be true without primary_email");
  }
  if (!data.primaryEmailAuthEnabled) return;
  if (!data.oldPrimaryEmail || data.oldPrimaryEmail !== data.primaryEmail) {
    if (!data.primaryEmail) {
      throw new HexclaveAssertionError("primary_email_auth_enabled cannot be true without primary_email");
    }
    const existingChannelUsedForAuth = await tx.contactChannel.findFirst({
      where: {
        tenancyId: data.tenancyId,
        type: 'EMAIL',
        value: data.primaryEmail,
        usedForAuth: BooleanTrue.TRUE,
      }
    });

    if (existingChannelUsedForAuth) {
      throw new KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse("email", data.primaryEmail);
    }
  }
}

async function checkAuthUsersSoftLimit(tenancy: Tenancy) {
  // Seed creates dummy-project users via raw Prisma before the bulldozer
  // payments ledger has been ingressed, so every read here would see
  // capacity=0 and flood logs. Bulldozer's seed-time invariant is that
  // nothing reads the ledger until runBulldozerPaymentsInit runs post-seed;
  // we honor that here rather than forcing seed to double-init.
  if (getEnvVariable('STACK_SEED_MODE', '') === 'true') {
    return;
  }
  if (!arePlanLimitsEnforced()) {
    return;
  }
  const billingTeamId = getBillingTeamId(tenancy.project);
  if (billingTeamId == null) {
    return;
  }
  const usage = await getTeamWideNonAnonymousUserCount(billingTeamId);
  const capacity = await getTeamWideAuthUsersCapacity(billingTeamId);
  if (usage > capacity) {
    captureError("auth-users-plan-soft-limit-exceeded", new HexclaveAssertionError(
      "Auth users soft limit exceeded for billing team",
      { ownerTeamId: billingTeamId, usage, capacity, projectId: tenancy.project.id },
    ));
  }
}

export function getUserQuery(projectId: string, branchId: string, userId: string, schema: string, config: OnboardingConfig): RawQuery<UsersCrud["Admin"]["Read"] | null> {
  return {
    supportedPrismaClients: ["source-of-truth"],
    readOnlyQuery: true,
    sql: Prisma.sql`
      SELECT to_json(
        (
          SELECT (
            to_jsonb("ProjectUser".*) ||
            jsonb_build_object(
              'ContactChannels', (
                SELECT COALESCE(ARRAY_AGG(
                  to_jsonb("ContactChannel") ||
                  jsonb_build_object()
                ), '{}')
                FROM ${sqlQuoteIdent(schema)}."ContactChannel"
                WHERE "ContactChannel"."tenancyId" = "ProjectUser"."tenancyId" AND "ContactChannel"."projectUserId" = "ProjectUser"."projectUserId" AND "ContactChannel"."isPrimary" = 'TRUE'
              ),
              'ProjectUserOAuthAccounts', (
                SELECT COALESCE(ARRAY_AGG(
                  to_jsonb("ProjectUserOAuthAccount")
                ), '{}')
                FROM ${sqlQuoteIdent(schema)}."ProjectUserOAuthAccount"
                WHERE "ProjectUserOAuthAccount"."tenancyId" = "ProjectUser"."tenancyId" AND "ProjectUserOAuthAccount"."projectUserId" = "ProjectUser"."projectUserId"
              ),
              'AuthMethods', (
                SELECT COALESCE(ARRAY_AGG(
                  to_jsonb("AuthMethod") ||
                  jsonb_build_object(
                    'PasswordAuthMethod', (
                      SELECT (
                        to_jsonb("PasswordAuthMethod") ||
                        jsonb_build_object()
                      )
                      FROM ${sqlQuoteIdent(schema)}."PasswordAuthMethod"
                      WHERE "PasswordAuthMethod"."tenancyId" = "ProjectUser"."tenancyId" AND "PasswordAuthMethod"."projectUserId" = "ProjectUser"."projectUserId" AND "PasswordAuthMethod"."authMethodId" = "AuthMethod"."id"
                    ),
                    'OtpAuthMethod', (
                      SELECT (
                        to_jsonb("OtpAuthMethod") ||
                        jsonb_build_object()
                      )
                      FROM ${sqlQuoteIdent(schema)}."OtpAuthMethod"
                      WHERE "OtpAuthMethod"."tenancyId" = "ProjectUser"."tenancyId" AND "OtpAuthMethod"."projectUserId" = "ProjectUser"."projectUserId" AND "OtpAuthMethod"."authMethodId" = "AuthMethod"."id"
                    ),
                    'PasskeyAuthMethod', (
                      SELECT (
                        to_jsonb("PasskeyAuthMethod") ||
                        jsonb_build_object()
                      )
                      FROM ${sqlQuoteIdent(schema)}."PasskeyAuthMethod"
                      WHERE "PasskeyAuthMethod"."tenancyId" = "ProjectUser"."tenancyId" AND "PasskeyAuthMethod"."projectUserId" = "ProjectUser"."projectUserId" AND "PasskeyAuthMethod"."authMethodId" = "AuthMethod"."id"
                    ),
                    'OAuthAuthMethod', (
                      SELECT (
                        to_jsonb("OAuthAuthMethod") ||
                        jsonb_build_object()
                      )
                      FROM ${sqlQuoteIdent(schema)}."OAuthAuthMethod"
                      WHERE "OAuthAuthMethod"."tenancyId" = "ProjectUser"."tenancyId" AND "OAuthAuthMethod"."projectUserId" = "ProjectUser"."projectUserId" AND "OAuthAuthMethod"."authMethodId" = "AuthMethod"."id"
                    )
                  )
                ), '{}')
                FROM ${sqlQuoteIdent(schema)}."AuthMethod"
                WHERE "AuthMethod"."tenancyId" = "ProjectUser"."tenancyId" AND "AuthMethod"."projectUserId" = "ProjectUser"."projectUserId"
              ),
              'SelectedTeamMember', (
                SELECT (
                  to_jsonb("TeamMember") ||
                  jsonb_build_object(
                    'Team', (
                      SELECT (
                        to_jsonb("Team") ||
                        jsonb_build_object()
                      )
                      FROM ${sqlQuoteIdent(schema)}."Team"
                      WHERE "Team"."tenancyId" = "ProjectUser"."tenancyId" AND "Team"."teamId" = "TeamMember"."teamId"
                    )
                  )
                )
                FROM ${sqlQuoteIdent(schema)}."TeamMember"
                WHERE "TeamMember"."tenancyId" = "ProjectUser"."tenancyId" AND "TeamMember"."projectUserId" = "ProjectUser"."projectUserId" AND "TeamMember"."isSelected" = 'TRUE'
              )
            )
          )
          FROM ${sqlQuoteIdent(schema)}."ProjectUser"
          WHERE "ProjectUser"."mirroredProjectId" = ${projectId} AND "ProjectUser"."mirroredBranchId" = ${branchId} AND "ProjectUser"."projectUserId" = ${userId}::UUID
        )
      ) AS "row_data_json"
    `,
    postProcess: (queryResult) => {
      if (queryResult.length !== 1) {
        throw new HexclaveAssertionError(`Expected 1 user with id ${userId} in project ${projectId}, got ${queryResult.length}`, { queryResult });
      }

      const row = queryResult[0].row_data_json;
      if (!row) {
        return null;
      }

      const primaryEmailContactChannel = row.ContactChannels.find((c: any) => c.type === 'EMAIL' && c.isPrimary);
      const passwordAuth = row.AuthMethods.find((m: any) => m.PasswordAuthMethod);
      const otpAuth = row.AuthMethods.find((m: any) => m.OtpAuthMethod);
      const passkeyAuth = row.AuthMethods.find((m: any) => m.PasskeyAuthMethod);

      if (row.SelectedTeamMember && !row.SelectedTeamMember.Team) {
        // This seems to happen in production much more often than it should, so let's log some information for debugging
        captureError("selected-team-member-and-team-consistency", new HexclaveAssertionError("Selected team member has no team? Ignoring it", { row }));
        row.SelectedTeamMember = null;
      }

      const restrictedStatus = computeRestrictedStatus(
        row.isAnonymous,
        primaryEmailContactChannel?.isVerified || false,
        config,
        row.restrictedByAdmin,
      );

      return {
        id: row.projectUserId,
        display_name: row.displayName || null,
        primary_email: primaryEmailContactChannel?.value || null,
        primary_email_verified: primaryEmailContactChannel?.isVerified || false,
        primary_email_auth_enabled: primaryEmailContactChannel?.usedForAuth === 'TRUE' ? true : false,
        profile_image_url: row.profileImageUrl,
        signed_up_at_millis: getSignedUpAtMillis(new Date((row.signedUpAt ?? throwErr("signedUpAt should never be null — anonymous users get createdAt, and the backfill migration ensures all existing rows are populated")) + "Z")),
        client_metadata: row.clientMetadata,
        client_read_only_metadata: row.clientReadOnlyMetadata,
        server_metadata: row.serverMetadata,
        has_password: !!passwordAuth,
        otp_auth_enabled: !!otpAuth,
        auth_with_email: !!passwordAuth || !!otpAuth,
        requires_totp_mfa: row.requiresTotpMfa,
        passkey_auth_enabled: !!passkeyAuth,
        oauth_providers: row.ProjectUserOAuthAccounts.map((a: any) => ({
          id: a.configOAuthProviderId,
          account_id: a.providerAccountId,
          email: a.email,
        })),
        selected_team_id: row.SelectedTeamMember?.teamId ?? null,
        selected_team: row.SelectedTeamMember ? {
          id: row.SelectedTeamMember.Team.teamId,
          display_name: row.SelectedTeamMember.Team.displayName,
          profile_image_url: row.SelectedTeamMember.Team.profileImageUrl,
          created_at_millis: new Date(row.SelectedTeamMember.Team.createdAt + "Z").getTime(),
          client_metadata: row.SelectedTeamMember.Team.clientMetadata,
          client_read_only_metadata: row.SelectedTeamMember.Team.clientReadOnlyMetadata,
          server_metadata: row.SelectedTeamMember.Team.serverMetadata,
        } : null,
        last_active_at_millis: new Date(row.lastActiveAt + "Z").getTime(),
        is_anonymous: row.isAnonymous,
        is_restricted: restrictedStatus.isRestricted,
        restricted_reason: restrictedStatus.restrictedReason,
        restricted_by_admin: row.restrictedByAdmin,
        restricted_by_admin_reason: row.restrictedByAdminReason,
        restricted_by_admin_private_details: row.restrictedByAdminPrivateDetails,
        country_code: row.signUpCountryCode,
        risk_scores: {
          sign_up: {
            bot: row.signUpRiskScoreBot,
            free_trial_abuse: row.signUpRiskScoreFreeTrialAbuse,
          },
        },
      };
    },
  };
}

/**
 * Returns the user object if the source-of-truth is the same as the global Prisma client, otherwise an unspecified value is returned.
 */
export function getUserIfOnGlobalPrismaClientQuery(
  projectId: string,
  branchId: string,
  userId: string,
): RawQuery<Promise<UsersCrud["Admin"]["Read"] | null>> {
  // HACK: Fetch both the user data (with a placeholder config) and the real environment config
  // Then combine them to compute the correct restricted fields
  // This is faster than fetching them sequentially
  const userQueryWithPlaceholderConfig: RawQuery<UsersCrud["Admin"]["Read"] | null> = {
    ...getUserQuery(projectId, branchId, userId, "public", { onboarding: { requireEmailVerification: false } }),
    supportedPrismaClients: ["global"],
  };
  const configQuery = getRenderedOrganizationConfigQuery({ projectId, branchId, forUserId: userId });

  return RawQuery.then(
    RawQuery.all([userQueryWithPlaceholderConfig, configQuery] as const),
    async ([user, configPromise]) => {
      if (!user) {
        return null;
      }
      const config = await configPromise;
      const { isRestricted, restrictedReason } = computeRestrictedStatus(
        user.is_anonymous,
        user.primary_email_verified,
        config,
        user.restricted_by_admin,
      );
      return {
        ...user,
        is_restricted: isRestricted,
        restricted_reason: restrictedReason,
      };
    },
  );
}

export async function getUser(options: { userId: string } & ({ projectId: string, branchId: string } | { tenancy: Tenancy })) {
  let projectId, branchId, sourceOfTruth, config;
  if ("tenancy" in options) {
    projectId = options.tenancy.project.id;
    branchId = options.tenancy.branchId;
    sourceOfTruth = options.tenancy.config.sourceOfTruth;
    config = options.tenancy.config;
  } else {
    projectId = options.projectId;
    branchId = options.branchId;
    const projectConfig = await rawQuery(globalPrismaClient, getRenderedProjectConfigQuery({ projectId }));
    sourceOfTruth = projectConfig.sourceOfTruth;
    config = await rawQuery(globalPrismaClient, getRenderedOrganizationConfigQuery({ projectId, branchId, forUserId: options.userId }));
  }

  const prisma = await getPrismaClientForSourceOfTruth(sourceOfTruth, branchId);
  const schema = await getPrismaSchemaForSourceOfTruth(sourceOfTruth, branchId);
  const result = await rawQuery(prisma, getUserQuery(projectId, branchId, options.userId, schema, config));
  return result;
}


export const usersCrudHandlers = createLazyProxy(() => createCrudHandlers(usersCrud, {
  paramsSchema: yupObject({
    user_id: userIdOrMeSchema.defined(),
  }),
  querySchema: yupObject({
    team_id: yupString().uuid().optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: "Only return users who are members of the given team" } }),
    limit: yupNumber().integer().min(1).max(maxListPageSize).optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: `The maximum number of items to return (capped at ${maxListPageSize}). Larger result sets must be paged with cursor.` } }),
    cursor: yupString().uuid().optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: "The cursor to start the result set from." } }),
    order_by: yupString().oneOf(['signed_up_at', 'last_active_at']).optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: "The field to sort the results by. Defaults to signed_up_at" } }),
    desc: yupString().oneOf(["true", "false"]).optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: "Whether to sort the results in descending order. Defaults to false" } }),
    query: yupString().optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: "A search query to filter the results by. This is a free-text search that is applied to the user's id (exact-match only), display name and primary email." } }),
    excluded_email_domains: yupString().optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: "A comma-separated list of primary email domains to exclude from the results." } }),
    include_anonymous: yupString().oneOf(["true", "false"]).optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: "Whether to include anonymous users in the results. When true, also includes restricted users. Defaults to false" } }),
    only_anonymous: yupString().oneOf(["true", "false"]).optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: "Whether to return only anonymous users. When true, implies include_anonymous=true. Defaults to false" } }),
    include_restricted: yupString().oneOf(["true", "false"]).optional().meta({ openapiField: { onlyShowInOperations: [ 'List' ], description: "Whether to include restricted users in the results. Defaults to false" } }),
  }),
  onRead: async ({ auth, params, query }) => {
    const user = await getUser({ tenancy: auth.tenancy, userId: params.user_id });
    if (!user) {
      throw new KnownErrors.UserNotFound();
    }
    return user;
  },
  onList: async ({ auth, query }) => {
    const queryWithoutSpecialChars = query.query?.replace(/[^a-zA-Z0-9\-_.]/g, '');
    // normalization happens once at the start of the list handling.
    const excludedEmailDomains = normalizeExcludedEmailDomains(query.excluded_email_domains);

    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    // Filtering hierarchy:
    // - No flags: only Normal users (not anonymous, not restricted)
    // - include_restricted=true: Restricted + Normal users (not anonymous)
    // - include_anonymous=true: Anonymous + Restricted + Normal users (everything)
    // - only_anonymous=true with include_anonymous=true: only Anonymous users
    const onlyAnonymous = query.only_anonymous === "true";
    const includeAnonymous = query.include_anonymous === "true";
    if (onlyAnonymous && !includeAnonymous) {
      throw new StatusError(StatusError.BadRequest, "only_anonymous=true requires include_anonymous=true");
    }
    const includeRestricted = query.include_restricted === "true" || includeAnonymous; // include_anonymous also includes restricted

    // TODO: Instead of hardcoding this, we should use computeRestrictedStatus
    const shouldFilterRestrictedByEmail = !includeRestricted && auth.tenancy.config.onboarding.requireEmailVerification;
    const shouldFilterRestrictedByAdmin = !includeRestricted;

    const where = {
      tenancyId: auth.tenancy.id,
      ...query.team_id ? {
        teamMembers: {
          some: {
            teamId: query.team_id,
          },
        },
      } : {},
      ...onlyAnonymous
        ? {
          isAnonymous: true,
        }
        : !includeAnonymous
          ? {
            // Don't return anonymous users unless explicitly requested
            isAnonymous: false,
          }
          : {},
      // Filter out restricted users if needed (restricted = signed up but email not verified)
      ...shouldFilterRestrictedByEmail ? {
        // User must have a verified primary email to not be restricted
        contactChannels: {
          some: {
            type: 'EMAIL' as const,
            isPrimary: 'TRUE' as const,
            isVerified: true,
          },
        },
      } : {},
      ...shouldFilterRestrictedByAdmin ? {
        restrictedByAdmin: false,
      } : {},
      ...excludedEmailDomains.length > 0 ? {
        NOT: {
          contactChannels: {
            some: {
              type: 'EMAIL' as const,
              isPrimary: 'TRUE' as const,
              OR: excludedEmailDomains.map((domain) => ({
                value: {
                  // Exact-domain match: @gmail.com matches user@gmail.com, not user@mail.gmail.com.
                  endsWith: `@${domain}`,
                  mode: 'insensitive' as const,
                },
              })),
            },
          },
        },
      } : {},
      ...query.query ? {
        OR: [
          ...isUuid(queryWithoutSpecialChars!) ? [{
            projectUserId: {
              equals: queryWithoutSpecialChars
            },
          }] : [],
          {
            displayName: {
              contains: query.query,
              mode: 'insensitive',
            },
          },
          {
            contactChannels: {
              some: {
                value: {
                  contains: query.query,
                  mode: 'insensitive',
                },
              },
            },
          },
        ] as any,
      } : {},
    };

    const sortDirection = query.desc === 'true' ? 'desc' : 'asc';
    const db = await prisma.projectUser.findMany({
      where,
      include: userFullInclude,
      orderBy: [
        {
          [({
            signed_up_at: 'signedUpAt',
            last_active_at: 'lastActiveAt',
          } as const)[query.order_by ?? 'signed_up_at']]: sortDirection,
        },
        { projectUserId: sortDirection },
      ],
      // +1 to detect whether a next page exists without a separate count.
      take: query.limit == null ? maxListPageSize + 1 : query.limit + 1,
      // Cursor convention (matches teams/crud.tsx): the client sends the
      // id of the LAST row of the previous page; Prisma starts AT that id,
      // and `skip: 1` drops it so we don't re-emit it.
      ...query.cursor ? {
        skip: 1,
        cursor: {
          tenancyId_projectUserId: {
            tenancyId: auth.tenancy.id,
            projectUserId: query.cursor,
          },
        },
      } : {},
    });

    if (query.limit == null && db.length > maxListPageSize) {
      throw new StatusError(StatusError.BadRequest, `Listing more than ${maxListPageSize} users requires a limit. Pass limit and paginate using cursor.`);
    }

    const items = db.slice(0, query.limit).map((user) => userPrismaToCrud(user, auth.tenancy.config));
    const hasMore = query.limit != null && db.length > query.limit;
    return {
      items,
      is_paginated: true,
      pagination: {
        next_cursor: hasMore && items.length > 0 ? items[items.length - 1].id : null,
      },
    };
  },
  onCreate: async ({ auth, data }) => {
    const primaryEmail = data.primary_email ? normalizeEmail(data.primary_email) : data.primary_email;

    log("create_user_endpoint_primaryAuthEnabled", {
      value: data.primary_email_auth_enabled,
      email: primaryEmail ?? undefined,
      projectId: auth.project.id,
    });

    const passwordHash = await getPasswordHashFromData(data);
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await retryTransaction(prisma, async (tx) => {
      await checkAuthData(tx, {
        tenancyId: auth.tenancy.id,
        primaryEmail: primaryEmail,
        primaryEmailVerified: !!data.primary_email_verified,
        primaryEmailAuthEnabled: !!data.primary_email_auth_enabled,
      });

      const config = auth.tenancy.config;

      // Validate restricted_by_admin fields consistency
      const restrictedByAdmin = data.restricted_by_admin ?? false;
      let restrictedByAdminReason = data.restricted_by_admin_reason === undefined
        ? undefined
        : (data.restricted_by_admin_reason || null);
      let restrictedByAdminPrivateDetails = data.restricted_by_admin_private_details === undefined
        ? undefined
        : (data.restricted_by_admin_private_details || null);

      if (!restrictedByAdmin) {
        if (restrictedByAdminReason != null) {
          throw new StatusError(StatusError.BadRequest, "restricted_by_admin_reason requires restricted_by_admin=true");
        }
        if (restrictedByAdminPrivateDetails != null) {
          throw new StatusError(StatusError.BadRequest, "restricted_by_admin_private_details requires restricted_by_admin=true");
        }
      }

      const newUser = await tx.projectUser.create({
        data: {
          tenancyId: auth.tenancy.id,
          mirroredProjectId: auth.project.id,
          mirroredBranchId: auth.branchId,
          displayName: data.display_name === undefined ? undefined : (data.display_name || null),
          clientMetadata: data.client_metadata === null ? Prisma.JsonNull : data.client_metadata,
          clientReadOnlyMetadata: data.client_read_only_metadata === null ? Prisma.JsonNull : data.client_read_only_metadata,
          serverMetadata: data.server_metadata === null ? Prisma.JsonNull : data.server_metadata,
          totpSecret: data.totp_secret_base64 == null ? data.totp_secret_base64 : Buffer.from(decodeBase64(data.totp_secret_base64)),
          isAnonymous: data.is_anonymous ?? false,
          profileImageUrl: await uploadAndGetUrl(data.profile_image_url, "user-profile-images"),
          restrictedByAdmin,
          restrictedByAdminReason,
          restrictedByAdminPrivateDetails,
          signUpCountryCode: data.country_code,
          signedUpAt: new Date(),
          signUpRiskScoreBot: data.risk_scores?.sign_up.bot ?? 0,
          signUpRiskScoreFreeTrialAbuse: data.risk_scores?.sign_up.free_trial_abuse ?? 0,
        },
        include: userFullInclude,
      });

      if (data.oauth_providers) {
        // create many does not support nested create, so we have to use loop
        for (const provider of data.oauth_providers) {
          if (!has(config.auth.oauth.providers, provider.id)) {
            throw new StatusError(StatusError.BadRequest, `OAuth provider ${provider.id} not found`);
          }

          const authMethod = await tx.authMethod.create({
            data: {
              tenancyId: auth.tenancy.id,
              projectUserId: newUser.projectUserId,
            }
          });

          await tx.projectUserOAuthAccount.create({
            data: {
              tenancyId: auth.tenancy.id,
              projectUserId: newUser.projectUserId,
              configOAuthProviderId: provider.id,
              providerAccountId: provider.account_id,
              email: provider.email,
              oauthAuthMethod: {
                create: {
                  authMethodId: authMethod.id,
                }
              },
              allowConnectedAccounts: true,
              allowSignIn: true,
            }
          });
        }

      }

      if (primaryEmail) {
        await tx.contactChannel.create({
          data: {
            projectUserId: newUser.projectUserId,
            tenancyId: auth.tenancy.id,
            type: 'EMAIL' as const,
            value: primaryEmail,
            isVerified: data.primary_email_verified ?? false,
            isPrimary: "TRUE",
            usedForAuth: data.primary_email_auth_enabled ? BooleanTrue.TRUE : null,
          }
        });
      }

      if (passwordHash) {
        if (!config.auth.password.allowSignIn) {
          throw new StatusError(StatusError.BadRequest, "Password auth not enabled in the project");
        }
        await tx.authMethod.create({
          data: {
            tenancyId: auth.tenancy.id,
            projectUserId: newUser.projectUserId,
            passwordAuthMethod: {
              create: {
                passwordHash,
                projectUserId: newUser.projectUserId,
              }
            }
          }
        });
      }

      if (data.otp_auth_enabled) {
        if (!config.auth.otp.allowSignIn) {
          throw new StatusError(StatusError.BadRequest, "OTP auth not enabled in the project");
        }
        await tx.authMethod.create({
          data: {
            tenancyId: auth.tenancy.id,
            projectUserId: newUser.projectUserId,
            otpAuthMethod: {
              create: {
                projectUserId: newUser.projectUserId,
              }
            }
          }
        });
      }

      // Grant default user permissions
      await grantDefaultProjectPermissions(tx, {
        tenancy: auth.tenancy,
        userId: newUser.projectUserId
      });

      const user = await tx.projectUser.findUnique({
        where: {
          tenancyId_projectUserId: {
            tenancyId: auth.tenancy.id,
            projectUserId: newUser.projectUserId,
          },
        },
        include: userFullInclude,
      });

      if (!user) {
        throw new HexclaveAssertionError("User was created but not found", newUser);
      }

      const crud = userPrismaToCrud(user, auth.tenancy.config);
      // Workflow platform events ride the entity transaction (transactional
      // outbox, at-least-once) — unlike the Svix webhook below, which is
      // fire-and-forget after commit.
      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "user.created", payload: crud });
      return crud;
    });

    await createPersonalTeamIfEnabled(prisma, auth.tenancy, result);

    if (!result.is_anonymous) {
      runAsynchronouslyAndWaitUntil(checkAuthUsersSoftLimit(auth.tenancy));
    }

    runAsynchronouslyAndWaitUntil(sendUserCreatedWebhook({
      projectId: auth.project.id,
      data: result,
    }));

    if (shouldRecordAdminAudit(auth)) {
      // Persist the submitted create fields (not the full user read model) so the
      // Compliance details column can show a red/green diff. Password stays
      // path-only via sensitive-leaf filtering.
      const metadata = buildCreatedFieldsAuditMetadata({
        source: "users.create",
        fields: data,
      }) ?? {
          source: "users.create",
          is_anonymous: result.is_anonymous,
        };
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "user.created",
        targetUserId: result.id,
        metadata,
      });
    }

    return result;
  },
  onUpdate: async ({ auth, data, params }) => {
    const primaryEmail = data.primary_email ? normalizeEmail(data.primary_email) : data.primary_email;
    const passwordHash = await getPasswordHashFromData(data);
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const { user, beforeUser, wasAnonymousUpgrade } = await retryTransaction(prisma, async (tx) => {
      await ensureUserExists(tx, { tenancyId: auth.tenancy.id, userId: params.user_id });

      const config = auth.tenancy.config;

      const oldUser = await tx.projectUser.findUnique({
        where: {
          tenancyId_projectUserId: {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
          },
        },
        include: userFullInclude,
      });

      if (!oldUser) {
        throw new HexclaveAssertionError("User not found");
      }

      if (data.selected_team_id !== undefined) {
        if (data.selected_team_id !== null) {
          await ensureTeamMembershipExists(tx, {
            tenancyId: auth.tenancy.id,
            teamId: data.selected_team_id,
            userId: params.user_id,
          });
        }

        await tx.teamMember.updateMany({
          where: {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
            isSelected: BooleanTrue.TRUE,
          },
          data: {
            isSelected: null,
          },
        });

        if (data.selected_team_id !== null) {
          try {
            await tx.teamMember.update({
              where: {
                tenancyId_projectUserId_teamId: {
                  tenancyId: auth.tenancy.id,
                  projectUserId: params.user_id,
                  teamId: data.selected_team_id,
                },
              },
              data: {
                isSelected: BooleanTrue.TRUE,
              },
            });
          } catch (e) {
            const members = await tx.teamMember.findMany({
              where: {
                tenancyId: auth.tenancy.id,
                projectUserId: params.user_id,
              }
            });
            throw new HexclaveAssertionError("Failed to update team member", {
              cause: e,
              tenancy_id: auth.tenancy.id,
              user_id: params.user_id,
              team_id: data.selected_team_id,
              members,
            });
          }
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      const primaryEmailContactChannel = oldUser.contactChannels.find((c) => c.type === 'EMAIL' && c.isPrimary);
      const otpAuth = oldUser.authMethods.find((m) => m.otpAuthMethod)?.otpAuthMethod;
      const passwordAuth = oldUser.authMethods.find((m) => m.passwordAuthMethod)?.passwordAuthMethod;
      const passkeyAuth = oldUser.authMethods.find((m) => m.passkeyAuthMethod)?.passkeyAuthMethod;

      // Use the explicitly provided primaryEmail if set (even if null), otherwise fall back to existing
      const effectivePrimaryEmail = primaryEmail !== undefined ? primaryEmail : (primaryEmailContactChannel?.value ?? null);
      // If email is being explicitly removed (set to null), force verified and auth enabled to false
      const isRemovingEmail = primaryEmail === null;
      const primaryEmailAuthEnabled = isRemovingEmail
        ? false
        : (data.primary_email_auth_enabled ?? !!primaryEmailContactChannel?.usedForAuth);
      const primaryEmailVerified = isRemovingEmail
        ? false
        : (data.primary_email_verified ?? !!primaryEmailContactChannel?.isVerified);
      await checkAuthData(tx, {
        tenancyId: auth.tenancy.id,
        oldPrimaryEmail: primaryEmailContactChannel?.value,
        primaryEmail: effectivePrimaryEmail,
        primaryEmailVerified,
        primaryEmailAuthEnabled,
      });

      // if there is a new primary email
      // - if the email already exists as a contact channel for this user, upgrade it to primary
      // - if it doesn't exist, create a new primary email contact channel
      // - demote the old primary email to non-primary (if different from the new one)
      // if the primary email is null
      // - demote the primary email contact channel to non-primary (does NOT delete it)
      if (primaryEmail !== undefined) {
        if (primaryEmail === null) {
          // Setting primary email to null - demote the primary contact channel to non-primary
          await demoteAllContactChannelsToNonPrimary(tx, {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
            type: 'EMAIL',
          });
        } else {
          // Check if a contact channel with this email already exists for this user
          const existingChannel = await tx.contactChannel.findFirst({
            where: {
              tenancyId: auth.tenancy.id,
              projectUserId: params.user_id,
              type: 'EMAIL',
              value: primaryEmail,
            },
          });

          if (existingChannel) {
            // Email already exists as a contact channel - upgrade it to primary
            // Include isVerified in additionalUpdates if primary_email_verified was specified
            await setContactChannelAsPrimaryByValue(tx, {
              tenancyId: auth.tenancy.id,
              projectUserId: params.user_id,
              type: 'EMAIL',
              value: primaryEmail,
              additionalUpdates: {
                usedForAuth: primaryEmailAuthEnabled ? BooleanTrue.TRUE : null,
                ...(data.primary_email_verified !== undefined && { isVerified: data.primary_email_verified }),
              },
            });
          } else {
            // Email doesn't exist as a contact channel - demote old primary and create new
            await demoteAllContactChannelsToNonPrimary(tx, {
              tenancyId: auth.tenancy.id,
              projectUserId: params.user_id,
              type: 'EMAIL',
            });

            // Create the new primary email contact channel
            // Use primary_email_verified if specified, otherwise default to false
            await tx.contactChannel.create({
              data: {
                projectUserId: params.user_id,
                tenancyId: auth.tenancy.id,
                type: 'EMAIL' as const,
                value: primaryEmail,
                isVerified: data.primary_email_verified ?? false,
                isPrimary: "TRUE",
                usedForAuth: primaryEmailAuthEnabled ? BooleanTrue.TRUE : null,
              },
            });
          }
        }
      }

      // if there is a new primary email verified (and we didn't just create/upgrade the primary email)
      // - update the primary email contact channel if it exists
      // Note: if primaryEmail was set, the verification status was already handled above
      if (data.primary_email_verified !== undefined && primaryEmail === undefined && primaryEmailContactChannel) {
        await tx.contactChannel.update({
          where: {
            tenancyId_projectUserId_type_isPrimary: {
              tenancyId: auth.tenancy.id,
              projectUserId: params.user_id,
              type: 'EMAIL',
              isPrimary: "TRUE",
            },
          },
          data: withExternalDbSyncUpdate({
            isVerified: data.primary_email_verified,
          }),
        });
      }

      // if primary_email_auth_enabled is being updated without changing the email
      // - update the primary email contact channel's usedForAuth field
      if (data.primary_email_auth_enabled !== undefined && primaryEmail === undefined && primaryEmailContactChannel) {
        await tx.contactChannel.update({
          where: {
            tenancyId_projectUserId_type_isPrimary: {
              tenancyId: auth.tenancy.id,
              projectUserId: params.user_id,
              type: 'EMAIL',
              isPrimary: "TRUE",
            },
          },
          data: withExternalDbSyncUpdate({
            usedForAuth: primaryEmailAuthEnabled ? BooleanTrue.TRUE : null,
          }),
        });
      }

      // if otp_auth_enabled is true
      // - create a new otp auth method if it doesn't exist
      // if otp_auth_enabled is false
      // - delete the otp auth method if it exists
      if (data.otp_auth_enabled !== undefined) {
        if (data.otp_auth_enabled) {
          if (!otpAuth) {
            if (!config.auth.otp.allowSignIn) {
              throw new StatusError(StatusError.BadRequest, "OTP auth not enabled in the project");
            }
            await tx.authMethod.create({
              data: {
                tenancyId: auth.tenancy.id,
                projectUserId: params.user_id,
                otpAuthMethod: {
                  create: {
                    projectUserId: params.user_id,
                  }
                }
              }
            });
          }
        } else {
          if (otpAuth) {
            await tx.authMethod.delete({
              where: {
                tenancyId_id: {
                  tenancyId: auth.tenancy.id,
                  id: otpAuth.authMethodId,
                },
              },
            });
          }
        }
      }


      // Hacky passkey auth method crud, should be replaced by authHandler endpoints in the future
      if (data.passkey_auth_enabled !== undefined) {
        if (data.passkey_auth_enabled) {
          throw new StatusError(StatusError.BadRequest, "Cannot manually enable passkey auth, it is enabled iff there is a passkey auth method");
          // Case: passkey_auth_enabled is set to true. This should only happen after a user added a passkey and is a no-op since passkey_auth_enabled is true iff there is a passkey auth method.
          // Here to update the ui for the settings page.
          // The passkey auth method is created in the registerPasskey endpoint!
        } else {
          // Case: passkey_auth_enabled is set to false. This is how we delete the passkey auth method.
          if (passkeyAuth) {
            await tx.authMethod.delete({
              where: {
                tenancyId_id: {
                  tenancyId: auth.tenancy.id,
                  id: passkeyAuth.authMethodId,
                },
              },
            });
          }
        }
      }

      // if there is a new password
      // - update the password auth method if it exists
      // if the password is null
      // - delete the password auth method if it exists
      if (passwordHash !== undefined) {
        if (passwordHash === null) {
          if (passwordAuth) {
            await tx.authMethod.delete({
              where: {
                tenancyId_id: {
                  tenancyId: auth.tenancy.id,
                  id: passwordAuth.authMethodId,
                },
              },
            });
          }
        } else {
          if (passwordAuth) {
            await tx.passwordAuthMethod.update({
              where: {
                tenancyId_authMethodId: {
                  tenancyId: auth.tenancy.id,
                  authMethodId: passwordAuth.authMethodId,
                },
              },
              data: {
                passwordHash,
              },
            });
          } else {
            const primaryEmailChannel = await tx.contactChannel.findFirst({
              where: {
                tenancyId: auth.tenancy.id,
                projectUserId: params.user_id,
                type: 'EMAIL',
                isPrimary: "TRUE",
              }
            });

            if (!primaryEmailChannel) {
              throw new HexclaveAssertionError("password is set but primary_email is not set");
            }

            if (!config.auth.password.allowSignIn) {
              throw new StatusError(StatusError.BadRequest, "Password auth not enabled in the project");
            }

            await tx.authMethod.create({
              data: {
                tenancyId: auth.tenancy.id,
                projectUserId: params.user_id,
                passwordAuthMethod: {
                  create: {
                    passwordHash,
                    projectUserId: params.user_id,
                  }
                }
              }
            });
          }
        }
      }

      const wasAnonymousUpgrade = oldUser.isAnonymous && data.is_anonymous === false;
      if (wasAnonymousUpgrade) {
        // rename the personal team
        await tx.team.updateMany({
          where: {
            tenancyId: auth.tenancy.id,
            teamMembers: {
              some: {
                projectUserId: params.user_id,
              },
            },
            displayName: personalTeamDefaultDisplayName,
          },
          data: withExternalDbSyncUpdate({
            displayName: getPersonalTeamDisplayName(data.display_name ?? null, data.primary_email ?? null),
          }),
        });
      }

      let restrictedByAdminReason = data.restricted_by_admin_reason === undefined
        ? undefined
        : (data.restricted_by_admin_reason || null);

      let restrictedByAdminPrivateDetails = data.restricted_by_admin_private_details === undefined
        ? undefined
        : (data.restricted_by_admin_private_details || null);

      // Compute effective restricted flag considering existing value for PATCH updates
      const effectiveRestrictedByAdmin = data.restricted_by_admin ?? oldUser.restrictedByAdmin;

      if (!effectiveRestrictedByAdmin) {
        // User is not (or will not be) restricted - reason/details must not be provided
        if (restrictedByAdminReason != null) {
          throw new StatusError(StatusError.BadRequest, "restricted_by_admin_reason requires restricted_by_admin=true");
        }
        if (restrictedByAdminPrivateDetails != null) {
          throw new StatusError(StatusError.BadRequest, "restricted_by_admin_private_details requires restricted_by_admin=true");
        }
        // Clear reason and details when unrestricting
        restrictedByAdminReason = null;
        restrictedByAdminPrivateDetails = null;
      }

      const db = await tx.projectUser.update({
        where: {
          tenancyId_projectUserId: {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
          },
        },
        data: withExternalDbSyncUpdate({
          displayName: data.display_name === undefined ? undefined : (data.display_name || null),
          clientMetadata: data.client_metadata === null ? Prisma.JsonNull : data.client_metadata,
          clientReadOnlyMetadata: data.client_read_only_metadata === null ? Prisma.JsonNull : data.client_read_only_metadata,
          serverMetadata: data.server_metadata === null ? Prisma.JsonNull : data.server_metadata,
          requiresTotpMfa: data.totp_secret_base64 === undefined ? undefined : (data.totp_secret_base64 !== null),
          totpSecret: data.totp_secret_base64 == null ? data.totp_secret_base64 : Buffer.from(decodeBase64(data.totp_secret_base64)),
          isAnonymous: data.is_anonymous ?? undefined,
          // Set signedUpAt when upgrading anonymous → non-anonymous (first real sign-up).
          // We intentionally do NOT clear signedUpAt on non-anonymous → anonymous because:
          // (a) that transition is admin-only and rare, and (b) preserving the original
          // sign-up timestamp keeps risk/audit data intact.
          signedUpAt: oldUser.isAnonymous && data.is_anonymous === false ? new Date() : undefined,
          profileImageUrl: await uploadAndGetUrl(data.profile_image_url, "user-profile-images"),
          restrictedByAdmin: data.restricted_by_admin ?? undefined,
          restrictedByAdminReason: restrictedByAdminReason,
          restrictedByAdminPrivateDetails: restrictedByAdminPrivateDetails,
          signUpCountryCode: data.country_code,
          signUpRiskScoreBot: data.risk_scores?.sign_up.bot,
          signUpRiskScoreFreeTrialAbuse: data.risk_scores?.sign_up.free_trial_abuse,
        }),
        include: userFullInclude,
      });

      // Snapshot the pre-update row before converting the post-update result —
      // audit diffs need both sides (path-only was showing as "Hidden" in the UI).
      const beforeUser = userPrismaToCrud(oldUser, auth.tenancy.config);
      const user = userPrismaToCrud(db, auth.tenancy.config);
      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "user.updated", payload: user });
      return {
        user,
        beforeUser,
        wasAnonymousUpgrade,
      };
    });

    if (wasAnonymousUpgrade) {
      runAsynchronouslyAndWaitUntil(checkAuthUsersSoftLimit(auth.tenancy));
    }

    // if user password changed, reset all refresh tokens
    if (passwordHash !== undefined) {
      await recordExternalDbSyncRefreshTokenDeletionsForUser(globalPrismaClient, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });

      await globalPrismaClient.projectUserRefreshToken.deleteMany({
        where: {
          tenancyId: auth.tenancy.id,
          projectUserId: params.user_id,
        },
      });
    }


    runAsynchronouslyAndWaitUntil(sendUserUpdatedWebhook({
      projectId: auth.project.id,
      data: user,
    }));

    await recordUserDirectoryAuditsFromUpdate({
      auth,
      targetUserId: params.user_id,
      data,
      beforeUser,
      afterUser: user,
    });

    return user;
  },
  onDelete: async ({ auth, params }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const { teams } = await retryTransaction(prisma, async (tx) => {
      await ensureUserExists(tx, { tenancyId: auth.tenancy.id, userId: params.user_id });

      const teams = await tx.team.findMany({
        where: {
          tenancyId: auth.tenancy.id,
          teamMembers: {
            some: {
              projectUserId: params.user_id,
            },
          },
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

      await recordExternalDbSyncDeletion(tx, {
        tableName: "ProjectUser",
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });

      await recordExternalDbSyncContactChannelDeletionsForUser(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });

      await recordExternalDbSyncTeamMemberDeletionsForUser(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });

      await recordExternalDbSyncTeamPermissionDeletionsForUser(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });

      await recordExternalDbSyncProjectPermissionDeletionsForUser(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });

      await recordExternalDbSyncNotificationPreferenceDeletionsForUser(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });

      await recordExternalDbSyncRefreshTokenDeletionsForUser(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });

      await recordExternalDbSyncOAuthAccountDeletionsForUser(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });

      await tx.projectUserRefreshToken.deleteMany({
        where: {
          tenancyId: auth.tenancy.id,
          projectUserId: params.user_id,
        },
      });

      await tx.projectUser.delete({
        where: {
          tenancyId_projectUserId: {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
          },
        },
        include: userFullInclude,
      });

      for (const t of teams) {
        await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "team_membership.deleted", payload: { team_id: t.teamId, user_id: params.user_id } });
      }
      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "user.deleted", payload: { id: params.user_id, teams: teams.map((t) => ({ id: t.teamId })) } });

      return { teams };
    });

    runAsynchronouslyAndWaitUntil(Promise.all(teams.map(t => sendTeamMembershipDeletedWebhook({
      projectId: auth.project.id,
      data: {
        team_id: t.teamId,
        user_id: params.user_id,
      },
    }))));

    runAsynchronouslyAndWaitUntil(sendUserDeletedWebhook({
      projectId: auth.project.id,
      data: {
        id: params.user_id,
        teams: teams.map((t) => ({
          id: t.teamId,
        })),
      },
    }));

    if (shouldRecordAdminAudit(auth)) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "user.deleted",
        targetUserId: params.user_id,
        metadata: { source: "users.delete" },
      });
    }
  }
}));

export const currentUserCrudHandlers = createLazyProxy(() => createCrudHandlers(currentUserCrud, {
  paramsSchema: yupObject({} as const),
  async onRead({ auth }) {
    if (!auth.user) {
      throw new KnownErrors.CannotGetOwnUserWithoutUser();
    }
    return auth.user;
  },
  async onUpdate({ auth, data }) {
    if (auth.type === 'client' && data.profile_image_url && !validateBase64Image(data.profile_image_url)) {
      throw new StatusError(400, "Invalid profile image URL");
    }

    return await usersCrudHandlers.adminUpdate({
      tenancy: auth.tenancy,
      user_id: auth.user?.id ?? throwErr(new KnownErrors.CannotGetOwnUserWithoutUser()),
      data,
      allowedErrorTypes: [Object],
    });
  },
  async onDelete({ auth }) {
    if (auth.type === 'client' && !auth.tenancy.config.users.allowClientUserDeletion) {
      throw new StatusError(StatusError.BadRequest, "Client user deletion is not enabled for this project");
    }

    return await usersCrudHandlers.adminDelete({
      tenancy: auth.tenancy,
      user_id: auth.user?.id ?? throwErr(new KnownErrors.CannotGetOwnUserWithoutUser()),
      allowedErrorTypes: [Object],
    });
  },
}));
