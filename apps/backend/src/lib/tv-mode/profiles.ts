import { type Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, getPrismaSchemaForTenancy, globalPrismaClient, retryTransaction, sqlQuoteIdent, type PrismaClientTransaction } from "@/prisma-client";
import { type Prisma } from "@/generated/prisma/client";
import {
  getTvBuiltInProfile,
  TV_CELEBRATION_ANIMATION_DURATION_SECONDS,
  TV_EVENT_HIGHLIGHT_DURATION_SECONDS,
  TV_TAKEOVER_DURATION_SECONDS,
  normalizeTvProfileDisplayName,
  TvProfileConfigurationSchema,
  TvProfilePlaylistSchema,
  TvInterruptionPreferencesSchema,
  type TvInterruptionPreferences,
  type TvProfileConfiguration,
  type TvBuiltInProfileResource,
  type TvProfileResource,
  type TvSavedProfileResource,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import { yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";

type TvProfileDatabaseRow = Prisma.TvPresentationProfileGetPayload<{}>;

export class TvProfileVersionConflictError extends Error {
  override name = "TvProfileVersionConflictError";
}

export class TvProfileNameConflictError extends Error {
  override name = "TvProfileNameConflictError";
}

export class TvBuiltInProfileMutationError extends Error {
  override name = "TvBuiltInProfileMutationError";
}

export class TvProfileAssignedToDisplaysError extends Error {
  override name = "TvProfileAssignedToDisplaysError";
  constructor(readonly displayCount: number) {
    super("TV profile is assigned to an active display or approved pairing.");
  }
}

export async function lockTvProfileDisplayAssignment(
  transaction: Prisma.TransactionClient,
  tenancyId: string,
  profileId: string,
): Promise<void> {
  // Saved profiles and display assignments cannot use a normal foreign key because
  // built-in profiles are virtual. This transaction lock supplies the missing
  // serialization boundary for assignment and deletion without coupling the models.
  await transaction.$executeRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`tv-profile-display-assignment:${tenancyId}:${profileId}`}, 0)
    )
  `;
}

const LegacyTvInterruptionPreferencesSchema = yupObject({
  incidentLevels: yupObject({
    critical: yupString().oneOf(["persistent-takeover", "disabled"]).defined(),
    high: yupString().oneOf(["temporary-takeover", "banner", "disabled"]).defined(),
    medium: yupString().oneOf(["banner", "disabled"]).defined(),
  }).noUnknown().defined(),
  incidentTypes: yupObject({
    emailDeliveryDegradation: yupBoolean().defined(),
  }).noUnknown().defined(),
  celebrations: yupObject({
    userMilestone: yupBoolean().defined(),
    revenueMilestone: yupBoolean().defined(),
  }).noUnknown().defined(),
}).noUnknown().defined();

const PreviousTvInterruptionPreferencesSchema = yupObject({
  incidentTypes: yupObject({
    emailDeliveryDegradation: yupBoolean().defined(),
  }).noUnknown().defined(),
  celebrations: yupObject({
    userMilestone: yupBoolean().defined(),
    revenueMilestone: yupBoolean().defined(),
  }).noUnknown().defined(),
  timing: yupObject({
    celebration: yupObject({
      takeoverSeconds: yupNumber().integer().oneOf(TV_TAKEOVER_DURATION_SECONDS).defined(),
      animationSeconds: yupNumber().integer().oneOf(TV_CELEBRATION_ANIMATION_DURATION_SECONDS).defined(),
      highlightSeconds: yupNumber().integer().oneOf(TV_EVENT_HIGHLIGHT_DURATION_SECONDS).defined(),
    }).noUnknown().defined(),
    incident: yupObject({
      takeoverSeconds: yupNumber().integer().oneOf(TV_TAKEOVER_DURATION_SECONDS).defined(),
      resolvedHighlightSeconds: yupNumber().integer().oneOf(TV_EVENT_HIGHLIGHT_DURATION_SECONDS).defined(),
    }).noUnknown().defined(),
    criticalIncident: yupObject({
      resolvedHighlightSeconds: yupNumber().integer().oneOf(TV_EVENT_HIGHLIGHT_DURATION_SECONDS).defined(),
    }).noUnknown().defined(),
  }).noUnknown().defined(),
}).noUnknown().defined();

const TvRecoveryTimingSchema = yupObject({
  celebration: yupObject({
    takeoverSeconds: yupNumber().integer().oneOf(TV_TAKEOVER_DURATION_SECONDS).defined(),
    animationSeconds: yupNumber().integer().oneOf(TV_CELEBRATION_ANIMATION_DURATION_SECONDS).defined(),
    highlightSeconds: yupNumber().integer().oneOf(TV_EVENT_HIGHLIGHT_DURATION_SECONDS).defined(),
  }).noUnknown().defined(),
  incident: yupObject({
    takeoverSeconds: yupNumber().integer().oneOf(TV_TAKEOVER_DURATION_SECONDS).defined(),
    recoveryTakeoverSeconds: yupNumber().integer().oneOf(TV_TAKEOVER_DURATION_SECONDS).defined(),
    resolvedHighlightSeconds: yupNumber().integer().oneOf(TV_EVENT_HIGHLIGHT_DURATION_SECONDS).defined(),
  }).noUnknown().defined(),
  criticalIncident: yupObject({
    takeoverSeconds: yupNumber().integer().oneOf(TV_TAKEOVER_DURATION_SECONDS).defined(),
    recoveryTakeoverSeconds: yupNumber().integer().oneOf(TV_TAKEOVER_DURATION_SECONDS).defined(),
    resolvedHighlightSeconds: yupNumber().integer().oneOf(TV_EVENT_HIGHLIGHT_DURATION_SECONDS).defined(),
  }).noUnknown().defined(),
}).noUnknown().defined();

// Recovery timing shipped before subscription collection incidents. Profiles
// saved during that interval already have the final timing shape, but only the
// original email incident toggle.
const PreSubscriptionTvInterruptionPreferencesSchema = yupObject({
  incidentTypes: yupObject({
    emailDeliveryDegradation: yupBoolean().defined(),
  }).noUnknown().defined(),
  celebrations: yupObject({
    userMilestone: yupBoolean().defined(),
    revenueMilestone: yupBoolean().defined(),
  }).noUnknown().defined(),
  timing: TvRecoveryTimingSchema,
}).noUnknown().defined();

export async function normalizeTvInterruptionPreferences(
  input: unknown,
): Promise<TvInterruptionPreferences> {
  if (await TvInterruptionPreferencesSchema.isValid(input, { strict: true })) {
    return await TvInterruptionPreferencesSchema.validate(input, { strict: true });
  }
  if (await PreSubscriptionTvInterruptionPreferencesSchema.isValid(input, { strict: true })) {
    const previous = await PreSubscriptionTvInterruptionPreferencesSchema.validate(input, { strict: true });
    return {
      ...previous,
      incidentTypes: {
        ...previous.incidentTypes,
        subscriptionCollectionDegradation: previous.incidentTypes.emailDeliveryDegradation,
      },
    };
  }
  if (await PreviousTvInterruptionPreferencesSchema.isValid(input, { strict: true })) {
    const previous = await PreviousTvInterruptionPreferencesSchema.validate(input, { strict: true });
    return {
      incidentTypes: {
        ...previous.incidentTypes,
        subscriptionCollectionDegradation: previous.incidentTypes.emailDeliveryDegradation,
      },
      celebrations: previous.celebrations,
      timing: {
        celebration: previous.timing.celebration,
        incident: {
          ...previous.timing.incident,
          recoveryTakeoverSeconds: 30,
        },
        criticalIncident: {
          takeoverSeconds: 120,
          recoveryTakeoverSeconds: 60,
          resolvedHighlightSeconds: previous.timing.criticalIncident.resolvedHighlightSeconds,
        },
      },
    };
  }
  const legacy = await LegacyTvInterruptionPreferencesSchema.validate(input, { strict: true });
  const anyIncidentLevelEnabled = Object.values(legacy.incidentLevels).some((level) => level !== "disabled");
  return {
    incidentTypes: {
      emailDeliveryDegradation: legacy.incidentTypes.emailDeliveryDegradation && anyIncidentLevelEnabled,
      subscriptionCollectionDegradation: anyIncidentLevelEnabled,
    },
    celebrations: legacy.celebrations,
    timing: {
      celebration: { takeoverSeconds: 60, animationSeconds: 3600, highlightSeconds: 21600 },
      incident: { takeoverSeconds: 60, recoveryTakeoverSeconds: 30, resolvedHighlightSeconds: 3600 },
      criticalIncident: { takeoverSeconds: 120, recoveryTakeoverSeconds: 60, resolvedHighlightSeconds: 21600 },
    },
  };
}

async function validateConfiguration(configuration: TvProfileConfiguration): Promise<TvProfileConfiguration> {
  return await TvProfileConfigurationSchema.validate(configuration, { strict: true });
}

async function rowToResource(row: TvProfileDatabaseRow): Promise<TvSavedProfileResource> {
  const configuration = await validateConfiguration({
    displayName: row.displayName,
    description: row.description,
    mode: "general",
    defaultDurationSeconds: row.defaultDurationSeconds,
    playlist: await TvProfilePlaylistSchema.validate(row.playlist, { strict: true }),
    interruptionPreferences: await normalizeTvInterruptionPreferences(row.interruptionPreferences),
    financialVisibility: row.financialVisibility === "EXACT" ? "exact" : "redacted",
  });
  return {
    id: row.id,
    origin: "saved",
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    configuration,
  };
}

export async function tvProfilePersistenceIsReady(tenancy: Tenancy): Promise<boolean> {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  // Migration readiness gates authoritative configuration writes, so checking a
  // replica here could incorrectly report that an already-migrated primary is unavailable.
  const rows = await prisma.$queryRaw<Array<{ relation_name: string | null }>>`
    SELECT to_regclass(${`${schema}."TvPresentationProfile"`})::text AS relation_name
  `;
  return rows.at(0)?.relation_name != null;
}

async function querySavedProfileRowsWithClient(
  client: PrismaClientTransaction,
  tenancy: Tenancy,
  profileId?: string,
): Promise<TvProfileDatabaseRow[]> {
  if (profileId == null) {
    return await client.tvPresentationProfile.findMany({
      where: { tenancyId: tenancy.id },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });
  }
  const row = await client.tvPresentationProfile.findFirst({
    where: {
      tenancyId: tenancy.id,
      id: profileId,
    },
  });
  return row == null ? [] : [row];
}

async function querySavedProfileRows(tenancy: Tenancy, profileId?: string): Promise<TvProfileDatabaseRow[]> {
  if (!(await tvProfilePersistenceIsReady(tenancy))) return [];
  const prisma = await getPrismaClientForTenancy(tenancy);
  // The readiness catalog query is intentionally primary-bound. Keep the
  // following model read on the primary too instead of allowing read-replica
  // routing to turn a ready table into an empty profile list.
  return await querySavedProfileRowsWithClient(prisma.$primary(), tenancy, profileId);
}

export async function listTvProfiles(tenancy: Tenancy): Promise<{
  persistenceReady: boolean,
  savedProfiles: TvSavedProfileResource[],
  templates: TvBuiltInProfileResource[],
}> {
  const persistenceReady = await tvProfilePersistenceIsReady(tenancy);
  const rows = persistenceReady ? await querySavedProfileRows(tenancy) : [];
  return {
    persistenceReady,
    savedProfiles: await Promise.all(rows.map(rowToResource)),
    templates: ["company-pulse", "engineering-office"].map((id) => {
      const template = getTvBuiltInProfile(id);
      if (template == null) throw new Error(`Missing TV built-in profile "${id}"`);
      return template;
    }),
  };
}

export async function resolveTvProfile(
  tenancy: Tenancy,
  profileId: string,
  client?: PrismaClientTransaction,
): Promise<TvProfileResource | null> {
  const builtIn = getTvBuiltInProfile(profileId);
  if (builtIn != null) return builtIn;
  if (!isSavedTvProfileId(profileId)) {
    return null;
  }
  const rows = client == null
    ? await querySavedProfileRows(tenancy, profileId)
    : await querySavedProfileRowsWithClient(client, tenancy, profileId);
  const row = rows.at(0);
  return row == null ? null : await rowToResource(row);
}

export function isSavedTvProfileId(profileId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId);
}

export async function createTvProfile(
  tenancy: Tenancy,
  configurationInput: TvProfileConfiguration,
): Promise<TvSavedProfileResource | null> {
  if (!(await tvProfilePersistenceIsReady(tenancy))) return null;
  const configuration = await validateConfiguration(configurationInput);
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const id = generateUuid();
  const rows = await prisma.$queryRaw<TvProfileDatabaseRow[]>`
    INSERT INTO ${sqlQuoteIdent(schema)}."TvPresentationProfile" (
      "id", "tenancyId", "displayName", "normalizedDisplayName", "description", "mode",
      "defaultDurationSeconds", "playlist", "interruptionPreferences", "financialVisibility", "updatedAt"
    )
    VALUES (
      ${id}::UUID, ${tenancy.id}::UUID, ${configuration.displayName},
      ${normalizeTvProfileDisplayName(configuration.displayName)}, ${configuration.description}, 'GENERAL'::${sqlQuoteIdent(schema)}."TvPresentationMode",
      ${configuration.defaultDurationSeconds}, ${JSON.stringify(configuration.playlist)}::JSONB,
      ${JSON.stringify(configuration.interruptionPreferences)}::JSONB,
      ${configuration.financialVisibility === "exact" ? "EXACT" : "REDACTED"}::${sqlQuoteIdent(schema)}."TvFinancialVisibility",
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("tenancyId", "normalizedDisplayName") DO NOTHING
    RETURNING "id", "displayName", "description", "mode", "defaultDurationSeconds",
      "playlist", "interruptionPreferences", "financialVisibility", "version", "createdAt", "updatedAt"
  `;
  const row = rows.at(0);
  if (row == null) throw new TvProfileNameConflictError();
  return await rowToResource(row);
}

export async function duplicateSavedTvProfile(
  tenancy: Tenancy,
  sourceProfileId: string,
  expectedSourceVersion: number,
  configurationInput: TvProfileConfiguration,
): Promise<TvSavedProfileResource | null> {
  if (!isSavedTvProfileId(sourceProfileId)) return null;
  if (!(await tvProfilePersistenceIsReady(tenancy))) return null;
  const configuration = await validateConfiguration(configurationInput);
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const id = generateUuid();
  // The source-version predicate and clone insert share one statement snapshot.
  // A concurrent source update therefore linearizes wholly before or after the
  // duplicate instead of allowing a stale configuration read to be inserted.
  const rows = await prisma.$queryRaw<TvProfileDatabaseRow[]>`
    INSERT INTO ${sqlQuoteIdent(schema)}."TvPresentationProfile" (
      "id", "tenancyId", "displayName", "normalizedDisplayName", "description", "mode",
      "defaultDurationSeconds", "playlist", "interruptionPreferences", "financialVisibility", "updatedAt"
    )
    SELECT
      ${id}::UUID, ${tenancy.id}::UUID, ${configuration.displayName},
      ${normalizeTvProfileDisplayName(configuration.displayName)}, ${configuration.description},
      'GENERAL'::${sqlQuoteIdent(schema)}."TvPresentationMode",
      ${configuration.defaultDurationSeconds}, ${JSON.stringify(configuration.playlist)}::JSONB,
      ${JSON.stringify(configuration.interruptionPreferences)}::JSONB,
      ${configuration.financialVisibility === "exact" ? "EXACT" : "REDACTED"}::${sqlQuoteIdent(schema)}."TvFinancialVisibility",
      CURRENT_TIMESTAMP
    FROM ${sqlQuoteIdent(schema)}."TvPresentationProfile" AS source_profile
    WHERE source_profile."tenancyId" = ${tenancy.id}::UUID
      AND source_profile."id" = ${sourceProfileId}::UUID
      AND source_profile."version" = ${expectedSourceVersion}
    ON CONFLICT ("tenancyId", "normalizedDisplayName") DO NOTHING
    RETURNING "id", "displayName", "description", "mode", "defaultDurationSeconds",
      "playlist", "interruptionPreferences", "financialVisibility", "version", "createdAt", "updatedAt"
  `;
  const row = rows.at(0);
  if (row != null) return await rowToResource(row);
  const current = (await querySavedProfileRows(tenancy, sourceProfileId)).at(0);
  if (current == null) return null;
  if (current.version !== expectedSourceVersion) throw new TvProfileVersionConflictError();
  throw new TvProfileNameConflictError();
}

export async function updateTvProfile(
  tenancy: Tenancy,
  profileId: string,
  expectedVersion: number,
  configurationInput: TvProfileConfiguration,
): Promise<TvSavedProfileResource | null> {
  if (getTvBuiltInProfile(profileId) != null) throw new TvBuiltInProfileMutationError();
  if (!isSavedTvProfileId(profileId)) return null;
  if (!(await tvProfilePersistenceIsReady(tenancy))) return null;
  const configuration = await validateConfiguration(configurationInput);
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const normalizedDisplayName = normalizeTvProfileDisplayName(configuration.displayName);
  return await retryTransaction(globalPrismaClient, async (transaction) => {
    // The unique constraint is authoritative, but serializing contenders for
    // the same tenancy/name lets us return the stable domain conflict instead
    // of leaking a database-specific unique violation under concurrency.
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`tv-profile-name:${tenancy.id}:${normalizedDisplayName}`}, 0)
      )
    `;
    const rows = await transaction.$queryRaw<TvProfileDatabaseRow[]>`
      UPDATE ${sqlQuoteIdent(schema)}."TvPresentationProfile"
      SET "displayName" = ${configuration.displayName},
        "normalizedDisplayName" = ${normalizedDisplayName},
        "description" = ${configuration.description},
        "defaultDurationSeconds" = ${configuration.defaultDurationSeconds},
        "playlist" = ${JSON.stringify(configuration.playlist)}::JSONB,
        "interruptionPreferences" = ${JSON.stringify(configuration.interruptionPreferences)}::JSONB,
        "financialVisibility" = ${configuration.financialVisibility === "exact" ? "EXACT" : "REDACTED"}::${sqlQuoteIdent(schema)}."TvFinancialVisibility",
        "version" = "version" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "tenancyId" = ${tenancy.id}::UUID
        AND "id" = ${profileId}::UUID
        AND "version" = ${expectedVersion}
        AND NOT EXISTS (
          SELECT 1
          FROM ${sqlQuoteIdent(schema)}."TvPresentationProfile" AS conflicting_profile
          WHERE conflicting_profile."tenancyId" = ${tenancy.id}::UUID
            AND conflicting_profile."normalizedDisplayName" = ${normalizedDisplayName}
            AND conflicting_profile."id" <> ${profileId}::UUID
        )
      RETURNING "id", "displayName", "description", "mode", "defaultDurationSeconds",
        "playlist", "interruptionPreferences", "financialVisibility", "version", "createdAt", "updatedAt"
    `;
    const row = rows.at(0);
    if (row != null) return await rowToResource(row);
    const currentRows = await transaction.$queryRaw<TvProfileDatabaseRow[]>`
      SELECT "id", "displayName", "description", "mode", "defaultDurationSeconds",
        "playlist", "interruptionPreferences", "financialVisibility", "version", "createdAt", "updatedAt"
      FROM ${sqlQuoteIdent(schema)}."TvPresentationProfile"
      WHERE "tenancyId" = ${tenancy.id}::UUID AND "id" = ${profileId}::UUID
      LIMIT 1
    `;
    const current = currentRows.at(0);
    if (current == null) return null;
    if (current.version === expectedVersion) throw new TvProfileNameConflictError();
    throw new TvProfileVersionConflictError();
  });
}

export async function deleteTvProfile(
  tenancy: Tenancy,
  profileId: string,
  expectedVersion: number,
): Promise<boolean | null> {
  if (getTvBuiltInProfile(profileId) != null) throw new TvBuiltInProfileMutationError();
  if (!isSavedTvProfileId(profileId)) return false;
  if (!(await tvProfilePersistenceIsReady(tenancy))) return null;
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const deleted = await retryTransaction(globalPrismaClient, async (transaction) => {
    await lockTvProfileDisplayAssignment(transaction, tenancy.id, profileId);
    const relationRows = await transaction.$queryRaw<Array<{
      display_table: string | null,
      pairing_table: string | null,
      presentation_table: string | null,
    }>>`
      SELECT
        to_regclass(${`${schema}."TvDisplay"`})::text AS display_table,
        to_regclass(${`${schema}."TvDisplayPairingChallenge"`})::text AS pairing_table,
        to_regclass(${`${schema}."TvProfileEventPresentation"`})::text AS presentation_table
    `;
    const relations = relationRows.at(0) ?? throwErr("TV profile deletion readiness returned no row.");
    let assignedDisplayCount = 0;
    if (relations.display_table != null) {
      assignedDisplayCount += Number((await transaction.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS "count" FROM ${sqlQuoteIdent(schema)}."TvDisplay"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND "profileId" = ${profileId}
      `).at(0)?.count ?? 0n);
    }
    if (relations.pairing_table != null) {
      assignedDisplayCount += Number((await transaction.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS "count" FROM ${sqlQuoteIdent(schema)}."TvDisplayPairingChallenge"
        WHERE "approvedTenancyId" = ${tenancy.id}::UUID
          AND "approvedProfileId" = ${profileId}
          AND "state" = 'APPROVED'::${sqlQuoteIdent(schema)}."TvDisplayPairingState"
          AND "expiresAt" > NOW()
      `).at(0)?.count ?? 0n);
    }
    if (assignedDisplayCount > 0) throw new TvProfileAssignedToDisplaysError(assignedDisplayCount);
    const rows = await transaction.$queryRaw<Array<{ id: string }>>`
      DELETE FROM ${sqlQuoteIdent(schema)}."TvPresentationProfile"
      WHERE "tenancyId" = ${tenancy.id}::UUID
        AND "id" = ${profileId}::UUID
        AND "version" = ${expectedVersion}
      RETURNING "id"
    `;
    if (rows.length === 0) return false;
    // Presentation rows also represent virtual built-in profiles, so there is
    // intentionally no profile foreign key to cascade this cleanup for us.
    if (relations.presentation_table != null) {
      await transaction.$executeRaw`
        DELETE FROM ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"
        WHERE "tenancyId" = ${tenancy.id}::UUID
          AND "profileId" = ${profileId}
      `;
    }
    return true;
  });
  if (deleted) return true;
  const current = (await querySavedProfileRows(tenancy, profileId)).at(0);
  if (current == null) return false;
  throw new TvProfileVersionConflictError();
}
