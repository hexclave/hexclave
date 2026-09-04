import type { ExperimentRun } from "@/generated/prisma/client";
import type { SmartRequestAuth } from "@/route-handlers/smart-request";
import { KnownErrors } from "@hexclave/shared";
import { yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import type { Tenancy } from "@/lib/tenancies";
import type { ExperimentActor } from "./experiment-runs";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { isJsonSerializable } from "@hexclave/shared/dist/utils/json";

/**
 * Shared wire-format helpers for the internal experiment-run routes. Kept in
 * one place so the six lifecycle routes stay thin and can't drift apart in how
 * they serialize runs or resolve actors.
 */

// Experiments read and write analytics data (exposures, conversion events), so
// every experiment action requires the analytics app.
export function ensureAnalyticsInstalledForExperiments(tenancy: Tenancy): void {
  if (tenancy.config.apps.installed["feature-flags"]?.enabled !== true) {
    throw new StatusError(StatusError.BadRequest, "Feature flags are not enabled for this project");
  }
  if (!tenancy.config.apps.installed["analytics"]?.enabled) {
    throw new KnownErrors.AnalyticsNotEnabled();
  }
}

export function experimentActorFromAuth(auth: Pick<SmartRequestAuth, "user">): ExperimentActor {
  return auth.user != null ? { type: "user", userId: auth.user.id } : { type: "admin_key" };
}

export const experimentRunResponseSchema = yupObject({
  id: yupString().defined(),
  experiment_id: yupString().defined(),
  revision_number: yupNumber().defined(),
  config_revision_hash: yupString().defined(),
  config_snapshot: yupMixed().defined(),
  state: yupString().oneOf(["draft", "running", "paused", "completed"]).defined(),
  scheduled_start_at_millis: yupNumber().nullable().defined(),
  scheduled_end_at_millis: yupNumber().nullable().defined(),
  started_at_millis: yupNumber().nullable().defined(),
  paused_at_millis: yupNumber().nullable().defined(),
  completed_at_millis: yupNumber().nullable().defined(),
  created_by_user_id: yupString().nullable().defined(),
  created_at_millis: yupNumber().defined(),
}).defined();

const RUN_STATE_TO_API = {
  DRAFT: "draft",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
} as const;

export function experimentRunToApiFormat(run: ExperimentRun) {
  if (!isJsonSerializable(run.configSnapshot)) {
    throw new HexclaveAssertionError(`Experiment run ${run.id} contains a non-JSON config snapshot`);
  }
  return {
    id: run.id,
    experiment_id: run.experimentId,
    revision_number: run.revisionNumber,
    config_revision_hash: run.configRevisionHash,
    config_snapshot: run.configSnapshot,
    state: RUN_STATE_TO_API[run.state],
    scheduled_start_at_millis: run.scheduledStartAt?.getTime() ?? null,
    scheduled_end_at_millis: run.scheduledEndAt?.getTime() ?? null,
    started_at_millis: run.startedAt?.getTime() ?? null,
    paused_at_millis: run.pausedAt?.getTime() ?? null,
    completed_at_millis: run.completedAt?.getTime() ?? null,
    created_by_user_id: run.createdByUserId,
    created_at_millis: run.createdAt.getTime(),
  };
}
