import type { ExperimentRun, Prisma } from "@/generated/prisma/client";
import { getSoleTenancyFromProjectBranch, type Tenancy } from "@/lib/tenancies";
import { globalPrismaClient, isPrismaError, retryTransaction } from "@/prisma-client";
import { HexclaveAssertionError, StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import type { FeatureFlagMetric } from "@hexclave/shared/dist/feature-flags/types";
import { type ExperimentConfig, type ExperimentMetricDefinition, computeExperimentConfigRevisionHash, validateExperimentConfig } from "./experiment-config";
import { parseFeatureFlagsConfig } from "@hexclave/shared/dist/feature-flags/schema";
import { isDeepStrictEqual } from "node:util";

/**
 * Lifecycle management for experiment runs.
 *
 * State machine: DRAFT -> RUNNING <-> PAUSED -> COMPLETED (COMPLETED also
 * reachable directly from RUNNING; COMPLETED is terminal). Every transition is
 * a compare-and-swap (`updateMany` filtered on the expected current state), so
 * two concurrent transition calls can never both succeed — the loser observes
 * `count: 0` and gets a 409. On top of that, the ExperimentRun_active_run_key
 * partial unique index guarantees at most one RUNNING/PAUSED run per
 * project+branch+experiment, while ExperimentRun_active_flag_key prevents two
 * different active experiments from targeting the same frozen flag id.
 *
 * Immutability: configSnapshot / configRevisionHash / revisionNumber are
 * written exactly once (at creation, or replaced while still in DRAFT at
 * start) and no code path updates them afterwards. "Editing" an active run
 * means completing it and creating a successor row with revisionNumber + 1
 * in a single transaction (createNewRevision).
 */

export type ExperimentActor =
  | { type: "user", userId: string }
  | { type: "admin_key" }
  | { type: "system" };

export function experimentRunNotFoundError(): StatusError {
  return new StatusError(StatusError.NotFound, "Experiment run not found");
}

function invalidTransitionError(action: string): StatusError {
  // 409 rather than 400: the request was well-formed, the run just isn't in a
  // state that allows this transition (possibly because a concurrent request
  // won the race).
  return new StatusError(StatusError.Conflict, `Experiment run cannot be ${action} in its current state`);
}

// The one-active-run constraint is a raw partial unique index (not in the
// Prisma schema), so we can only match on the P2002 code, not on
// isPrismaUniqueConstraintViolation's model/target metadata.
function isUniqueConstraintViolation(error: unknown, seen: Set<unknown> = new Set()): boolean {
  if (seen.has(error)) return false;
  seen.add(error);
  if (isPrismaError(error, "UNIQUE_CONSTRAINT_VIOLATION")) return true;
  if (error instanceof AggregateError) {
    const nestedErrors: unknown[] = error.errors;
    if (nestedErrors.some((nestedError) => isUniqueConstraintViolation(nestedError, seen))) return true;
  }
  return error instanceof Error && error.cause !== undefined
    && isUniqueConstraintViolation(error.cause, seen);
}

function invalidBranchExperiment(message: string): StatusError {
  return new StatusError(StatusError.BadRequest, `Experiment definition is invalid in the current branch config: ${message}`);
}

function requireBranchValue<T>(value: T | undefined, path: string): T {
  if (value === undefined) throw invalidBranchExperiment(`${path} is required`);
  return value;
}

function orderedFunnelSteps(metric: FeatureFlagMetric, path: string): string[] {
  const entries = Object.entries(requireBranchValue(metric.funnelSteps, `${path}.funnelSteps`)).map(([stepId, eventName]) => {
    const match = /^step_([1-9]\d*)$/.exec(stepId);
    if (match === null) throw invalidBranchExperiment(`${path}.funnelSteps key ${JSON.stringify(stepId)} must use step_1, step_2, ... notation`);
    const position = Number(match[1]);
    if (!Number.isSafeInteger(position)) throw invalidBranchExperiment(`${path}.funnelSteps key ${JSON.stringify(stepId)} is too large`);
    return { position, eventName: requireBranchValue(eventName, `${path}.funnelSteps.${stepId}`) };
  }).sort((left, right) => left.position - right.position);
  for (const [index, entry] of entries.entries()) {
    if (entry.position !== index + 1) {
      throw invalidBranchExperiment(`${path}.funnelSteps must be consecutively numbered from step_1`);
    }
  }
  return entries.map((entry) => entry.eventName);
}

function deriveMetric(metric: FeatureFlagMetric | undefined, path: string): {
  definition: ExperimentMetricDefinition,
  attributionWindowSeconds: number,
} {
  const existingMetric = requireBranchValue(metric, path);
  const id = requireBranchValue(existingMetric.id, `${path}.id`);
  const direction = requireBranchValue(existingMetric.direction, `${path}.direction`);
  const attributionWindowSeconds = requireBranchValue(existingMetric.attributionWindowSeconds, `${path}.attributionWindowSeconds`);
  const type = requireBranchValue(existingMetric.type, `${path}.type`);
  let definition: ExperimentMetricDefinition | undefined;
  switch (type) {
    case "page_view": {
      if (existingMetric.eventName !== "$page-view") {
        throw invalidBranchExperiment(`${path}.eventName must be $page-view`);
      }
      const pattern = requireBranchValue(existingMetric.urlPattern, `${path}.urlPattern`).trim();
      if (pattern === "*") {
        definition = { id, kind: "binary", event_name: "$page-view", direction };
        break;
      }
      const startsWithWildcard = pattern.startsWith("*");
      const endsWithWildcard = pattern.endsWith("*");
      const value = pattern.slice(startsWithWildcard ? 1 : 0, endsWithWildcard ? -1 : undefined);
      if (value.length === 0) throw invalidBranchExperiment(`${path}.urlPattern must contain a path value`);
      definition = {
        id,
        kind: "binary",
        event_name: "$page-view",
        direction,
        event_filter: {
          field: "path",
          operator: startsWithWildcard && endsWithWildcard ? "contains" : startsWithWildcard ? "ends_with" : endsWithWildcard ? "starts_with" : "eq",
          value,
        },
      };
      break;
    }
    case "click": {
      if (existingMetric.eventName !== "$click") {
        throw invalidBranchExperiment(`${path}.eventName must be $click`);
      }
      const selector = requireBranchValue(existingMetric.selector, `${path}.selector`).trim();
      if (selector.length === 0) throw invalidBranchExperiment(`${path}.selector must not be empty`);
      definition = { id, kind: "binary", event_name: "$click", direction, event_filter: { field: "selector", operator: "eq", value: selector } };
      break;
    }
    case "funnel": {
      definition = { id, kind: "funnel", steps: orderedFunnelSteps(existingMetric, path), direction };
      break;
    }
    case "custom_event": {
      definition = { id, kind: "binary", event_name: requireBranchValue(existingMetric.eventName, `${path}.eventName`), direction };
      break;
    }
    case "numeric_value": {
      definition = {
        id,
        kind: "numeric",
        event_name: requireBranchValue(existingMetric.eventName, `${path}.eventName`),
        direction,
        property_name: requireBranchValue(existingMetric.numericProperty, `${path}.numericProperty`),
        aggregation: requireBranchValue(existingMetric.numericAggregation, `${path}.numericAggregation`),
      };
      break;
    }
  }
  return { definition, attributionWindowSeconds };
}

async function deriveExperimentConfig(options: { tenancy: Tenancy, experimentId: string }): Promise<ExperimentConfig> {
  const featureFlags = parseFeatureFlagsConfig(options.tenancy.config.featureFlags);
  const definition = featureFlags.experiments?.[options.experimentId];
  if (definition === undefined || definition.archived === true) {
    throw new StatusError(StatusError.BadRequest, "Experiment definition does not exist or is archived in the current branch config");
  }
  const flagId = requireBranchValue(definition.flagId, `featureFlags.experiments.${options.experimentId}.flagId`);
  const flag = featureFlags.flags?.[flagId];
  if (flag === undefined || flag.archived === true) {
    throw invalidBranchExperiment(`featureFlags.experiments.${options.experimentId}.flagId references a missing or archived flag`);
  }
  const variants = Object.fromEntries(Object.entries(requireBranchValue(
    definition.variantWeights,
    `featureFlags.experiments.${options.experimentId}.variantWeights`,
  )).map(([variantId, weightBasisPoints]) => {
    const variant = flag.variants?.[variantId];
    const flagValue = variant?.value;
    if (flagValue === undefined) {
      throw invalidBranchExperiment(`featureFlags.experiments.${options.experimentId}.variantWeights.${variantId} references a missing flag variant`);
    }
    return [variantId, {
      weight_basis_points: requireBranchValue(weightBasisPoints, `featureFlags.experiments.${options.experimentId}.variantWeights.${variantId}`),
      flag_value: flagValue,
    }];
  }));

  const primary = deriveMetric(definition.primaryMetric, `featureFlags.experiments.${options.experimentId}.primaryMetric`);
  const secondary = Object.entries(definition.secondaryMetrics ?? {}).map(([metricId, metric]) =>
    deriveMetric(metric, `featureFlags.experiments.${options.experimentId}.secondaryMetrics.${metricId}`));
  const guardrails = Object.entries(definition.guardrailMetrics ?? {}).map(([metricId, metric]) =>
    deriveMetric(metric, `featureFlags.experiments.${options.experimentId}.guardrailMetrics.${metricId}`));
  for (const metric of [...secondary, ...guardrails]) {
    if (metric.attributionWindowSeconds !== primary.attributionWindowSeconds) {
      throw invalidBranchExperiment("all experiment metrics must use the same attributionWindowSeconds");
    }
  }

  const startAtMillis = definition.startsAt === undefined ? undefined : new Date(definition.startsAt).getTime();
  const endAtMillis = definition.endsAt === undefined ? undefined : new Date(definition.endsAt).getTime();
  return await validateExperimentConfig({
    ...definition.displayName === undefined ? {} : { display_name: definition.displayName },
    ...definition.hypothesis === undefined ? {} : { hypothesis: definition.hypothesis },
    flag_id: flagId,
    assignment_unit: requireBranchValue(definition.assignmentUnit, `featureFlags.experiments.${options.experimentId}.assignmentUnit`),
    traffic_allocation_basis_points: requireBranchValue(definition.trafficAllocationBasisPoints, `featureFlags.experiments.${options.experimentId}.trafficAllocationBasisPoints`),
    control_variant_id: requireBranchValue(definition.controlVariantKey, `featureFlags.experiments.${options.experimentId}.controlVariantKey`),
    variants,
    primary_metric: primary.definition,
    secondary_metrics: secondary.map((metric) => metric.definition),
    guardrail_metrics: guardrails.map((metric) => metric.definition),
    attribution_window_seconds: primary.attributionWindowSeconds,
    ...definition.mutualExclusionGroupId === undefined ? {} : { mutual_exclusion_group_id: definition.mutualExclusionGroupId },
    ...startAtMillis === undefined && endAtMillis === undefined ? {} : {
      schedule: {
        ...startAtMillis === undefined ? {} : { start_at_millis: startAtMillis },
        ...endAtMillis === undefined ? {} : { end_at_millis: endAtMillis },
      },
    },
  });
}

async function currentExperimentConfig(options: {
  tenancy: Tenancy,
  experimentId: string,
  submittedConfig?: unknown,
}): Promise<ExperimentConfig> {
  const derived = await deriveExperimentConfig(options);
  if (options.submittedConfig !== undefined) {
    const submitted = await validateExperimentConfig(options.submittedConfig);
    if (!isDeepStrictEqual(submitted, derived)) {
      throw new StatusError(StatusError.BadRequest, "Submitted experiment configuration does not exactly match the current branch definition");
    }
  }
  return derived;
}

export async function listExperimentRuns(options: {
  tenancy: Tenancy,
  experimentId: string,
}): Promise<ExperimentRun[]> {
  return await globalPrismaClient.experimentRun.findMany({
    where: {
      projectId: options.tenancy.project.id,
      branchId: options.tenancy.branchId,
      experimentId: options.experimentId,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export async function getExperimentRun(options: {
  tenancy: Tenancy,
  experimentId: string,
  runId: string,
}): Promise<ExperimentRun> {
  const run = await globalPrismaClient.experimentRun.findUnique({ where: { id: options.runId } });
  // Tenancy scoping: a run id from another project/branch/experiment must be
  // indistinguishable from a nonexistent one.
  if (run == null || run.projectId !== options.tenancy.project.id || run.branchId !== options.tenancy.branchId || run.experimentId !== options.experimentId) {
    throw experimentRunNotFoundError();
  }
  return run;
}

export async function createExperimentRun(options: {
  tenancy: Tenancy,
  experimentId: string,
  config: unknown,
  actor: ExperimentActor,
}): Promise<ExperimentRun> {
  const config = await currentExperimentConfig({ ...options, submittedConfig: options.config });
  const configRevisionHash = computeExperimentConfigRevisionHash(config);
  const latestRun = await globalPrismaClient.experimentRun.findFirst({
    where: {
      projectId: options.tenancy.project.id,
      branchId: options.tenancy.branchId,
      experimentId: options.experimentId,
    },
    orderBy: { revisionNumber: "desc" },
    select: { revisionNumber: true },
  });
  return await globalPrismaClient.experimentRun.create({
    data: {
      id: generateUuid(),
      projectId: options.tenancy.project.id,
      branchId: options.tenancy.branchId,
      experimentId: options.experimentId,
      // Concurrent creates may produce duplicate revision numbers for DRAFT
      // runs; that's fine — revision numbers only become meaningful (and
      // strictly increasing) along the RUNNING chain created by
      // createNewRevision, which recomputes from the completed predecessor.
      revisionNumber: (latestRun?.revisionNumber ?? 0) + 1,
      configRevisionHash,
      // Prisma JSON columns accept the validated plain-JSON config; the type
      // system can't see through `unknown`-typed metric fields, so serialize
      // through JSON to guarantee a plain value.
      configSnapshot: JSON.parse(JSON.stringify(config)),
      state: "DRAFT",
      scheduledStartAt: config.schedule?.start_at_millis != null ? new Date(config.schedule.start_at_millis) : null,
      scheduledEndAt: config.schedule?.end_at_millis != null ? new Date(config.schedule.end_at_millis) : null,
      createdByUserId: options.actor.type === "user" ? options.actor.userId : null,
    },
  });
}

async function transitionExperimentRun(options: {
  tenancy: Tenancy,
  experimentId: string,
  runId: string,
  action: "started" | "paused" | "resumed" | "completed",
  fromStates: ("DRAFT" | "RUNNING" | "PAUSED")[],
  toState: "RUNNING" | "PAUSED" | "COMPLETED",
  extraData: Prisma.ExperimentRunUpdateManyMutationInput,
}): Promise<ExperimentRun> {
  // Tenancy check before the compare-and-swap so a foreign run id 404s instead
  // of being transitioned or 409ing.
  await getExperimentRun(options);
  try {
    return await retryTransaction(globalPrismaClient, async (tx) => {
      const updated = await tx.experimentRun.updateMany({
        where: { id: options.runId, state: { in: options.fromStates } },
        data: { state: options.toState, ...options.extraData },
      });
      if (updated.count === 0) throw invalidTransitionError(options.action);
      if (updated.count > 1) {
        throw new HexclaveAssertionError(`Transition matched ${updated.count} runs for id ${options.runId}; id is the primary key so this should be impossible`);
      }
      return await tx.experimentRun.findUnique({ where: { id: options.runId } })
        ?? throwErr(`Experiment run ${options.runId} disappeared right after a successful transition`);
    });
  } catch (error) {
    // Starting/resuming can violate either active-run partial unique index: one
    // is per experiment and the other is per frozen flag id.
    if (isUniqueConstraintViolation(error)) {
      throw new StatusError(StatusError.Conflict, "Another active run already targets this experiment or feature flag");
    }
    throw error;
  }
}

/**
 * Starts a DRAFT run. The branch definition is always re-read and frozen at
 * this moment. An optional submitted config is only an optimistic consistency
 * check; it can never override what is currently published on the branch.
 */
export async function startExperimentRun(options: {
  tenancy: Tenancy,
  experimentId: string,
  runId: string,
  actor: ExperimentActor,
  config?: unknown,
}): Promise<ExperimentRun> {
  const config = await currentExperimentConfig({ ...options, submittedConfig: options.config });
  const snapshotUpdate: Prisma.ExperimentRunUpdateManyMutationInput = {
    configRevisionHash: computeExperimentConfigRevisionHash(config),
    configSnapshot: JSON.parse(JSON.stringify(config)),
    scheduledEndAt: config.schedule?.end_at_millis != null ? new Date(config.schedule.end_at_millis) : null,
  };
  return await transitionExperimentRun({
    ...options,
    action: "started",
    fromStates: ["DRAFT"],
    toState: "RUNNING",
    extraData: { startedAt: new Date(), ...snapshotUpdate },
  });
}

export async function pauseExperimentRun(options: {
  tenancy: Tenancy,
  experimentId: string,
  runId: string,
  actor: ExperimentActor,
}): Promise<ExperimentRun> {
  return await transitionExperimentRun({
    ...options,
    action: "paused",
    fromStates: ["RUNNING"],
    toState: "PAUSED",
    extraData: { pausedAt: new Date() },
  });
}

export async function resumeExperimentRun(options: {
  tenancy: Tenancy,
  experimentId: string,
  runId: string,
  actor: ExperimentActor,
}): Promise<ExperimentRun> {
  return await transitionExperimentRun({
    ...options,
    action: "resumed",
    fromStates: ["PAUSED"],
    toState: "RUNNING",
    extraData: {},
  });
}

export async function completeExperimentRun(options: {
  tenancy: Tenancy,
  experimentId: string,
  runId: string,
  actor: ExperimentActor,
}): Promise<ExperimentRun> {
  return await transitionExperimentRun({
    ...options,
    action: "completed",
    fromStates: ["RUNNING", "PAUSED"],
    toState: "COMPLETED",
    extraData: { completedAt: new Date() },
  });
}

/**
 * "Edits" an active (RUNNING or PAUSED) run: completes it and creates an
 * immediately-RUNNING successor with the new config and revisionNumber + 1,
 * atomically. Exposures/results of the old revision stay attached to the old
 * run row; the new revision starts collecting from zero (subjects are
 * per-revision by design — a config change invalidates cross-revision
 * comparability).
 */
export async function createNewRevision(options: {
  tenancy: Tenancy,
  experimentId: string,
  runId: string,
  config: unknown,
  actor: ExperimentActor,
}): Promise<ExperimentRun> {
  const config = await currentExperimentConfig({ ...options, submittedConfig: options.config });
  const configRevisionHash = computeExperimentConfigRevisionHash(config);
  const before = await getExperimentRun(options);
  try {
    return await retryTransaction(globalPrismaClient, async (tx) => {
      const completed = await tx.experimentRun.updateMany({
        where: { id: options.runId, state: { in: ["RUNNING", "PAUSED"] } },
        data: { state: "COMPLETED", completedAt: new Date() },
      });
      if (completed.count === 0) {
        throw invalidTransitionError("revised");
      }
      const successor = await tx.experimentRun.create({
        data: {
          id: generateUuid(),
          projectId: options.tenancy.project.id,
          branchId: options.tenancy.branchId,
          experimentId: options.experimentId,
          revisionNumber: before.revisionNumber + 1,
          configRevisionHash,
          configSnapshot: JSON.parse(JSON.stringify(config)),
          state: "RUNNING",
          startedAt: new Date(),
          scheduledEndAt: config.schedule?.end_at_millis != null ? new Date(config.schedule.end_at_millis) : null,
          createdByUserId: options.actor.type === "user" ? options.actor.userId : null,
        },
      });
      return successor;
    });
  } catch (error) {
    // Two concurrent revisions of the same run: the loser's updateMany matches
    // 0 rows (already COMPLETED) and throws inside the tx, or its insert
    // violates the one-active-run index — both surface as 409.
    if (isUniqueConstraintViolation(error)) {
      throw new StatusError(StatusError.Conflict, "Another active run already targets this experiment or feature flag");
    }
    throw error;
  }
}

export type ScheduleProcessorResult = {
  started: number,
  completed: number,
};

async function moveSkippedScheduledRunBehindCurrentPage(run: Pick<ExperimentRun, "id" | "state">, now: Date): Promise<void> {
  // A blocked row must not remain at the head of every bounded scheduler page.
  // Touching updatedAt rotates it behind other due rows while preserving the
  // requested schedule and lets a later tick retry it after config/app fixes.
  await globalPrismaClient.experimentRun.updateMany({
    where: { id: run.id, state: run.state },
    data: { updatedAt: now },
  });
}

/**
 * Processes scheduled runs across all projects: starts DRAFT runs whose
 * scheduledStartAt has passed, and completes RUNNING/PAUSED runs whose
 * scheduledEndAt has passed. Idempotent and concurrency-safe by construction:
 * every mutation is a per-row CAS on the expected state, so overlapping
 * processor invocations (or a processor racing a manual transition) simply
 * no-op on rows the other side already handled, and a start that would violate
 * the one-active-run index skips that run until a later tick.
 */
export async function processScheduledExperimentRuns(options: {
  now: Date,
  batchLimit: number,
}): Promise<ScheduleProcessorResult> {
  let started = 0;
  let completed = 0;

  const dueStarts = await globalPrismaClient.experimentRun.findMany({
    where: { state: "DRAFT", scheduledStartAt: { not: null, lte: options.now } },
    orderBy: [{ updatedAt: "asc" }, { scheduledStartAt: "asc" }, { id: "asc" }],
    take: options.batchLimit,
  });
  for (const run of dueStarts) {
    const tenancy = await getSoleTenancyFromProjectBranch(run.projectId, run.branchId, true);
    if (tenancy === null) {
      await moveSkippedScheduledRunBehindCurrentPage(run, options.now);
      continue;
    }
    if (tenancy.config.apps.installed["feature-flags"]?.enabled !== true || tenancy.config.apps.installed.analytics?.enabled !== true) {
      // Keep the draft pending. If either app is re-enabled before the schedule
      // is otherwise changed, a later processor tick can start it safely.
      await moveSkippedScheduledRunBehindCurrentPage(run, options.now);
      continue;
    }
    let config: ExperimentConfig;
    try {
      config = await currentExperimentConfig({ tenancy, experimentId: run.experimentId });
    } catch (error) {
      if (error instanceof StatusError) {
        // Leave the run in DRAFT. A later config correction can make the same
        // scheduled run eligible without losing its snapshot history.
        await moveSkippedScheduledRunBehindCurrentPage(run, options.now);
        continue;
      }
      throw error;
    }
    const currentScheduledStartAt = config.schedule?.start_at_millis == null ? null : new Date(config.schedule.start_at_millis);
    const currentScheduledEndAt = config.schedule?.end_at_millis == null ? null : new Date(config.schedule.end_at_millis);
    if (currentScheduledStartAt === null || currentScheduledStartAt.getTime() > options.now.getTime()) {
      // Config is authoritative for drafts. Removing startsAt cancels automatic
      // start; postponing it moves the same immutable run draft to the new due
      // time instead of honoring a stale schedule captured at creation.
      await globalPrismaClient.experimentRun.updateMany({
        where: { id: run.id, state: "DRAFT" },
        data: {
          scheduledStartAt: currentScheduledStartAt,
          scheduledEndAt: currentScheduledEndAt,
          configRevisionHash: computeExperimentConfigRevisionHash(config),
          configSnapshot: JSON.parse(JSON.stringify(config)),
          updatedAt: options.now,
        },
      });
      continue;
    }
    try {
      const didStart = await retryTransaction(globalPrismaClient, async (tx) => {
        const updated = await tx.experimentRun.updateMany({
          where: { id: run.id, state: "DRAFT" },
          data: {
            state: "RUNNING",
            startedAt: options.now,
            configRevisionHash: computeExperimentConfigRevisionHash(config),
            configSnapshot: JSON.parse(JSON.stringify(config)),
            scheduledStartAt: currentScheduledStartAt,
            scheduledEndAt: currentScheduledEndAt,
          },
        });
        return updated.count === 1;
      });
      if (!didStart) continue;
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        // Another run of the experiment or flag is active; leave this one in
        // DRAFT so it starts on a later tick once that run finishes.
        await moveSkippedScheduledRunBehindCurrentPage(run, options.now);
        continue;
      }
      throw error;
    }
    started++;
  }

  const dueEnds = await globalPrismaClient.experimentRun.findMany({
    where: { state: { in: ["RUNNING", "PAUSED"] }, scheduledEndAt: { not: null, lte: options.now } },
    orderBy: [{ updatedAt: "asc" }, { scheduledEndAt: "asc" }, { id: "asc" }],
    take: options.batchLimit,
  });
  for (const run of dueEnds) {
    // Ending needs no branch config: the run's frozen snapshot already carries
    // everything, and a CAS on the active states makes overlapping ticks safe.
    const ended = await globalPrismaClient.experimentRun.updateMany({
      where: { id: run.id, state: { in: ["RUNNING", "PAUSED"] } },
      data: { state: "COMPLETED", completedAt: options.now },
    });
    if (ended.count === 0) continue;
    completed++;
  }

  return { started, completed };
}
