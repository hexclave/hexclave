"use client";

import { DesignAlert, DesignButton, DesignCard } from "@/components/design-components";
import { SimpleTooltip } from "@/components/ui";
import { runGrowthAdminStage, type GrowthAdminStageRunResult, type GrowthAdminStageRunState } from "@/lib/growth/growth-api";
import type { GrowthTimelineStepId } from "@/lib/growth/growth-timeline";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { PlayIcon } from "@phosphor-icons/react";
import { useState } from "react";

type RunState = { status: "idle" } | { status: "running" } | { status: "success", result: GrowthAdminStageRunResult } | { status: "error", message: string };

const STATE_LABELS = new Map<GrowthAdminStageRunState["state"], string>([
  ["ready", "Ready"],
  ["running", "Running"],
  ["complete", "Complete"],
  ["blocked", "Prerequisite required"],
  ["failed", "Failed"],
]);

export function GrowthAdminRunNowCard(props: {
  app: object,
  projectId: string,
  stage: GrowthTimelineStepId,
  operation: GrowthAdminStageRunState,
  onCompleted: () => Promise<void>,
}) {
  const [state, setState] = useState<RunState>({ status: "idle" });

  const runStage = () => {
    setState({ status: "running" });
    runAsynchronouslyWithAlert(async () => {
      const result = await runGrowthAdminStage(props.app, props.projectId, props.stage);
      await props.onCompleted();
      setState({ status: "success", result });
    }, {
      onError: error => setState({ status: "error", message: error instanceof Error ? error.message : String(error) }),
    });
  };

  return (
    <DesignCard title="Manual run" icon={PlayIcon}>
      <div className="space-y-3">
        {state.status === "error" && <DesignAlert variant="error">{state.message}</DesignAlert>}
        {state.status === "success" && (
          state.result.legStarted === false
            ? <DesignAlert variant="warning">Work was queued, but this step did not start before the request timed out. Run it again to continue recovery.</DesignAlert>
            : <DesignAlert variant="info">{state.result.message}</DesignAlert>
        )}
        {props.operation.state === "blocked" && <DesignAlert variant="warning">{props.operation.message}</DesignAlert>}
        {props.operation.state === "failed" && <DesignAlert variant="error">{props.operation.message}</DesignAlert>}
        {props.operation.state !== "blocked" && props.operation.state !== "failed" && (
          <p className="max-w-2xl text-sm text-muted-foreground">{props.operation.message}</p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <SimpleTooltip tooltip={props.operation.canRun ? null : props.operation.message}>
            <DesignButton disabled={!props.operation.canRun} size="sm" loading={state.status === "running"} onClick={runStage}>
              {props.operation.state === "failed" ? "Retry this step now" : "Run this step now"}
            </DesignButton>
          </SimpleTooltip>
          <span className="text-xs text-muted-foreground">
            {STATE_LABELS.get(props.operation.state) ?? throwErr(`Missing manual Growth stage state label for ${props.operation.state}`)}
          </span>
        </div>
      </div>
    </DesignCard>
  );
}
