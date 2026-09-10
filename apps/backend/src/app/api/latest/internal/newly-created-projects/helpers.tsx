import { Prisma } from "@/generated/prisma/client";
import { getClickhouseAdminClientForMetrics } from "@/lib/clickhouse";
import { getBranchConfigOverrideQuery } from "@/lib/config";
import { isPreviewModeEnabled } from "@/lib/preview-mode";
import { getHexclaveStripe } from "@/lib/stripe";
import type { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { ALL_APPS, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch, type Tenancy } from "@/lib/tenancies";
import { globalPrismaClient, getPrismaClientForTenancy, getPrismaSchemaForTenancy, rawQuery } from "@/prisma-client";
import {
  aggregateSessionReplayChunksByReplayIds,
  querySessionReplayAdminRows,
  sessionReplayAdminRowToApiItem,
} from "../../session-replays/session-replay-admin-rows";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { DEFAULT_EMAIL_TEMPLATES } from "@hexclave/shared/dist/helpers/emails";
import { deepPlainEquals, typedEntries } from "@hexclave/shared/dist/utils/objects";
import { mapWithConcurrency } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

// Self-contained helpers for the newly-created-projects internal tool.
// Kept next to the routes so the feature stays modular and doesn't leak into
// shared backend libs.

export const INTERNAL_PROJECT_ID = "internal";
export const LIST_RETURN_LIMIT = 200;
// Keep the source window larger than the 200-row display limit so filters can
// reject recent candidates without loading every project into memory.
export const CANDIDATE_WINDOW_SIZE = 5_000;
export const DETAIL_REPLAY_LIMIT = 50;
const CONFIG_RENDER_CONCURRENCY = 12;
const STRIPE_ACCOUNT_CONCURRENCY = 8;
const METRICS_PROJECT_BATCH_SIZE = 200;
const METRICS_QUERY_CONCURRENCY = 4;

export const FEATURED_APP_IDS = [
  "authentication",
  "emails",
  "payments",
  "analytics",
  "deploy",
] as const satisfies readonly AppId[];

export type FeaturedAppId = (typeof FEATURED_APP_IDS)[number];

/** Tick strength: off < enabled < setup (green) < used (golden). */
export type AppTickLevel = "off" | "enabled" | "setup" | "used";
export type EmailSetupKind = "shared" | "custom-domain" | "custom-server";

export type OwnerMember = {
  id: string,
  display_name: string | null,
  primary_email: string | null,
  profile_image_url: string | null,
  created_at: string,
  last_active_at: string,
};

export type ProjectOwner = {
  kind: "rde" | "team" | "user" | "unknown",
  team_id: string | null,
  team_display_name: string | null,
  members: OwnerMember[],
};

export type NewlyCreatedProjectRow = {
  id: string,
  display_name: string,
  description: string,
  created_at: string,
  is_development_environment: boolean,
  onboarding_status: string,
  is_onboarding: boolean,
  non_anonymous_users: number,
  anonymous_users: number,
  last_user_activity_at: string | null,
  has_activity_24h_after_creation: boolean,
  owner: ProjectOwner,
  domains: string[],
  stripe_connected: boolean,
  stripe_setup_complete: boolean,
  email_customized: boolean,
  email_customization: {
    has_draft: boolean,
    has_modified_template: boolean,
  },
  email_setup: {
    kind: EmailSetupKind,
    provider: "resend" | "smtp" | "managed" | null,
    sender_email: string | null,
    managed_subdomain: string | null,
  },
  has_live_payment: boolean,
  featured_apps: Record<FeaturedAppId, AppTickLevel>,
  other_enabled_apps: AppId[],
};

type AppInfoConfig = {
  apps: {
    installed: Partial<Record<AppId, { enabled?: boolean }>>,
  },
};

type DomainInfoConfig = {
  domains: {
    trustedDomains: Record<string, { baseUrl?: string }>,
  },
};

type EmailSetupConfig = {
  emails: {
    server: {
      isShared: boolean,
      provider: "resend" | "smtp" | "managed",
      senderEmail?: string,
      managedSubdomain?: string,
    },
  },
};

export function getEnabledAppIds(config: AppInfoConfig): AppId[] {
  return typedEntries(ALL_APPS)
    .filter(([appId]) => config.apps.installed[appId]?.enabled === true)
    .map(([appId]) => appId)
    .sort(stringCompare);
}

export function getTrustedDomainBaseUrls(config: DomainInfoConfig): string[] {
  const urls: string[] = [];
  for (const domain of Object.values(config.domains.trustedDomains)) {
    if (domain.baseUrl != null) urls.push(domain.baseUrl);
  }
  return urls.sort(stringCompare);
}

export function hasModifiedEmailTemplate(config: CompleteConfig): boolean {
  return !deepPlainEquals(config.emails.templates, DEFAULT_EMAIL_TEMPLATES);
}

export function getEmailSetup(config: EmailSetupConfig): NewlyCreatedProjectRow["email_setup"] {
  const server = config.emails.server;
  return {
    kind: server.isShared
      ? "shared"
      : server.provider === "managed"
        ? "custom-domain"
        : "custom-server",
    provider: server.provider,
    sender_email: server.senderEmail ?? null,
    managed_subdomain: server.managedSubdomain ?? null,
  };
}

export function isStripeAccountSetupComplete(account: {
  charges_enabled: boolean,
  details_submitted: boolean,
  payouts_enabled: boolean,
}): boolean {
  return account.charges_enabled && account.details_submitted && account.payouts_enabled;
}

export function selectProjectsWithInternalPinned<T extends { id: string }>(
  matchingProjects: T[],
  limit: number,
): T[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new HexclaveAssertionError("Project selection limit must be a positive integer", { limit });
  }
  const selectedProjects = matchingProjects.slice(0, limit);
  const internalProject = matchingProjects.find((project) => project.id === INTERNAL_PROJECT_ID);
  if (
    internalProject != null
    && !selectedProjects.some((project) => project.id === INTERNAL_PROJECT_ID)
  ) {
    // The internal project is intentionally pinned because it is older than
    // the normal recency window but is itself relevant to this internal tool.
    selectedProjects[selectedProjects.length - 1] = internalProject;
  }
  return selectedProjects;
}

export function mergeInternalProjectIntoCandidates<T extends { id: string }>(
  candidates: T[],
  internalProject: T | null | undefined,
): T[] {
  if (internalProject == null || candidates.some((project) => project.id === INTERNAL_PROJECT_ID)) {
    return candidates;
  }
  return [...candidates, internalProject];
}

function computeFeaturedAppLevels(options: {
  enabledAppIds: ReadonlySet<AppId>,
  nonAnonymousUsers: number,
  emailCustomized: boolean,
  emailSetupComplete: boolean,
  stripeSetupComplete: boolean,
  hasLivePayment: boolean,
}): Record<FeaturedAppId, AppTickLevel> {
  const levels = {} as Record<FeaturedAppId, AppTickLevel>;
  for (const appId of FEATURED_APP_IDS) {
    if (!options.enabledAppIds.has(appId)) {
      levels[appId] = "off";
      continue;
    }
    if (appId === "authentication" && options.nonAnonymousUsers > 0) {
      levels[appId] = "used";
      continue;
    }
    if (appId === "emails" && options.emailCustomized) {
      levels[appId] = "used";
      continue;
    }
    if (appId === "emails" && options.emailSetupComplete) {
      levels[appId] = "setup";
      continue;
    }
    if (appId === "payments") {
      if (options.hasLivePayment) {
        levels[appId] = "used";
        continue;
      }
      if (options.stripeSetupComplete) {
        levels[appId] = "setup";
        continue;
      }
    }
    levels[appId] = "enabled";
  }
  return levels;
}

type RenderedProjectData = {
  tenancy: Tenancy,
  config: CompleteConfig,
};

export async function loadRenderedProjectData(projectIds: string[]): Promise<Map<string, RenderedProjectData>> {
  const entries = await mapWithConcurrency(projectIds, CONFIG_RENDER_CONCURRENCY, async (projectId) => {
    const tenancy = await getSoleTenancyFromProjectBranch(projectId, DEFAULT_BRANCH_ID);
    return [projectId, { tenancy, config: tenancy.config }] as const;
  });
  return new Map(entries);
}

export type ProjectActivityMetrics = {
  nonAnonByProjectId: Map<string, number>,
  anonByProjectId: Map<string, number>,
  lastActivityByProjectId: Map<string, Date>,
};

export function chunkProjectIds(projectIds: readonly string[], chunkSize: number): string[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new HexclaveAssertionError("Project ID chunk size must be a positive integer", { chunkSize });
  }
  const chunks: string[][] = [];
  for (let index = 0; index < projectIds.length; index += chunkSize) {
    chunks.push(projectIds.slice(index, index + chunkSize));
  }
  return chunks;
}

export async function loadProjectActivityMetrics(projectIds: string[]): Promise<ProjectActivityMetrics> {
  const empty = {
    nonAnonByProjectId: new Map<string, number>(),
    anonByProjectId: new Map<string, number>(),
    lastActivityByProjectId: new Map<string, Date>(),
  };
  if (projectIds.length === 0) return empty;

  const clickhouse = getClickhouseAdminClientForMetrics();
  const branchId = DEFAULT_BRANCH_ID;

  try {
    // The candidate window can contain thousands of user-heavy projects. Even
    // with external aggregation enabled, one query over the whole window can
    // exceed ClickHouse's per-query memory cap because the inner dedup must
    // hold one group for every user. Batch project IDs so each aggregation has
    // a bounded number of groups, while keeping a small concurrency limit to
    // avoid replacing one large query with an unbounded fan-out.
    const chunkResults = await mapWithConcurrency(
      chunkProjectIds(projectIds, METRICS_PROJECT_BATCH_SIZE),
      METRICS_QUERY_CONCURRENCY,
      async (projectIdChunk) => {
        const [userRowsResult, activityRowsResult] = await Promise.all([
          clickhouse.query({
            // Deduplicate the ReplacingMergeTree rows with `FINAL` instead of
            // an explicit argMax GROUP BY on the dedup key: argMax needs one
            // aggregation state per user, which exceeds the per-query memory
            // cap on user-heavy batches (even with external group-by spill),
            // while FINAL is a streaming merge of sorted parts whose memory
            // scales with part count, not user count. Combined with the
            // project-ID batching below it stays far under the cap, and it
            // matches the dedup semantics of the public `default.users` view.
            // Note that deletion tombstones carry deletedAt as signed_up_at
            // and thus usually live in a later monthly partition than the
            // live row; FINAL still collapses the pair because it merges
            // across partitions by default — so never enable
            // do_not_merge_across_partitions_select_final on this table, or
            // deleted users would be counted again (validated empirically).
            query: `
              SELECT
                project_id AS projectId,
                countIf(is_anonymous = 0) AS nonAnon,
                countIf(is_anonymous = 1) AS anon
              FROM analytics_internal.users FINAL
              WHERE branch_id = {branchId:String}
                AND project_id IN {projectIds:Array(String)}
                AND sync_is_deleted = 0
              GROUP BY project_id
            `,
            query_params: { branchId, projectIds: projectIdChunk },
            format: "JSONEachRow",
          }),
          clickhouse.query({
            query: `
              SELECT
                project_id AS projectId,
                max(event_at) AS lastActive
              FROM analytics_internal.events
              WHERE event_type = '$token-refresh'
                AND user_id IS NOT NULL
                AND project_id IN {projectIds:Array(String)}
              GROUP BY project_id
            `,
            query_params: { projectIds: projectIdChunk },
            format: "JSONEachRow",
          }),
        ]);

        // clickhouse-js `json<T>()` returns T[] — pass the row type, not Array<row>.
        return {
          userRows: await userRowsResult.json<{ projectId: string, nonAnon: string | number, anon: string | number }>(),
          activityRows: await activityRowsResult.json<{ projectId: string, lastActive: string }>(),
        };
      },
    );

    const nonAnonByProjectId = new Map<string, number>();
    const anonByProjectId = new Map<string, number>();
    const lastActivityByProjectId = new Map<string, Date>();
    for (const { userRows, activityRows } of chunkResults) {
      for (const row of userRows) {
        nonAnonByProjectId.set(row.projectId, Number(row.nonAnon) || 0);
        anonByProjectId.set(row.projectId, Number(row.anon) || 0);
      }
      for (const row of activityRows) {
        // ClickHouse DateTime comes back as "YYYY-MM-DD HH:MM:SS" (UTC, no zone).
        const normalized = row.lastActive.includes("T")
          ? row.lastActive
          : row.lastActive.replace(" ", "T");
        const withZone = /[zZ]|[+-]\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`;
        const parsed = new Date(withZone);
        if (!Number.isNaN(parsed.getTime())) {
          lastActivityByProjectId.set(row.projectId, parsed);
        }
      }
    }
    return { nonAnonByProjectId, anonByProjectId, lastActivityByProjectId };
  } catch (cause) {
    throw new HexclaveAssertionError(
      `Failed to load newly-created-projects user metrics from ClickHouse: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

async function loadInternalOwnerReplayIds(projectId: string, ownerUserIds: string[]): Promise<string[]> {
  if (ownerUserIds.length === 0) return [];
  const clickhouse = getClickhouseAdminClientForMetrics();
  const result = await clickhouse.query({
    query: `
      SELECT DISTINCT assumeNotNull(session_replay_id) AS sessionReplayId
      FROM analytics_internal.events
      WHERE project_id = {internalProjectId:String}
        AND branch_id = {branchId:String}
        AND user_id IN {ownerUserIds:Array(String)}
        AND session_replay_id IS NOT NULL
        AND event_type = '$page-view'
        AND (
          position(JSONExtractString(toString(data), 'path'), {projectPath:String}) > 0
          OR position(JSONExtractString(toString(data), 'url'), {projectPath:String}) > 0
        )
    `,
    query_params: {
      internalProjectId: INTERNAL_PROJECT_ID,
      branchId: DEFAULT_BRANCH_ID,
      ownerUserIds,
      projectPath: `/projects/${projectId}`,
    },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ sessionReplayId: string }>();
  return rows.map((row) => row.sessionReplayId);
}

type TenancyPrismaClient = Awaited<ReturnType<typeof getPrismaClientForTenancy>>;

async function groupTenanciesByPrismaClient(
  renderedByProjectId: Map<string, RenderedProjectData>,
): Promise<Map<TenancyPrismaClient, string[]>> {
  const groups = new Map<TenancyPrismaClient, string[]>();
  for (const { tenancy } of renderedByProjectId.values()) {
    const prisma = await getPrismaClientForTenancy(tenancy);
    const tenancyIds = groups.get(prisma) ?? [];
    tenancyIds.push(tenancy.id);
    groups.set(prisma, tenancyIds);
  }
  return groups;
}

async function loadEmailDraftTenancyIds(
  groups: Map<TenancyPrismaClient, string[]>,
): Promise<Set<string>> {
  const rowsByGroup = await Promise.all([...groups].map(async ([prisma, tenancyIds]) =>
    // Draft creation should update the gold tick immediately. A replica read
    // here can remain stale during normal replication lag.
    await prisma.emailDraft.findMany({
      where: { tenancyId: { in: tenancyIds } },
      select: { tenancyId: true },
      distinct: ["tenancyId"],
    })
  ));
  return new Set(rowsByGroup.flat().map((row) => row.tenancyId));
}

async function loadLivePaymentTenancyIds(
  groups: Map<TenancyPrismaClient, string[]>,
): Promise<Set<string>> {
  const rowsByGroup = await Promise.all([...groups].map(async ([prisma, tenancyIds]) => {
    const [subscriptionRows, oneTimeRows] = await Promise.all([
      prisma.$replica().$queryRaw<Array<{ tenancyId: string }>>(Prisma.sql`
      SELECT DISTINCT si."tenancyId" AS "tenancyId"
      FROM "SubscriptionInvoice" si
      JOIN "Subscription" s
        ON s."tenancyId" = si."tenancyId"
        AND s."stripeSubscriptionId" = si."stripeSubscriptionId"
      WHERE si."tenancyId" = ANY(${tenancyIds}::uuid[])
        AND s."creationSource" = 'PURCHASE_PAGE'
        AND si."status" IN ('paid', 'succeeded')
      `),
      prisma.$replica().$queryRaw<Array<{ tenancyId: string }>>(Prisma.sql`
      SELECT DISTINCT otp."tenancyId" AS "tenancyId"
      FROM "OneTimePurchase" otp
      WHERE otp."tenancyId" = ANY(${tenancyIds}::uuid[])
        AND otp."creationSource" = 'PURCHASE_PAGE'
        AND otp."stripePaymentIntentId" IS NOT NULL
      `),
    ]);
    return [...subscriptionRows, ...oneTimeRows];
  }));
  return new Set(rowsByGroup.flat().map((row) => row.tenancyId));
}

async function loadStripeSetupCompleteProjectIds(
  projects: ProjectDbRow[],
  enabledAppsByProjectId: Map<string, Set<AppId>>,
): Promise<Set<string>> {
  const candidates = projects.filter((project) =>
    project.stripeAccountId != null
    && enabledAppsByProjectId.get(project.id)?.has("payments") === true
  );
  if (isPreviewModeEnabled()) {
    return new Set(candidates.map((project) => project.id));
  }

  const stripe = getHexclaveStripe();
  const completed = await mapWithConcurrency(candidates, STRIPE_ACCOUNT_CONCURRENCY, async (project) => {
    const accountId = project.stripeAccountId ?? throwErr(`Stripe candidate ${project.id} is missing its account ID`);
    const account = await stripe.accounts.retrieve(accountId);
    return isStripeAccountSetupComplete(account)
      ? project.id
      : null;
  });
  return new Set(completed.filter((projectId): projectId is string => projectId != null));
}

async function loadOwnersByTeamId(ownerTeamIds: string[]): Promise<Map<string, { teamDisplayName: string, members: OwnerMember[] }>> {
  const uniqueTeamIds = [...new Set(ownerTeamIds)];
  const result = new Map<string, { teamDisplayName: string, members: OwnerMember[] }>();
  if (uniqueTeamIds.length === 0) return result;

  const internalTenancy = await getSoleTenancyFromProjectBranch(INTERNAL_PROJECT_ID, DEFAULT_BRANCH_ID);
  const prisma = await getPrismaClientForTenancy(internalTenancy);

  const [teams, members] = await Promise.all([
    prisma.team.findMany({
      where: { tenancyId: internalTenancy.id, teamId: { in: uniqueTeamIds } },
      select: { teamId: true, displayName: true },
    }),
    prisma.teamMember.findMany({
      where: { tenancyId: internalTenancy.id, teamId: { in: uniqueTeamIds } },
      select: {
        teamId: true,
        displayName: true,
        profileImageUrl: true,
        projectUser: {
          select: {
            projectUserId: true,
            displayName: true,
            profileImageUrl: true,
            createdAt: true,
            lastActiveAt: true,
            contactChannels: {
              where: { type: "EMAIL", isPrimary: "TRUE" },
              select: { value: true },
              take: 1,
            },
          },
        },
      },
    }),
  ]);

  const membersByTeamId = new Map<string, OwnerMember[]>();
  for (const member of members) {
    const list = membersByTeamId.get(member.teamId) ?? [];
    list.push({
      id: member.projectUser.projectUserId,
      display_name: member.displayName ?? member.projectUser.displayName,
      primary_email: member.projectUser.contactChannels[0]?.value ?? null,
      profile_image_url: member.profileImageUrl ?? member.projectUser.profileImageUrl,
      created_at: member.projectUser.createdAt.toISOString(),
      last_active_at: member.projectUser.lastActiveAt.toISOString(),
    });
    membersByTeamId.set(member.teamId, list);
  }

  for (const team of teams) {
    result.set(team.teamId, {
      teamDisplayName: team.displayName,
      members: (membersByTeamId.get(team.teamId) ?? []).sort((a, b) => {
        const aKey = a.primary_email ?? a.display_name ?? a.id;
        const bKey = b.primary_email ?? b.display_name ?? b.id;
        return stringCompare(aKey, bKey);
      }),
    });
  }
  return result;
}

function buildOwner(options: {
  isDevelopmentEnvironment: boolean,
  ownerTeamId: string | null,
  ownersByTeamId: Map<string, { teamDisplayName: string, members: OwnerMember[] }>,
}): ProjectOwner {
  if (options.isDevelopmentEnvironment) {
    return {
      kind: "rde",
      team_id: options.ownerTeamId,
      team_display_name: options.ownerTeamId == null ? null : (options.ownersByTeamId.get(options.ownerTeamId)?.teamDisplayName ?? null),
      members: options.ownerTeamId == null ? [] : (options.ownersByTeamId.get(options.ownerTeamId)?.members ?? []),
    };
  }
  if (options.ownerTeamId == null) {
    return { kind: "unknown", team_id: null, team_display_name: null, members: [] };
  }
  const owner = options.ownersByTeamId.get(options.ownerTeamId);
  if (owner == null) {
    return { kind: "unknown", team_id: options.ownerTeamId, team_display_name: null, members: [] };
  }
  if (owner.members.length === 1) {
    return {
      kind: "user",
      team_id: options.ownerTeamId,
      team_display_name: owner.teamDisplayName,
      members: owner.members,
    };
  }
  return {
    kind: "team",
    team_id: options.ownerTeamId,
    team_display_name: owner.teamDisplayName,
    members: owner.members,
  };
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type ProjectDbRow = {
  id: string,
  displayName: string,
  createdAt: Date,
  isDevelopmentEnvironment: boolean,
  onboardingStatus: string,
  ownerTeamId: string | null,
  stripeAccountId: string | null,
  description: string,
};

export async function buildNewlyCreatedProjectRows(
  projects: ProjectDbRow[],
  options: {
    activityMetrics?: ProjectActivityMetrics,
    renderedByProjectId?: Map<string, RenderedProjectData>,
  } = {},
): Promise<NewlyCreatedProjectRow[]> {
  const projectIds = projects.map((project) => project.id);
  const renderedByProjectId = options.renderedByProjectId ?? await loadRenderedProjectData(projectIds);
  const [
    { nonAnonByProjectId, anonByProjectId, lastActivityByProjectId },
    ownersByTeamId,
  ] = await Promise.all([
    options.activityMetrics ?? loadProjectActivityMetrics(projectIds),
    loadOwnersByTeamId(projects.map((project) => project.ownerTeamId).filter((id): id is string => id != null)),
  ]);

  const enabledAppIdsByProjectId = new Map(
    [...renderedByProjectId].map(([projectId, { config }]) => [projectId, getEnabledAppIds(config)]),
  );
  const enabledAppsByProjectId = new Map(
    [...enabledAppIdsByProjectId].map(([projectId, appIds]) => [projectId, new Set(appIds)]),
  );
  const tenancyGroups = await groupTenanciesByPrismaClient(renderedByProjectId);
  const [draftTenancyIds, livePaymentTenancyIds, stripeSetupCompleteProjectIds] = await Promise.all([
    loadEmailDraftTenancyIds(tenancyGroups),
    loadLivePaymentTenancyIds(tenancyGroups),
    loadStripeSetupCompleteProjectIds(projects, enabledAppsByProjectId),
  ]);

  const featuredSet = new Set<string>(FEATURED_APP_IDS);
  const rows: NewlyCreatedProjectRow[] = [];

  for (const project of projects) {
    const rendered = renderedByProjectId.get(project.id)
      ?? throwErr(`Rendered config missing for newly-created project ${project.id}`);
    const enabledAppIds = enabledAppIdsByProjectId.get(project.id)
      ?? throwErr(`Enabled apps missing for newly-created project ${project.id}`);
    const enabledSet = enabledAppsByProjectId.get(project.id)
      ?? throwErr(`Enabled app set missing for newly-created project ${project.id}`);
    const tenancyId = rendered.tenancy.id;
    const nonAnonymousUsers = nonAnonByProjectId.get(project.id) ?? 0;
    const anonymousUsers = anonByProjectId.get(project.id) ?? 0;
    const lastActivity = lastActivityByProjectId.get(project.id) ?? null;
    const hasEmailDraft = draftTenancyIds.has(tenancyId);
    const hasModifiedTemplate = hasModifiedEmailTemplate(rendered.config);
    const emailCustomized = hasModifiedTemplate || hasEmailDraft;
    const emailSetup = getEmailSetup(rendered.config);
    const stripeConnected = project.stripeAccountId != null;
    const stripeSetupComplete = stripeSetupCompleteProjectIds.has(project.id);
    const hasLivePayment = livePaymentTenancyIds.has(tenancyId);
    const isOnboarding = project.onboardingStatus !== "completed";

    rows.push({
      id: project.id,
      display_name: project.displayName,
      description: project.description,
      created_at: project.createdAt.toISOString(),
      is_development_environment: project.isDevelopmentEnvironment,
      onboarding_status: project.onboardingStatus,
      is_onboarding: isOnboarding,
      non_anonymous_users: nonAnonymousUsers,
      anonymous_users: anonymousUsers,
      last_user_activity_at: lastActivity?.toISOString() ?? null,
      has_activity_24h_after_creation: lastActivity != null
        && lastActivity.getTime() >= project.createdAt.getTime() + ONE_DAY_MS,
      owner: buildOwner({
        isDevelopmentEnvironment: project.isDevelopmentEnvironment,
        ownerTeamId: project.ownerTeamId,
        ownersByTeamId,
      }),
      domains: getTrustedDomainBaseUrls(rendered.config),
      stripe_connected: stripeConnected,
      stripe_setup_complete: stripeSetupComplete,
      email_customized: emailCustomized,
      email_customization: {
        has_draft: hasEmailDraft,
        has_modified_template: hasModifiedTemplate,
      },
      email_setup: emailSetup,
      has_live_payment: hasLivePayment,
      featured_apps: computeFeaturedAppLevels({
        enabledAppIds: enabledSet,
        nonAnonymousUsers,
        emailCustomized,
        emailSetupComplete: emailSetup.kind !== "shared",
        stripeSetupComplete,
        hasLivePayment,
      }),
      other_enabled_apps: enabledAppIds.filter((appId) => !featuredSet.has(appId)),
    });
  }

  return rows;
}

export async function loadNewlyCreatedProjectDetail(projectId: string, replayCursor: string | undefined) {
  const project = await globalPrismaClient.$replica().project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      displayName: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      isDevelopmentEnvironment: true,
      isProductionMode: true,
      onboardingStatus: true,
      onboardingState: true,
      ownerTeamId: true,
      stripeAccountId: true,
    },
  });
  if (project == null) {
    return null;
  }

  const renderedByProjectId = await loadRenderedProjectData([project.id]);
  const [rows, branchConfig] = await Promise.all([
    buildNewlyCreatedProjectRows([{
      id: project.id,
      displayName: project.displayName,
      createdAt: project.createdAt,
      isDevelopmentEnvironment: project.isDevelopmentEnvironment,
      onboardingStatus: project.onboardingStatus,
      ownerTeamId: project.ownerTeamId,
      stripeAccountId: project.stripeAccountId,
      description: project.description,
    }], { renderedByProjectId }),
    rawQuery(globalPrismaClient, getBranchConfigOverrideQuery({
      projectId: project.id,
      branchId: DEFAULT_BRANCH_ID,
    })),
  ]);

  const row = rows[0] ?? throwErr(`Expected a newly-created-projects row for ${project.id}`);
  const renderedConfig = renderedByProjectId.get(project.id)?.config
    ?? throwErr(`Rendered config missing for newly-created project detail ${project.id}`);
  let sessionReplays: ReturnType<typeof sessionReplayAdminRowToApiItem>[] = [];
  let replayNextCursor: string | null = null;
  const internalTenancy = await getSoleTenancyFromProjectBranch(INTERNAL_PROJECT_ID, DEFAULT_BRANCH_ID);
  const ownerUserIds = row.owner.members.map((member) => member.id);
  const qualifiedReplayIds = await loadInternalOwnerReplayIds(project.id, ownerUserIds);
  const [prisma, schema] = await Promise.all([
    getPrismaClientForTenancy(internalTenancy),
    getPrismaSchemaForTenancy(internalTenancy),
  ]);
  let cursorPivot: { id: string, lastEventAt: Date } | null = null;
  if (replayCursor != null) {
    if (!qualifiedReplayIds.includes(replayCursor)) {
      throw new HexclaveAssertionError("Session replay cursor does not match the selected project path", {
        projectId,
        replayCursor,
      });
    }
    cursorPivot = await prisma.$replica().sessionReplay.findFirst({
      where: {
        tenancyId: internalTenancy.id,
        id: replayCursor,
        projectUserId: { in: ownerUserIds },
      },
      select: { id: true, lastEventAt: true },
    });
    if (cursorPivot == null) {
      throw new HexclaveAssertionError("Session replay cursor does not belong to the selected project", {
        projectId,
        replayCursor,
      });
    }
  }
  const replayRows = qualifiedReplayIds.length === 0
    ? []
    : await querySessionReplayAdminRows({
      prisma,
      schema,
      tenancyId: internalTenancy.id,
      suffixSql: Prisma.sql`
        AND sr."projectUserId" IN (${Prisma.join(ownerUserIds)})
        AND sr."id" IN (${Prisma.join(qualifiedReplayIds)})
        ${cursorPivot == null ? Prisma.empty : Prisma.sql`AND (
          sr."lastEventAt" < ${cursorPivot.lastEventAt}
          OR (sr."lastEventAt" = ${cursorPivot.lastEventAt} AND sr."id" < ${cursorPivot.id})
        )`}
        ORDER BY sr."lastEventAt" DESC, sr."id" DESC
        LIMIT ${DETAIL_REPLAY_LIMIT + 1}
      `,
    });
  const hasMoreReplays = replayRows.length > DETAIL_REPLAY_LIMIT;
  const replayPage = hasMoreReplays ? replayRows.slice(0, DETAIL_REPLAY_LIMIT) : replayRows;
  replayNextCursor = hasMoreReplays
    ? replayPage.at(-1)?.id ?? throwErr("A non-empty replay page is required when pagination has more rows")
    : null;
  const aggs = await aggregateSessionReplayChunksByReplayIds(
    prisma,
    internalTenancy.id,
    replayPage.map((replayRow) => replayRow.id),
  );
  sessionReplays = replayPage.map((replayRow) =>
    sessionReplayAdminRowToApiItem(
      replayRow,
      aggs.get(replayRow.id) ?? { chunkCount: 0, eventCount: 0 },
    )
  );

  return {
    ...row,
    description: project.description,
    updated_at: project.updatedAt.toISOString(),
    is_production_mode: project.isProductionMode,
    onboarding_state: project.onboardingState,
    branch_config: branchConfig,
    rendered_config: renderedConfig,
    session_replays: sessionReplays,
    replay_next_cursor: replayNextCursor,
  };
}
