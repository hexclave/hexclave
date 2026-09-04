import { Prisma } from "@/generated/prisma/client";
import type { ConfigAgentRun as ConfigAgentRunRow } from "@/generated/prisma/client";
import { Config, getInvalidConfigReason, normalize, override, removeKeysFromConfig } from "@hexclave/shared/dist/config/format";
import { BranchConfigOverride, BranchConfigOverrideOverride, BranchIncompleteConfig, BranchRenderedConfig, CompleteConfig, EnvironmentConfigOverride, EnvironmentConfigOverrideOverride, EnvironmentIncompleteConfig, EnvironmentRenderedConfig, OrganizationConfigOverride, OrganizationConfigOverrideOverride, OrganizationIncompleteConfig, ProjectConfigOverride, ProjectConfigOverrideOverride, ProjectIncompleteConfig, ProjectRenderedConfig, applyBranchDefaults, applyEnvironmentDefaults, applyOrganizationDefaults, applyProjectDefaults, branchConfigSchema, environmentConfigSchema, getConfigOverrideErrors, getIncompleteConfigWarnings, migrateConfigOverride, organizationConfigSchema, projectConfigSchema, sanitizeBranchConfig, sanitizeEnvironmentConfig, sanitizeOrganizationConfig, sanitizeProjectConfig } from "@hexclave/shared/dist/config/schema";
import { ProjectsCrud } from "@hexclave/shared/dist/interface/crud/projects";
import { branchConfigSourceSchema, type ConfigAgentRunApi, type ConfigAgentSafeErrorMessage, yupBoolean, yupMixed, yupObject, yupRecord, yupString, yupUnion } from "@hexclave/shared/dist/schema-fields";
import { isTruthy } from "@hexclave/shared/dist/utils/booleans";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import { filterUndefined, typedEntries } from "@hexclave/shared/dist/utils/objects";
import { Result } from "@hexclave/shared/dist/utils/results";
import { deindent, stringCompare } from "@hexclave/shared/dist/utils/strings";
import * as yup from "yup";
import { PrismaClientTransaction, RawQuery, globalPrismaClient, rawQuery, retryTransaction } from "../../prisma-client";
import { DEVELOPMENT_ENVIRONMENT_ENV_CONFIG_BLOCKED_MESSAGE, getEnvironmentConfigWriteBlockReason, isDevelopmentEnvironmentProject } from "../development-environment";
import { listPermissionDefinitionsFromConfig } from "../permissions";
import type { CapturedChange, ConfigAgentInFlightStage, GithubRepoRef } from "./repo-agent";

type BranchConfigSourceApi = yup.InferType<typeof branchConfigSourceSchema>;
export type BranchConfigPushedError = {
  message: string,
};
export type ConfigWarning = {
  message: string,
};

type ProjectOptions = { projectId: string };
type BranchOptions = ProjectOptions & { branchId: string };
type EnvironmentOptions = BranchOptions;
type OrganizationOptions = EnvironmentOptions & ({ organizationId: string | null } | { forUserId: string });

const DEVELOPMENT_ENVIRONMENT_CONFIG_OVERRIDE = migrateConfigOverride("environment", {
  "domains.allowLocalhost": true,
  "payments.testMode": true,
});

// ---------------------------------------------------------------------------------------------------------------------
// getRendered<$$$>Config
// ---------------------------------------------------------------------------------------------------------------------
// returns the same object as the incomplete config, although with a restricted type so we don't accidentally use the
// fields that may still be overridden by other layers
// see packages/shared/src/config/README.md for more details
// TODO actually strip the fields that are not part of the type

export function getRenderedProjectConfigQuery(options: ProjectOptions): RawQuery<Promise<ProjectRenderedConfig>> {
  return RawQuery.then(
    getIncompleteProjectConfigQuery(options),
    async (incompleteConfig) => await sanitizeProjectConfig(normalize(applyProjectDefaults(await incompleteConfig), { onDotIntoNonObject: "ignore" }) as any),
  );
}

export function getRenderedBranchConfigQuery(options: BranchOptions): RawQuery<Promise<BranchRenderedConfig>> {
  return RawQuery.then(
    getIncompleteBranchConfigQuery(options),
    async (incompleteConfig) => await sanitizeBranchConfig(normalize(applyBranchDefaults(await incompleteConfig), { onDotIntoNonObject: "ignore" }) as any),
  );
}

export function getRenderedEnvironmentConfigQuery(options: EnvironmentOptions): RawQuery<Promise<EnvironmentRenderedConfig>> {
  return RawQuery.then(
    getIncompleteEnvironmentConfigQuery(options),
    async (incompleteConfig) => await sanitizeEnvironmentConfig(normalize(applyEnvironmentDefaults(await incompleteConfig), { onDotIntoNonObject: "ignore" }) as any),
  );
}

export function getRenderedOrganizationConfigQuery(options: OrganizationOptions): RawQuery<Promise<CompleteConfig>> {
  return RawQuery.then(
    getIncompleteOrganizationConfigQuery(options),
    async (incompleteConfig) => await sanitizeOrganizationConfig(normalize(applyOrganizationDefaults(await incompleteConfig), { onDotIntoNonObject: "ignore" }) as any),
  );
}


// ---------------------------------------------------------------------------------------------------------------------
// validate<$$$>ConfigOverride
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Validates a project config override ([sanity-check valid](./README.md)).
 */
export async function validateProjectConfigOverride(options: { projectConfigOverride: ProjectConfigOverride }): Promise<Result<null, string>> {
  return await validateConfigOverrideSchema(
    projectConfigSchema,
    {},
    options.projectConfigOverride,
  );
}

/**
 * Validates a branch config override ([sanity-check valid](./README.md)), based on the given project's rendered project config.
 */
export async function validateBranchConfigOverride(options: { branchConfigOverride: BranchConfigOverride } & ProjectOptions): Promise<Result<null, string>> {
  return await validateConfigOverrideSchema(
    branchConfigSchema,
    await rawQuery(globalPrismaClient, getIncompleteProjectConfigQuery(options)),
    options.branchConfigOverride,
  );
  // TODO add some more checks that depend on the base config; eg. an override config shouldn't set email server connection if isShared==true
  // (these are schematically valid, but make no sense, so we should be nice and reject them)
}

/**
 * Validates an environment config override ([sanity-check valid](./README.md)), based on the given branch's rendered branch config.
 */
export async function validateEnvironmentConfigOverride(options: { environmentConfigOverride: EnvironmentConfigOverride } & BranchOptions): Promise<Result<null, string>> {
  return await validateConfigOverrideSchema(
    environmentConfigSchema,
    await rawQuery(globalPrismaClient, getIncompleteBranchConfigQuery(options)),
    options.environmentConfigOverride,
  );
  // TODO add some more checks that depend on the base config; eg. an override config shouldn't set email server connection if isShared==true
  // (these are schematically valid, but make no sense, so we should be nice and reject them)
}

/**
 * Validates an organization config override ([sanity-check valid](./README.md)), based on the given environment's rendered environment config.
 */
export async function validateOrganizationConfigOverride(options: { organizationConfigOverride: OrganizationConfigOverride } & EnvironmentOptions): Promise<Result<null, string>> {
  return await validateConfigOverrideSchema(
    organizationConfigSchema,
    await rawQuery(globalPrismaClient, getIncompleteEnvironmentConfigQuery(options)),
    options.organizationConfigOverride,
  );
  // TODO add some more checks that depend on the base config; eg. an override config shouldn't set email server connection if isShared==true
  // (these are schematically valid, but make no sense, so we should be nice and reject them)
}


// ---------------------------------------------------------------------------------------------------------------------
// get<$$$>ConfigOverride
// ---------------------------------------------------------------------------------------------------------------------

// Placeholder types that should be replaced after the config json db migration

export function getProjectConfigOverrideQuery(options: ProjectOptions): RawQuery<Promise<ProjectConfigOverride>> {
  // fetch project config from our own DB
  // (currently it's just empty)
  return {
    supportedPrismaClients: ["global"],
    readOnlyQuery: true,
    sql: Prisma.sql`
      SELECT "Project"."projectConfigOverride"
      FROM "Project"
      WHERE "Project"."id" = ${options.projectId}
    `,
    postProcess: async (queryResult) => {
      if (queryResult.length > 1) {
        throw new HexclaveAssertionError(`Expected 0 or 1 project config overrides for project ${options.projectId}, got ${queryResult.length}`, { queryResult });
      }
      return migrateConfigOverride("project", queryResult[0]?.projectConfigOverride ?? {});
    },
  };
}

export function getBranchConfigOverrideQuery(options: BranchOptions): RawQuery<Promise<BranchConfigOverride>> {
  const fetchFromDbQuery: RawQuery<Promise<BranchConfigOverride>> = {
    supportedPrismaClients: ["global"],
    readOnlyQuery: true,
    sql: Prisma.sql`
      SELECT "BranchConfigOverride".*
      FROM "BranchConfigOverride"
      WHERE "BranchConfigOverride"."branchId" = ${options.branchId}
      AND "BranchConfigOverride"."projectId" = ${options.projectId}
    `,
    postProcess: async (queryResult) => {
      if (queryResult.length > 1) {
        throw new HexclaveAssertionError(`Expected 0 or 1 branch config overrides for project ${options.projectId} and branch ${options.branchId}, got ${queryResult.length}`, { queryResult });
      }
      return migrateConfigOverride("branch", queryResult[0]?.config ?? {});
    },
  };
  return fetchFromDbQuery;
}

export function getEnvironmentConfigOverrideQuery(options: EnvironmentOptions): RawQuery<Promise<EnvironmentConfigOverride>> {
  return {
    supportedPrismaClients: ["global"],
    readOnlyQuery: true,
    sql: Prisma.sql`
      SELECT
        "EnvironmentConfigOverride"."config",
        "Project"."isDevelopmentEnvironment"
      FROM "Project"
      LEFT JOIN "EnvironmentConfigOverride"
        ON "EnvironmentConfigOverride"."projectId" = "Project"."id"
        AND "EnvironmentConfigOverride"."branchId" = ${options.branchId}
      WHERE "Project"."id" = ${options.projectId}
    `,
    postProcess: async (queryResult) => {
      if (queryResult.length > 1) {
        throw new HexclaveAssertionError(`Expected 0 or 1 environment config overrides for project ${options.projectId} and branch ${options.branchId}, got ${queryResult.length}`, { queryResult });
      }
      const storedConfigOverride = migrateConfigOverride("environment", queryResult[0]?.config ?? {});
      if (queryResult[0]?.isDevelopmentEnvironment === true) {
        return override(storedConfigOverride, DEVELOPMENT_ENVIRONMENT_CONFIG_OVERRIDE);
      }
      return storedConfigOverride;
    },
  };
}

export function getOrganizationConfigOverrideQuery(options: OrganizationOptions): RawQuery<Promise<OrganizationConfigOverride>> {
  // fetch organization config from DB (either our own, or the source of truth one)
  if (!("forUserId" in options) && options.organizationId !== null) {
    throw new HexclaveAssertionError('Non-null organization ID is not implemented');
  }

  return {
    supportedPrismaClients: ["global"],
    readOnlyQuery: true,
    sql: Prisma.sql`SELECT 1`,
    postProcess: async () => {
      return migrateConfigOverride("organization", {});
    },
  };
}


// ---------------------------------------------------------------------------------------------------------------------
// override<$$$>ConfigOverride
// ---------------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------------
// set functions (replace the entire config override)
// ---------------------------------------------------------------------------------------------------------------------
// Note that the CALLER of these functions is responsible for validating the override, and making sure that
// there are no errors (warnings are allowed, but most UIs should probably ensure there are no warnings before allowing
// a user to save the override).

export async function setProjectConfigOverride(options: {
  projectId: string,
  projectConfigOverride: ProjectConfigOverride,
}): Promise<void> {
  const newConfig = migrateConfigOverride("project", options.projectConfigOverride);

  // large configs make our DB slow; let's prevent them early
  const newConfigString = JSON.stringify(newConfig);
  if (newConfigString.length > 1_000_000) {
    captureError("set-project-config-too-large", new HexclaveAssertionError(`Project config override for ${options.projectId} is ${(newConfigString.length/1_000_000).toFixed(1)}MB long!`));
  }
  if (newConfigString.length > 5_000_000) {
    throw new HexclaveAssertionError(`Project config override for ${options.projectId} is too large.`);
  }

  const overrideErrors = await getConfigOverrideErrors(projectConfigSchema, newConfig);
  if (overrideErrors.status === "error") {
    captureError("setProjectConfigOverride", new HexclaveAssertionError(`Config override is invalid — at a place where it should have already been validated! ${overrideErrors.error}`, { projectId: options.projectId }));
  }
  await globalPrismaClient.project.update({
    where: {
      id: options.projectId,
    },
    data: {
      projectConfigOverride: newConfig,
    },
  });
}

export async function setBranchConfigOverride(options: {
  projectId: string,
  branchId: string,
  branchConfigOverride: BranchConfigOverride,
}): Promise<void> {
  const newConfig = migrateConfigOverride("branch", options.branchConfigOverride);

  // large configs make our DB slow; let's prevent them early
  const newConfigString = JSON.stringify(newConfig);
  if (newConfigString.length > 1_000_000) {
    captureError("set-branch-config-too-large", new HexclaveAssertionError(`Branch config override for ${options.projectId}/${options.branchId} is ${(newConfigString.length/1_000_000).toFixed(1)}MB long!`));
  }
  if (newConfigString.length > 5_000_000) {
    throw new HexclaveAssertionError(`Branch config override for ${options.projectId}/${options.branchId} is too large.`);
  }

  const overrideErrors = await getConfigOverrideErrors(branchConfigSchema, newConfig);
  if (overrideErrors.status === "error") {
    captureError("setBranchConfigOverride", new HexclaveAssertionError(`Config override is invalid — at a place where it should have already been validated! ${overrideErrors.error}`, { projectId: options.projectId, branchId: options.branchId }));
  }
  await globalPrismaClient.branchConfigOverride.upsert({
    where: {
      projectId_branchId: {
        projectId: options.projectId,
        branchId: options.branchId,
      }
    },
    update: {
      config: newConfig,
    },
    create: {
      projectId: options.projectId,
      branchId: options.branchId,
      config: newConfig,
    },
  });
  await clearBranchConfigPushedError({
    projectId: options.projectId,
    branchId: options.branchId,
  });
}

function isBranchConfigPushedError(value: unknown): value is BranchConfigPushedError {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "message" in value &&
    typeof value.message === "string"
  );
}

export async function getBranchConfigPushedError(options: {
  projectId: string,
  branchId: string,
}): Promise<BranchConfigPushedError | null> {
  const rows = await globalPrismaClient.$replica().$queryRaw<Array<{ pushedConfigError: unknown }>>(Prisma.sql`
    SELECT "pushedConfigError"
    FROM "BranchConfigOverride"
    WHERE "projectId" = ${options.projectId}
      AND "branchId" = ${options.branchId}
    LIMIT 1
  `);
  const error = rows[0]?.pushedConfigError;
  return isBranchConfigPushedError(error) ? error : null;
}

export async function setBranchConfigPushedError(options: {
  projectId: string,
  branchId: string,
  error: BranchConfigPushedError,
}): Promise<void> {
  const errorJson = JSON.stringify(options.error);
  await globalPrismaClient.$executeRaw(Prisma.sql`
    INSERT INTO "BranchConfigOverride" ("projectId", "branchId", "config", "pushedConfigError", "updatedAt")
    VALUES (${options.projectId}, ${options.branchId}, '{}'::jsonb, ${errorJson}::jsonb, NOW())
    ON CONFLICT ("projectId", "branchId") DO UPDATE SET
      "pushedConfigError" = EXCLUDED."pushedConfigError",
      "updatedAt" = NOW()
  `);
}

export async function clearBranchConfigPushedError(options: {
  projectId: string,
  branchId: string,
}): Promise<void> {
  await globalPrismaClient.$executeRaw(Prisma.sql`
    UPDATE "BranchConfigOverride"
    SET "pushedConfigError" = NULL,
        "updatedAt" = NOW()
    WHERE "projectId" = ${options.projectId}
      AND "branchId" = ${options.branchId}
      AND "pushedConfigError" IS NOT NULL
  `);
}

export async function getDevelopmentEnvironmentConfigWarnings(options: {
  projectId: string,
  branchId: string,
  organizationId: string | null,
}): Promise<ConfigWarning[]> {
  if (!(await isDevelopmentEnvironmentProject(options.projectId))) {
    return [];
  }

  const incompleteConfig = await rawQuery(globalPrismaClient, getIncompleteOrganizationConfigQuery({
    projectId: options.projectId,
    branchId: options.branchId,
    organizationId: options.organizationId,
  }));
  const warnings = await getIncompleteConfigWarnings(organizationConfigSchema, incompleteConfig);
  if (warnings.status === "ok") {
    return [];
  }
  return warnings.error
    .split("\n")
    .filter((message) => message.length > 0)
    .map((message) => ({ message }));
}

/**
 * Gets the source metadata for the branch config override.
 */
export async function getBranchConfigOverrideSource(options: {
  projectId: string,
  branchId: string,
}): Promise<BranchConfigSourceApi> {
  const result = await globalPrismaClient.branchConfigOverride.findUnique({
    where: {
      projectId_branchId: {
        projectId: options.projectId,
        branchId: options.branchId,
      }
    },
    select: {
      source: true,
    },
  });

  // If no source is set or record doesn't exist, default to unlinked
  if (!result?.source) {
    return { type: "unlinked" };
  }

  return result.source as BranchConfigSourceApi;
}

/**
 * Sets the source metadata for the branch config override.
 */
export async function setBranchConfigOverrideSource(options: {
  projectId: string,
  branchId: string,
  source: BranchConfigSourceApi,
}): Promise<void> {
  await globalPrismaClient.branchConfigOverride.upsert({
    where: {
      projectId_branchId: {
        projectId: options.projectId,
        branchId: options.branchId,
      }
    },
    update: {
      source: options.source as any,
    },
    create: {
      projectId: options.projectId,
      branchId: options.branchId,
      config: {}, // Empty config for new records
      source: options.source as any,
    },
  });
}

/**
 * Unlinks the branch config source, setting it to "unlinked".
 * Compare-and-set so concurrent DELETEs only one of them records the transition.
 */
export async function unlinkBranchConfigOverrideSource(options: {
  projectId: string,
  branchId: string,
}): Promise<{ didUnlink: boolean, beforeSource: BranchConfigSourceApi }> {
  return await retryTransaction(globalPrismaClient, async (tx) => {
    const result = await tx.branchConfigOverride.findUnique({
      where: {
        projectId_branchId: {
          projectId: options.projectId,
          branchId: options.branchId,
        },
      },
      select: {
        source: true,
      },
    });
    const beforeSource = (!result?.source)
      ? { type: "unlinked" as const }
      : result.source as BranchConfigSourceApi;
    if (beforeSource.type === "unlinked") {
      return { didUnlink: false, beforeSource };
    }
    await tx.branchConfigOverride.upsert({
      where: {
        projectId_branchId: {
          projectId: options.projectId,
          branchId: options.branchId,
        },
      },
      update: {
        source: { type: "unlinked" } as any,
      },
      create: {
        projectId: options.projectId,
        branchId: options.branchId,
        config: {},
        source: { type: "unlinked" } as any,
      },
    });
    return { didUnlink: true, beforeSource };
  }, { level: "serializable" });
}

export type GithubConfigSource = Extract<BranchConfigSourceApi, { type: "pushed-from-github" }>;

/**
 * Loads the branch config source and asserts it is linked to a GitHub repo,
 * returning the narrowed `pushed-from-github` source (else throws `BadRequest`).
 * Shared by the GitHub config-agent routes.
 */
export async function getGithubConfigSourceOrThrow(options: {
  projectId: string,
  branchId: string,
}): Promise<GithubConfigSource> {
  const source = await getBranchConfigOverrideSource(options);
  if (source.type !== "pushed-from-github") {
    throw new StatusError(StatusError.BadRequest, "This project's configuration is not linked to a GitHub repository.");
  }
  return source;
}

/** Maps a `ConfigAgentRun` table row to the API shape the dashboard polls. */
function toConfigAgentRunApi(row: ConfigAgentRunRow): ConfigAgentRunApi {
  return {
    id: row.id,
    status: row.status as ConfigAgentRunApi["status"],
    started_at: row.startedAt.getTime(),
    ...(row.finishedAt != null ? { finished_at: row.finishedAt.getTime() } : {}),
    ...(row.commitUrl != null ? { commit_url: row.commitUrl } : {}),
    ...(row.error != null ? { error: row.error as ConfigAgentSafeErrorMessage } : {}),
    ...(row.sandboxId != null ? { sandbox_id: row.sandboxId } : {}),
    ...(row.progress != null ? { progress: row.progress } : {}),
    ...(row.stage != null ? { stage: row.stage as NonNullable<ConfigAgentRunApi["stage"]> } : {}),
    ...(row.diff != null ? { diff: row.diff } : {}),
  };
}

/**
 * `FOR UPDATE`-locks a single run row by id (so a read-modify-write transition can't
 * race a concurrent cancel/commit on the SAME run). Returns `null` if the run is gone.
 * Each run is its own row, so this never blocks a different run on the same branch.
 */
async function lockConfigAgentRun(tx: PrismaClientTransaction, runId: string): Promise<ConfigAgentRunRow | null> {
  const rows = await tx.$queryRaw<ConfigAgentRunRow[]>`
    SELECT * FROM "ConfigAgentRun" WHERE "id" = ${runId}::uuid FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Computes the COMPLETE config that belongs in the linked repo's config file: the
 * project's current BRANCH config override (the user's full intended config —
 * enabled apps, sign-up rules WITH their content, auth settings, …) merged with
 * the dashboard's pending change, normalized to a nested object. The repo agent
 * writes this WHOLE object to the file, so the file stays complete instead of
 * accreting one-key deltas. (The config file maps 1:1 to the branch config
 * override — `pushConfig` from the repo's workflow replaces the branch override
 * with the file's contents, so an incomplete file would wipe real config.)
 */
export async function getCompleteBranchConfigForFile(options: {
  projectId: string,
  branchId: string,
  configUpdate: Record<string, unknown>,
}): Promise<Record<string, unknown>> {
  const current = await rawQuery(globalPrismaClient, getBranchConfigOverrideQuery({ projectId: options.projectId, branchId: options.branchId }));
  const merged = override(current as Config, options.configUpdate as Config);
  // Dashboard saves usually arrive as dot-notation deltas (for example
  // `auth.allowSignUp: false`). The branch override can be empty, so missing
  // parents must be materialized instead of silently dropping the pending edit.
  return normalize(merged, { onDotIntoNonObject: "ignore", onDotIntoNull: "empty-object" }) as Record<string, unknown>;
}

/**
 * Records the start of a dashboard→GitHub config agent run: inserts a fresh
 * `running` row in the `ConfigAgentRun` table and returns its id plus the locked
 * GitHub source (for the repo ref). Runs are intentionally NOT serialized — each
 * start is an independent row, so many runs can target the same branch at once;
 * a concurrent edit to the real repo is caught by GitHub at push time
 * (`assertRemoteBranchStillAtClonedHead` / non-fast-forward → `ConfigRepoCommitConflictError`),
 * never by a DB lock. {@link recordConfigAgentRunResult} writes the terminal status.
 */
export async function startConfigAgentRun(options: {
  projectId: string,
  branchId: string,
  nowMs: number,
}): Promise<{ source: GithubConfigSource, runId: string }> {
  return await retryTransaction(globalPrismaClient, async (tx) => {
    // Read (and lock) the source in the same txn so a concurrent re-link can't
    // redirect this run's push to a different repo.
    const rows = await tx.$queryRaw<{ source: BranchConfigSourceApi | null }[]>`
      SELECT "source" FROM "BranchConfigOverride"
      WHERE "projectId" = ${options.projectId} AND "branchId" = ${options.branchId}
      FOR UPDATE
    `;
    const source = rows[0]?.source ?? null;
    if (source?.type !== "pushed-from-github") {
      throw new HexclaveAssertionError("Config source is not linked to GitHub; cannot run the config agent.");
    }
    const run = await tx.configAgentRun.create({
      data: {
        projectId: options.projectId,
        branchId: options.branchId,
        status: "running",
        startedAt: new Date(options.nowMs),
      },
      select: { id: true },
    });
    return { source, runId: run.id };
  });
}

/**
 * Reads a specific config-agent run (scoped to its project/branch) for the
 * dashboard to poll. Returns `null` if the run id doesn't belong to this branch.
 */
export async function getConfigAgentRun(options: {
  projectId: string,
  branchId: string,
  runId: string,
}): Promise<ConfigAgentRunApi | null> {
  const row = await globalPrismaClient.configAgentRun.findFirst({
    where: { id: options.runId, projectId: options.projectId, branchId: options.branchId },
  });
  return row ? toConfigAgentRunApi(row) : null;
}

/**
 * Records the live sandbox id of an in-flight run so a later cancel (a separate
 * request/invocation) can hard-stop it. The `status = "running"` guard makes it a
 * no-op once the run is terminal, so a late write can't resurrect a sandbox id.
 */
export async function recordConfigAgentRunSandbox(options: {
  runId: string,
  sandboxId: string,
}): Promise<void> {
  await globalPrismaClient.configAgentRun.updateMany({
    where: { id: options.runId, status: "running" },
    data: { sandboxId: options.sandboxId },
  });
}

/**
 * Writes the live (sanitized) activity feed of an in-flight run so the dashboard
 * can show what the agent is doing. No-ops unless this run is still `running`. The
 * caller is responsible for keeping `progress` short and free of secrets/tokens.
 */
export async function recordConfigAgentRunProgress(options: {
  runId: string,
  progress: string,
}): Promise<void> {
  await globalPrismaClient.configAgentRun.updateMany({
    where: { id: options.runId, status: "running" },
    // DB-size guard on the persisted feed; the runner already trims lines/count
    // (see buildRunnerScript), so this only bites pathological input.
    data: { progress: options.progress.slice(0, 2000) },
  });
}

/**
 * Records the current stage of an in-flight run for the dashboard progress bar.
 * No-ops unless this run is still `running`.
 */
export async function recordConfigAgentRunStage(options: {
  runId: string,
  stage: ConfigAgentInFlightStage,
}): Promise<void> {
  await globalPrismaClient.configAgentRun.updateMany({
    where: { id: options.runId, status: "running" },
    data: { stage: options.stage },
  });
}

/**
 * Transitions a `running` run to `awaiting_review`: the agent has finished editing and
 * the change is already captured (the sandbox has been stopped). The diff is stored for
 * the dashboard AND as the commit source, with `baseCommitSha` (the commit it was made
 * against) so it can be rebuilt + pushed via the GitHub API on confirm; the stale
 * sandbox id is cleared. No-ops if the run is no longer `running` — e.g. cancelled mid-flight.
 */
export async function setConfigAgentRunAwaitingReview(options: {
  runId: string,
  change: CapturedChange,
}): Promise<void> {
  await retryTransaction(globalPrismaClient, async (tx) => {
    const run = await lockConfigAgentRun(tx, options.runId);
    if (run?.status !== "running") return;
    await tx.configAgentRun.update({
      where: { id: options.runId },
      data: {
        status: "awaiting_review",
        stage: "awaiting_review",
        // The diff is authoritative for the commit, so it is stored whole (already
        // size-capped at capture time), not truncated.
        diff: options.change.diff,
        baseCommitSha: options.change.baseSha,
        sandboxId: null,
      },
    });
  });
}

/**
 * Loads a run's captured change (diff + base commit) for the commit route, scoped to
 * its project/branch. Returns `null` if the run id doesn't belong to this branch, or
 * `{ status, change: null }` if the row isn't carrying a complete capture.
 */
export async function getConfigAgentRunChange(options: {
  projectId: string,
  branchId: string,
  runId: string,
}): Promise<{ status: string, change: CapturedChange | null } | null> {
  const row = await globalPrismaClient.configAgentRun.findFirst({
    where: { id: options.runId, projectId: options.projectId, branchId: options.branchId },
    select: { status: true, diff: true, baseCommitSha: true },
  });
  if (!row) return null;
  const change = row.diff != null && row.baseCommitSha != null
    ? { diff: row.diff, baseSha: row.baseCommitSha }
    : null;
  return { status: row.status, change };
}

/**
 * Requests cancellation of a specific config agent run. Atomically flips a
 * `running` or `awaiting_review` run to the terminal `cancelled` status and returns
 * the sandbox id (only present while `running`) so the caller can hard-stop the
 * sandbox, plus the `previousStatus` (so the caller can tell "running with no sandbox
 * recorded" — a real leak — from "awaiting_review", where the sandbox is expected to
 * be gone already). Returns `{ cancelled: false }` when the run is gone, not on this
 * branch, or already terminal. (No revert: a commit that already landed stays.)
 */
export async function cancelConfigAgentRun(options: {
  projectId: string,
  branchId: string,
  runId: string,
  nowMs: number,
}): Promise<{ cancelled: boolean, sandboxId?: string, previousStatus?: string }> {
  return await retryTransaction(globalPrismaClient, async (tx) => {
    const run = await lockConfigAgentRun(tx, options.runId);
    if (!run || run.projectId !== options.projectId || run.branchId !== options.branchId) {
      return { cancelled: false };
    }
    if (run.status !== "running" && run.status !== "awaiting_review") {
      return { cancelled: false };
    }
    await tx.configAgentRun.update({
      where: { id: options.runId },
      // Clear the captured change too: a cancelled run is abandoned, so its diff/base
      // must not linger in the API shape or be replayable by the commit route.
      data: { status: "cancelled", finishedAt: new Date(options.nowMs), sandboxId: null, stage: null, baseCommitSha: null, diff: null },
    });
    return { cancelled: true, sandboxId: run.sandboxId ?? undefined, previousStatus: run.status };
  });
}

/**
 * Records the outcome of a config agent run: stamps the terminal run status, and on
 * a pushed commit advances the source's `commit_hash`. No-ops unless the run is
 * still in flight (`running`/`awaiting_review`), so a cancel that already landed wins.
 */
export async function recordConfigAgentRunResult(options: {
  projectId: string,
  branchId: string,
  runId: string,
  nowMs: number,
  outcome:
    | { status: "success", commitUrl?: string, newCommitHash?: string, committedRef: GithubRepoRef }
    | { status: "no-change" }
    | { status: "error", error: ConfigAgentSafeErrorMessage },
}): Promise<void> {
  await retryTransaction(globalPrismaClient, async (tx) => {
    const run = await lockConfigAgentRun(tx, options.runId);
    if (!run || (run.status !== "running" && run.status !== "awaiting_review")) return;
    const finishedAt = new Date(options.nowMs);
    if (options.outcome.status === "error") {
      await tx.configAgentRun.update({
        where: { id: options.runId },
        data: { status: "error", finishedAt, error: options.outcome.error, sandboxId: null, stage: null, baseCommitSha: null },
      });
      return;
    }
    if (options.outcome.status === "no-change") {
      await tx.configAgentRun.update({
        where: { id: options.runId },
        data: { status: "no-change", finishedAt, sandboxId: null, stage: null, baseCommitSha: null },
      });
      return;
    }
    await tx.configAgentRun.update({
      where: { id: options.runId },
      data: { status: "success", finishedAt, commitUrl: options.outcome.commitUrl ?? null, sandboxId: null, stage: null, baseCommitSha: null },
    });
    // Advance the source's last-known commit when a commit landed and the branch
    // is still linked to the SAME repo the commit was pushed against (locked in the
    // same txn). A mid-run re-link to a different repo still reads as
    // `pushed-from-github`, so identity — not just type — must match, or the new
    // source would inherit a commit hash that only exists on the old repo.
    const committedRef = options.outcome.committedRef;
    if (options.outcome.newCommitHash) {
      const sourceRows = await tx.$queryRaw<{ source: BranchConfigSourceApi | null }[]>`
        SELECT "source" FROM "BranchConfigOverride"
        WHERE "projectId" = ${options.projectId} AND "branchId" = ${options.branchId}
        FOR UPDATE
      `;
      const source = sourceRows[0]?.source ?? null;
      if (
        source?.type === "pushed-from-github"
        && source.owner === committedRef.owner
        && source.repo === committedRef.repo
        && source.branch === committedRef.branch
      ) {
        await tx.branchConfigOverride.update({
          where: { projectId_branchId: { projectId: options.projectId, branchId: options.branchId } },
          data: { source: { ...source, commit_hash: options.outcome.newCommitHash } as any },
        });
      }
    }
  });
}

export async function setEnvironmentConfigOverride(options: {
  projectId: string,
  branchId: string,
  environmentConfigOverride: EnvironmentConfigOverride,
}): Promise<void> {
  const blockReason = await getEnvironmentConfigWriteBlockReason(options.projectId);
  if (blockReason != null) {
    throw new HexclaveAssertionError(blockReason, {
      projectId: options.projectId,
      branchId: options.branchId,
    });
  }

  const newConfig = migrateConfigOverride("environment", options.environmentConfigOverride);

  // large configs make our DB slow; let's prevent them early
  const newConfigString = JSON.stringify(newConfig);
  if (newConfigString.length > 1_000_000) {
    captureError("set-environment-config-too-large", new HexclaveAssertionError(`Environment config override for ${options.projectId}/${options.branchId} is ${(newConfigString.length/1_000_000).toFixed(1)}MB long!`));
  }
  if (newConfigString.length > 5_000_000) {
    throw new HexclaveAssertionError(`Environment config override for ${options.projectId}/${options.branchId} is too large.`);
  }

  const overrideErrors = await getConfigOverrideErrors(environmentConfigSchema, newConfig);
  if (overrideErrors.status === "error") {
    captureError("setEnvironmentConfigOverride", new HexclaveAssertionError(`Config override is invalid — at a place where it should have already been validated! ${overrideErrors.error}`, { projectId: options.projectId, branchId: options.branchId }));
  }
  await globalPrismaClient.environmentConfigOverride.upsert({
    where: {
      projectId_branchId: {
        projectId: options.projectId,
        branchId: options.branchId,
      }
    },
    update: {
      config: newConfig,
    },
    create: {
      projectId: options.projectId,
      branchId: options.branchId,
      config: newConfig,
    },
  });
}

export function setOrganizationConfigOverride(options: {
  projectId: string,
  branchId: string,
  organizationId: string | null,
  organizationConfigOverride: OrganizationConfigOverride,
}): Promise<void> {
  // save organization config override on DB (either our own, or the source of truth one)
  throw new HexclaveAssertionError('Not implemented');
}


// ---------------------------------------------------------------------------------------------------------------------
// override functions (merge with existing config override)
// ---------------------------------------------------------------------------------------------------------------------
// Note that the arguments passed in here override the override; they are therefore OverrideOverrides.
// Also, note that the CALLER of these functions is responsible for validating the override, and making sure that
// there are no errors (warnings are allowed, but most UIs should probably ensure there are no warnings before allowing
// a user to save the override).

export async function overrideProjectConfigOverride(options: {
  projectId: string,
  projectConfigOverrideOverride: ProjectConfigOverrideOverride,
}): Promise<ProjectConfigOverride> {
  // TODO put this in a serializable transaction (or a single SQL query) to prevent race conditions
  const oldConfig = await rawQuery(globalPrismaClient, getProjectConfigOverrideQuery(options));
  const newConfigUnmigrated = override(
    oldConfig,
    options.projectConfigOverrideOverride,
  ) as ProjectConfigOverride;

  await setProjectConfigOverride({
    projectId: options.projectId,
    projectConfigOverride: newConfigUnmigrated,
  });

  return newConfigUnmigrated;
}

export async function overrideBranchConfigOverride(options: {
  projectId: string,
  branchId: string,
  branchConfigOverrideOverride: BranchConfigOverrideOverride,
}): Promise<BranchConfigOverride> {
  // TODO put this in a serializable transaction (or a single SQL query) to prevent race conditions
  const oldConfig = await rawQuery(globalPrismaClient, getBranchConfigOverrideQuery(options));
  const newConfigUnmigrated = override(
    oldConfig,
    options.branchConfigOverrideOverride,
  ) as BranchConfigOverride;

  // setBranchConfigOverride uses upsert and preserves existing source automatically
  await setBranchConfigOverride({
    projectId: options.projectId,
    branchId: options.branchId,
    branchConfigOverride: newConfigUnmigrated,
  });

  return newConfigUnmigrated;
}

export async function overrideEnvironmentConfigOverride(options: {
  projectId: string,
  branchId: string,
  environmentConfigOverrideOverride: EnvironmentConfigOverrideOverride,
}): Promise<EnvironmentConfigOverride> {
  // TODO put this in a serializable transaction (or a single SQL query) to prevent race conditions
  const oldConfig = await rawQuery(globalPrismaClient, getEnvironmentConfigOverrideQuery(options));
  const newConfigUnmigrated = override(
    oldConfig,
    options.environmentConfigOverrideOverride,
  ) as EnvironmentConfigOverride;

  await setEnvironmentConfigOverride({
    projectId: options.projectId,
    branchId: options.branchId,
    environmentConfigOverride: newConfigUnmigrated,
  });

  return newConfigUnmigrated;
}

export function overrideOrganizationConfigOverride(options: {
  projectId: string,
  branchId: string,
  organizationId: string | null,
  organizationConfigOverrideOverride: OrganizationConfigOverrideOverride,
}): Promise<OrganizationConfigOverride> {
  // save organization config override on DB (either our own, or the source of truth one)
  throw new HexclaveAssertionError('Not implemented');
}


// ---------------------------------------------------------------------------------------------------------------------
// reset functions (remove specific keys from config override)
// ---------------------------------------------------------------------------------------------------------------------
// Uses the same nested key logic as the `override` function: resetting key "a.b" also resets "a.b.c".

export async function resetProjectConfigOverrideKeys(options: {
  projectId: string,
  keysToReset: string[],
}): Promise<void> {
  // TODO put this in a serializable transaction (or a single SQL query) to prevent race conditions
  const oldConfig = await rawQuery(globalPrismaClient, getProjectConfigOverrideQuery(options));
  const newConfig = removeKeysFromConfig(oldConfig, options.keysToReset);

  await setProjectConfigOverride({
    projectId: options.projectId,
    projectConfigOverride: newConfig as ProjectConfigOverride,
  });
}

export async function resetBranchConfigOverrideKeys(options: {
  projectId: string,
  branchId: string,
  keysToReset: string[],
}): Promise<void> {
  // TODO put this in a serializable transaction (or a single SQL query) to prevent race conditions
  const oldConfig = await rawQuery(globalPrismaClient, getBranchConfigOverrideQuery(options));
  const newConfig = removeKeysFromConfig(oldConfig, options.keysToReset);

  await setBranchConfigOverride({
    projectId: options.projectId,
    branchId: options.branchId,
    branchConfigOverride: newConfig as BranchConfigOverride,
  });
}

export async function resetEnvironmentConfigOverrideKeys(options: {
  projectId: string,
  branchId: string,
  keysToReset: string[],
}): Promise<void> {
  // TODO put this in a serializable transaction (or a single SQL query) to prevent race conditions
  const oldConfig = await rawQuery(globalPrismaClient, getEnvironmentConfigOverrideQuery(options));
  const newConfig = removeKeysFromConfig(oldConfig, options.keysToReset);

  await setEnvironmentConfigOverride({
    projectId: options.projectId,
    branchId: options.branchId,
    environmentConfigOverride: newConfig as EnvironmentConfigOverride,
  });
}

export async function resetOrganizationConfigOverrideKeys(options: {
  projectId: string,
  branchId: string,
  organizationId: string | null,
  keysToReset: string[],
}): Promise<void> {
  // TODO put this in a serializable transaction (or a single SQL query) to prevent race conditions
  const oldConfig = await rawQuery(globalPrismaClient, getOrganizationConfigOverrideQuery(options));
  const newConfig = removeKeysFromConfig(oldConfig, options.keysToReset);

  await setOrganizationConfigOverride({
    projectId: options.projectId,
    branchId: options.branchId,
    organizationId: options.organizationId,
    organizationConfigOverride: newConfig as OrganizationConfigOverride,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// internal functions
// ---------------------------------------------------------------------------------------------------------------------

function getIncompleteProjectConfigQuery(options: ProjectOptions): RawQuery<Promise<ProjectIncompleteConfig>> {
  return RawQuery.then(
    makeUnsanitizedIncompleteConfigQuery({
      override: getProjectConfigOverrideQuery(options),
      schema: projectConfigSchema,
      extraInfo: options,
    }),
    async (config) => await config,
  );
}

function getIncompleteBranchConfigQuery(options: BranchOptions): RawQuery<Promise<BranchIncompleteConfig>> {
  return RawQuery.then(
    makeUnsanitizedIncompleteConfigQuery({
      previous: getIncompleteProjectConfigQuery(options),
      override: getBranchConfigOverrideQuery(options),
      schema: branchConfigSchema,
      extraInfo: options,
    }),
    async (config) => await config,
  );
}

function getIncompleteEnvironmentConfigQuery(options: EnvironmentOptions): RawQuery<Promise<EnvironmentIncompleteConfig>> {
  return RawQuery.then(
    makeUnsanitizedIncompleteConfigQuery({
      previous: getIncompleteBranchConfigQuery(options),
      override: getEnvironmentConfigOverrideQuery(options),
      schema: environmentConfigSchema,
      extraInfo: options,
    }),
    async (config) => await config,
  );
}

function getIncompleteOrganizationConfigQuery(options: OrganizationOptions): RawQuery<Promise<OrganizationIncompleteConfig>> {
  return RawQuery.then(
    makeUnsanitizedIncompleteConfigQuery({
      previous: getIncompleteEnvironmentConfigQuery(options),
      override: getOrganizationConfigOverrideQuery(options),
      schema: organizationConfigSchema,
      extraInfo: options,
    }),
    async (config) => await config,
  );
}

function makeUnsanitizedIncompleteConfigQuery<T, O>(options: { previous?: RawQuery<Promise<Config>>, override: RawQuery<Promise<Config>>, schema: yup.AnySchema, extraInfo: any }): RawQuery<Promise<any>> {
  return RawQuery.then(
    RawQuery.all([
      options.previous ?? RawQuery.resolve(Promise.resolve({})),
      options.override,
    ] as const),
    async ([prevPromise, overPromise]) => {
      const prev = await prevPromise;
      const over = await overPromise;
      const overrideErrors = await getConfigOverrideErrors(options.schema, over);
      if (overrideErrors.status === "error") {
        captureError("config-override-validation-error", new HexclaveAssertionError(`Config override is invalid — at a place where it should have already been validated! ${overrideErrors.error}`, { extraInfo: options.extraInfo }));
      }
      return override(prev, over);
    },
  );
}

/**
 * Validates the config override against three different schemas: the base one, the default one, and an empty base.
 *
 *
 */
async function validateConfigOverrideSchema(
  schema: yup.AnySchema,
  base: any,
  configOverride: any,
): Promise<Result<null, string>> {
  const mergedResBase = await _validateConfigOverrideSchemaImpl(schema, base, configOverride);
  if (mergedResBase.status === "error") return mergedResBase;

  return Result.ok(null);
}

async function _validateConfigOverrideSchemaImpl(
  schema: yup.AnySchema,
  base: any,
  configOverride: any,
): Promise<Result<null, string>> {
  // Check config format
  const reason = getInvalidConfigReason(configOverride, { configName: 'override' });
  if (reason) return Result.error("[FORMAT ERROR]" + reason);

  // Ensure there are no errors in the config override
  const errors = await getConfigOverrideErrors(schema, configOverride);
  if (errors.status === "error") {
    return Result.error("[ERROR] " + errors.error);
  }

  // Override
  const overridden = override(base, configOverride);

  // Get warnings
  const warnings = await getIncompleteConfigWarnings(schema, overridden);
  if (warnings.status === "error") {
    return Result.error("[WARNING] " + warnings.error);
  }
  return Result.ok(null);
}

import.meta.vitest?.test('_validateConfigOverrideSchemaImpl(...)', async ({ expect }) => {
  const schema1 = yupObject({
    a: yupString().optional(),
  });
  const recordSchema = yupObject({ a: yupRecord(yupString().defined(), yupString().defined()) }).defined();
  const unionSchema = yupObject({
    a: yupUnion(
      yupString().defined().oneOf(['never']),
      yupObject({ time: yupString().defined().oneOf(['now']) }).defined(),
      yupObject({ time: yupString().defined().oneOf(['tomorrow']), morning: yupBoolean().defined() }).defined()
    ).defined()
  }).defined();

  // Base success cases
  expect(await validateConfigOverrideSchema(schema1, {}, {})).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(schema1, { a: 'b' }, {})).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(schema1, {}, { a: 'b' })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(schema1, { a: 'b' }, { a: 'c' })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(schema1, {}, { a: null })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(schema1, { a: 'b' }, { a: null })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(yupObject({ a: yupString().defined() }), {}, { a: 'b' })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(yupObject({ a: yupString().defined().oneOf(['b']) }), {}, { a: 'b' })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(yupObject({ a: yupObject({ c: yupString().defined() }).defined() }), { a: {} }, { "a.c": 'd' })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(recordSchema, { a: {} }, { "a.c": 'd' })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(unionSchema, {}, { "a": 'never' })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(unionSchema, { a: {} }, { "a": 'never' })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(unionSchema, { a: {} }, { "a.time": 'now' })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(unionSchema, { a: { "time": "tomorrow" } }, { "a.morning": true })).toEqual(Result.ok(null));

  // Error cases
  expect(await validateConfigOverrideSchema(yupObject({ a: yupObject({ b: yupObject({ c: yupString().defined() }).defined() }).defined() }), { a: { b: {} } }, { "a.b": { c: 123 } })).toEqual(Result.error("[ERROR] a.b.c must be a `string` type, but the final value was: `123`."));
  expect(await validateConfigOverrideSchema(yupObject({ a: yupString().defined().oneOf(['b']) }), {}, { a: 'c' })).toEqual(Result.error("[ERROR] a must be one of the following values: b"));
  expect(await validateConfigOverrideSchema(yupObject({ a: yupString().defined() }), {}, {})).toEqual(Result.error("[WARNING] a must be defined"));
  expect(await validateConfigOverrideSchema(yupObject({}), {}, { "a.b": "c" })).toEqual(Result.error(`[ERROR] The key \"a.b\" is not valid (nested object not found in schema: "a").`));
  expect(await validateConfigOverrideSchema(yupObject({ a: yupMixed() }), {}, { "a.b": "c" })).toEqual(Result.error(`[ERROR] The key \"a.b\" is not valid (nested object not found in schema: "a.b").`));
  expect(await validateConfigOverrideSchema(yupObject({ a: yupMixed() }), { a: 'str' }, { "a.b": "c" })).toEqual(Result.error(`[ERROR] The key \"a.b\" is not valid (nested object not found in schema: "a.b").`));
  expect(await validateConfigOverrideSchema(yupObject({ a: yupObject({ c: yupString().optional() }) }), { a: 'str' }, { "a.b": "c" })).toEqual(Result.error(`[ERROR] The key \"a.b\" is not valid (nested object not found in schema: "a.b").`));
  expect(await validateConfigOverrideSchema(schema1, {}, { a: 123 })).toEqual(Result.error('[ERROR] a must be a `string` type, but the final value was: `123`.'));
  expect(await validateConfigOverrideSchema(unionSchema, { a: { "time": "now" } }, { "a.morning": true })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] a is not matched by any of the provided schemas:
      Schema 0:
        a must be a \`string\` type, but the final value was: \`{
          "time": "\\"now\\"",
          "morning": "true"
        }\`.
      Schema 1:
        a contains unknown properties: morning
      Schema 2:
        a.time must be one of the following values: tomorrow",
      "status": "error",
    }
  `);

  // Actual configs — base cases
  const projectSchemaBase = {};
  expect(await validateConfigOverrideSchema(projectConfigSchema, projectSchemaBase, {})).toEqual(Result.ok(null));
  const branchSchemaBase = projectSchemaBase;
  expect(await validateConfigOverrideSchema(branchConfigSchema, branchSchemaBase, {})).toEqual(Result.ok(null));
  const environmentSchemaBase = branchSchemaBase;
  expect(await validateConfigOverrideSchema(environmentConfigSchema, environmentSchemaBase, {})).toEqual(Result.ok(null));
  const organizationSchemaBase = environmentSchemaBase;
  expect(await validateConfigOverrideSchema(organizationConfigSchema, organizationSchemaBase, {})).toEqual(Result.ok(null));

  // Actual configs — advanced cases
  expect(await validateConfigOverrideSchema(projectConfigSchema, projectSchemaBase, {
    sourceOfTruth: {
      type: 'hosted',
    },
  })).toEqual(Result.ok(null));
  expect(await validateConfigOverrideSchema(projectConfigSchema, projectSchemaBase, {
    sourceOfTruth: {
      type: 'postgres',
      connectionString: 'postgres://user:pass@host:port/db',
    },
  })).toEqual(Result.error(deindent`
    [ERROR] sourceOfTruth is not matched by any of the provided schemas:
      Schema 0:
        sourceOfTruth contains unknown properties: connectionString
  `));

  // Dot-notation keys that dot into nothing — detected by simulating the rendering pipeline
  // (apply all production defaults, then normalize with onDotIntoNonObject: "ignore")

  // Dot-notation into non-existent record entry in actual schemas (trustedDomains)
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'domains.trustedDomains.my-domain.baseUrl': 'https://example.com',
  })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] Dot-notation key "domains.trustedDomains.my-domain.baseUrl" will be silently ignored because it references non-existent parent "domains.trustedDomains.my-domain". Instead of dot notation, use nested object notation like this: { "domains.trustedDomains.my-domain": { "baseUrl": ... } }",
      "status": "error",
    }
  `);

  // Nested object notation should work fine (no warning)
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'domains.trustedDomains.my-domain': {
      baseUrl: 'https://example.com',
      handlerPath: '/handler',
    },
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Dot notation for static object fields should NOT warn
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'teams.allowClientTeamCreation': true,
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'auth.password.allowSignIn': true,
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'domains.allowLocalhost': true,
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Dot notation into an oauth provider that doesn't exist should warn
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'auth.oauth.providers.google.clientId': 'test-id',
  })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] Dot-notation key "auth.oauth.providers.google.clientId" will be silently ignored because it references non-existent parent "auth.oauth.providers.google". Instead of dot notation, use nested object notation like this: { "auth.oauth.providers.google": { "clientId": ... } }",
      "status": "error",
    }
  `);

  // Dot notation into an oauth provider that exists in the base should NOT warn
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {
    auth: { oauth: { providers: { google: { type: 'google', allowSignIn: true } } } },
  }, {
    'auth.oauth.providers.google.clientId': 'test-id',
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // --- More dot-notation warning tests ---

  // Multiple dropped keys should all be reported
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'domains.trustedDomains.d1.baseUrl': 'https://a.com',
    'auth.oauth.providers.github.clientId': 'id',
  })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] Dot-notation key "domains.trustedDomains.d1.baseUrl" will be silently ignored because it references non-existent parent "domains.trustedDomains.d1". Instead of dot notation, use nested object notation like this: { "domains.trustedDomains.d1": { "baseUrl": ... } }
    Dot-notation key "auth.oauth.providers.github.clientId" will be silently ignored because it references non-existent parent "auth.oauth.providers.github". Instead of dot notation, use nested object notation like this: { "auth.oauth.providers.github": { "clientId": ... } }",
      "status": "error",
    }
  `);

  // Setting an entire record entry directly via dot notation (no dotting INTO it) should NOT warn
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'domains.trustedDomains.my-domain': { baseUrl: 'https://example.com', handlerPath: '/handler' },
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Setting the entire record via nested object notation should NOT warn
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    domains: { trustedDomains: { 'my-domain': { baseUrl: 'https://example.com', handlerPath: '/handler' } } },
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Dot notation into a permission that doesn't exist (branch-level record)
  expect(await validateConfigOverrideSchema(branchConfigSchema, {}, {
    'rbac.permissions.my_perm.description': 'hello',
  })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] Dot-notation key "rbac.permissions.my_perm.description" will be silently ignored because it references non-existent parent "rbac.permissions.my_perm". Instead of dot notation, use nested object notation like this: { "rbac.permissions.my_perm": { "description": ... } }",
      "status": "error",
    }
  `);

  // Setting a permission entry directly should NOT warn
  expect(await validateConfigOverrideSchema(branchConfigSchema, {}, {
    'rbac.permissions.my_perm': { description: 'hello', scope: 'team' },
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Dot notation into a permission that exists in the base should NOT warn
  expect(await validateConfigOverrideSchema(branchConfigSchema, {
    rbac: { permissions: { my_perm: { description: 'old' } } },
  }, {
    'rbac.permissions.my_perm.description': 'new',
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Dot notation into sign-up rules record
  expect(await validateConfigOverrideSchema(branchConfigSchema, {}, {
    'auth.signUpRules.my_rule.enabled': true,
  })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] Dot-notation key "auth.signUpRules.my_rule.enabled" will be silently ignored because it references non-existent parent "auth.signUpRules.my_rule". Instead of dot notation, use nested object notation like this: { "auth.signUpRules.my_rule": { "enabled": ... } }",
      "status": "error",
    }
  `);

  // Setting sign-up rule entry directly should NOT warn
  expect(await validateConfigOverrideSchema(branchConfigSchema, {}, {
    'auth.signUpRules.my_rule': { enabled: true, displayName: 'My Rule', priority: 1, condition: 'true', action: { type: 'allow' } },
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Dot notation into email themes record
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'emails.themes.my_theme.displayName': 'My Theme',
  })).toMatchInlineSnapshot(`
    {
      "error": "[ERROR] The key "emails.themes.my_theme.displayName" is not valid (nested object not found in schema: "emails.themes.my_theme").",
      "status": "error",
    }
  `);

  // Deeply nested dot notation into payments products record
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'payments.products.my_product.displayName': 'My Product',
  })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] Dot-notation key "payments.products.my_product.displayName" will be silently ignored because it references non-existent parent "payments.products.my_product". Instead of dot notation, use nested object notation like this: { "payments.products.my_product": { "displayName": ... } }",
      "status": "error",
    }
  `);

  // Mix of valid dot notation and invalid dot notation in the same override
  // The valid one (static object field) should not prevent the invalid one from being flagged
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'teams.allowClientTeamCreation': true,
    'domains.trustedDomains.d1.baseUrl': 'https://example.com',
  })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] Dot-notation key "domains.trustedDomains.d1.baseUrl" will be silently ignored because it references non-existent parent "domains.trustedDomains.d1". Instead of dot notation, use nested object notation like this: { "domains.trustedDomains.d1": { "baseUrl": ... } }",
      "status": "error",
    }
  `);

  // Non-dot-notation keys should never trigger the warning
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    domains: { allowLocalhost: true },
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Dot notation with an entry that exists in the SAME override (as a flat key) should NOT warn
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'domains.trustedDomains.my-domain': { baseUrl: 'https://example.com', handlerPath: '/handler' },
    'domains.trustedDomains.my-domain.handlerPath': '/new-handler',
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Dot notation with entry created via nested object in same override should NOT warn
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    domains: { trustedDomains: { 'my-domain': { baseUrl: 'https://example.com', handlerPath: '/handler' } } },
    'domains.trustedDomains.my-domain.handlerPath': '/new-handler',
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Multiple dot-notation keys into the SAME non-existent record entry
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'domains.trustedDomains.d1.baseUrl': 'https://example.com',
    'domains.trustedDomains.d1.handlerPath': '/handler',
  })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] Dot-notation key "domains.trustedDomains.d1.baseUrl" will be silently ignored because it references non-existent parent "domains.trustedDomains.d1". Instead of dot notation, use nested object notation like this: { "domains.trustedDomains.d1": { "baseUrl": ... } }
    Dot-notation key "domains.trustedDomains.d1.handlerPath" will be silently ignored because it references non-existent parent "domains.trustedDomains.d1". Instead of dot notation, use nested object notation like this: { "domains.trustedDomains.d1": { "handlerPath": ... } }",
      "status": "error",
    }
  `);

  // Dot notation into nested records (products -> prices)
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {
    payments: { products: { 'my-product': { displayName: 'My Product', customerType: 'user' } } },
  }, {
    'payments.products.my-product.prices.monthly.USD': '10.00',
  })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] Dot-notation key "payments.products.my-product.prices.monthly.USD" will be silently ignored because it references non-existent parent "payments.products.my-product.prices.monthly". Instead of dot notation, use nested object notation like this: { "payments.products.my-product.prices.monthly": { "USD": ... } }",
      "status": "error",
    }
  `);

  // Dot notation into external databases record
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'dbSync.externalDatabases.my_db.type': 'postgres',
  })).toMatchInlineSnapshot(`
    {
      "error": "[WARNING] Dot-notation key "dbSync.externalDatabases.my_db.type" will be silently ignored because it references non-existent parent "dbSync.externalDatabases.my_db". Instead of dot notation, use nested object notation like this: { "dbSync.externalDatabases.my_db": { "type": ... } }",
      "status": "error",
    }
  `);

  // Dot notation for deeply nested static fields should NOT warn
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'auth.oauth.accountMergeStrategy': 'link_method',
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'emails.server.isShared': true,
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {
    'rbac.defaultPermissions.teamCreator': { my_perm: true },
  })).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);

  // Empty override should never warn
  expect(await validateConfigOverrideSchema(environmentConfigSchema, {}, {})).toMatchInlineSnapshot(`
    {
      "data": null,
      "status": "ok",
    }
  `);
});

import.meta.vitest?.test('setEnvironmentConfigOverride blocks writes for development environment projects', async ({ expect }) => {
  const vi = import.meta.vitest?.vi;
  if (!vi) {
    throw new HexclaveAssertionError("Vitest context is required for in-source tests.");
  }

  const developmentEnvironment = await import("../development-environment");

  // Spy on getEnvironmentConfigWriteBlockReason directly, because spying on
  // isDevelopmentEnvironmentProject does not intercept intra-module calls
  // (the function is called directly within the same module, not through
  // the module namespace export).
  const spy = vi.spyOn(developmentEnvironment, "getEnvironmentConfigWriteBlockReason")
    .mockResolvedValue(DEVELOPMENT_ENVIRONMENT_ENV_CONFIG_BLOCKED_MESSAGE);

  try {
    await expect(setEnvironmentConfigOverride({
      projectId: "project-id",
      branchId: "main",
      environmentConfigOverride: {},
    })).rejects.toThrow(DEVELOPMENT_ENVIRONMENT_ENV_CONFIG_BLOCKED_MESSAGE);
  } finally {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------------------------------------------------

// C -> A
export const renderedOrganizationConfigToProjectCrud = (renderedConfig: CompleteConfig): ProjectsCrud["Admin"]["Read"]['config'] => {
  const oauthProviders = typedEntries(renderedConfig.auth.oauth.providers)
    .map(([oauthProviderId, oauthProvider]) => {
      if (!oauthProvider.type) {
        return undefined;
      }
      // Custom OIDC providers are managed via config, not the legacy CRUD API
      if (oauthProvider.type === "custom_oidc") {
        return undefined;
      }
      if (!oauthProvider.allowSignIn) {
        return undefined;
      }
      return filterUndefined({
        provider_config_id: oauthProviderId,
        id: oauthProvider.type,
        type: oauthProvider.isShared ? 'shared' : 'standard',
        client_id: oauthProvider.clientId,
        client_secret: oauthProvider.clientSecret,
        facebook_config_id: oauthProvider.facebookConfigId,
        microsoft_tenant_id: oauthProvider.microsoftTenantId,
        apple_team_id: oauthProvider.appleTeamId,
        apple_key_id: oauthProvider.appleKeyId,
        apple_private_key: oauthProvider.applePrivateKey,
        apple_bundle_ids: oauthProvider.appleBundles ? Object.values(oauthProvider.appleBundles).filter(isTruthy).map(b => b.bundleId).filter(isTruthy) : undefined,
      } as const) satisfies ProjectsCrud["Admin"]["Read"]['config']['oauth_providers'][number];
    })
    .filter(isTruthy)
    .sort((a, b) => stringCompare(a.id, b.id));

  const teamPermissionDefinitions = listPermissionDefinitionsFromConfig({
    config: renderedConfig,
    scope: "team",
  });
  const projectPermissionDefinitions = listPermissionDefinitionsFromConfig({
    config: renderedConfig,
    scope: "project",
  });

  return {
    allow_localhost: renderedConfig.domains.allowLocalhost,
    client_team_creation_enabled: renderedConfig.teams.allowClientTeamCreation,
    client_user_deletion_enabled: renderedConfig.users.allowClientUserDeletion,
    sign_up_enabled: renderedConfig.auth.allowSignUp,
    oauth_account_merge_strategy: renderedConfig.auth.oauth.accountMergeStrategy,
    create_team_on_sign_up: renderedConfig.teams.createPersonalTeamOnSignUp,
    credential_enabled: renderedConfig.auth.password.allowSignIn,
    magic_link_enabled: renderedConfig.auth.otp.allowSignIn,
    passkey_enabled: renderedConfig.auth.passkey.allowSignIn,

    oauth_providers: oauthProviders,
    enabled_oauth_providers: oauthProviders,

    domains: typedEntries(renderedConfig.domains.trustedDomains)
      .map(([_, domainConfig]) => domainConfig.baseUrl === undefined ? undefined : ({
        domain: domainConfig.baseUrl,
        handler_path: domainConfig.handlerPath,
      }))
      .filter(isTruthy)
      .sort((a, b) => stringCompare(a.domain, b.domain)),

    email_config: renderedConfig.emails.server.isShared ? {
      type: 'shared',
    } : renderedConfig.emails.server.provider === "managed" ? {
      type: 'standard',
      host: "smtp.resend.com",
      port: 465,
      username: "resend",
      password: renderedConfig.emails.server.password,
      sender_name: renderedConfig.emails.server.senderName,
      sender_email: renderedConfig.emails.server.managedSubdomain && renderedConfig.emails.server.managedSenderLocalPart
        ? `${renderedConfig.emails.server.managedSenderLocalPart}@${renderedConfig.emails.server.managedSubdomain}`
        : renderedConfig.emails.server.senderEmail,
    } : {
      type: 'standard',
      host: renderedConfig.emails.server.host,
      port: renderedConfig.emails.server.port,
      username: renderedConfig.emails.server.username,
      password: renderedConfig.emails.server.password,
      sender_name: renderedConfig.emails.server.senderName,
      sender_email: renderedConfig.emails.server.senderEmail,
    },
    email_theme: renderedConfig.emails.selectedThemeId,

    team_creator_default_permissions: typedEntries(renderedConfig.rbac.defaultPermissions.teamCreator)
      .filter(([id, perm]) => perm && teamPermissionDefinitions.some((p) => p.id === id))
      .map(([id, perm]) => ({ id }))
      .sort((a, b) => stringCompare(a.id, b.id)),
    team_member_default_permissions: typedEntries(renderedConfig.rbac.defaultPermissions.teamMember)
      .filter(([id, perm]) => perm && teamPermissionDefinitions.some((p) => p.id === id))
      .map(([id, perm]) => ({ id }))
      .sort((a, b) => stringCompare(a.id, b.id)),
    user_default_permissions: typedEntries(renderedConfig.rbac.defaultPermissions.signUp)
      .filter(([id, perm]) => perm && projectPermissionDefinitions.some((p) => p.id === id))
      .map(([id, perm]) => ({ id }))
      .sort((a, b) => stringCompare(a.id, b.id)),

    allow_user_api_keys: renderedConfig.apiKeys.enabled.user,
    allow_team_api_keys: renderedConfig.apiKeys.enabled.team,
  };
};
