"use client";

import { DesignBadge, DesignCard } from "@/components/design-components";
import { Link } from "@/components/link";
import { cn } from "@/components/ui";
import { formatGrowthRelativeTime } from "@/lib/growth/growth-format";
import { getGrowthAdminTimelineStepStates, growthAdminInterviewIsAwaitingApproval, growthAdminReportIsAwaitingRelease, type GrowthAdminEditGate } from "@/lib/growth/growth-admin-lifecycle";
import type { GrowthPhase } from "@/lib/growth/growth-status";
import type { GrowthTimelineStepId, GrowthTimelineStepState } from "@/lib/growth/growth-timeline";
import type { GrowthStatus } from "@/lib/growth/growth-types";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { ArrowRightIcon, CheckCircleIcon, CircleIcon, CircleNotchIcon, HourglassMediumIcon, PulseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { GROWTH_ADMIN_LIFECYCLE_STEPS } from "./lifecycle-routes";

/**
 * Where the selected customer is in their Growth lifecycle, at the top of the admin workspace.
 *
 * The point is to answer "is there anything here worth editing yet?" before staff start editing:
 * the workspace below renders the customer's findings, notes and actions, all of which only exist
 * once deep research has run and the interview has been answered. Step states come from
 * `getGrowthTimelineStepStates` — the same derivation the customer's own timeline uses — so the two
 * surfaces can never disagree about which phase a project is in. Presentation differs on purpose:
 * this is one dense row for a pro user, not the customer's expanded, navigable timeline. It is also
 * deliberately read-only; the customer timeline's controls (onboarding form, restart, retry) act on
 * the app the page is mounted in, which here is the internal project, not the customer's.
 */

const PHASE_LABELS = new Map<GrowthPhase, string>([
  ["not-onboarded", "Not onboarded"],
  ["analyzing", "Deep research running"],
  ["analysis-failed", "Deep research failed"],
  ["interview", "Waiting on interview"],
  ["report-ready", "Report ready"],
  ["steady-state", "Onboarding complete"],
]);

const PHASE_COLORS = new Map<GrowthPhase, "orange" | "cyan" | "red" | "green">([
  ["not-onboarded", "orange"],
  ["analyzing", "cyan"],
  ["analysis-failed", "red"],
  ["interview", "orange"],
  ["report-ready", "green"],
  ["steady-state", "green"],
]);

/** Named from staff's point of view: what the interview's wire state means for whoever is looking at it. */
const INTERVIEW_LABELS = new Map<GrowthStatus["interview"]["state"], string>([
  ["not_ready", "not generated yet"],
  ["preparing", "held for staff review"],
  ["ready", "released, not started"],
  ["in_progress", "in progress"],
  ["completed", "completed"],
]);

function StepLink(props: { projectId: string, stepId: GrowthTimelineStepId, label: string, state: GrowthTimelineStepState, waitingLabel?: string }) {
  const stateIcon = new Map<GrowthTimelineStepState, React.ReactNode>([
    ["done", <CheckCircleIcon key="done" weight="fill" className="size-3.5 text-emerald-600 dark:text-emerald-400" />],
    ["current", <CircleNotchIcon key="current" className="size-3.5 animate-spin text-cyan-600 dark:text-cyan-400" />],
    ["failed", <WarningCircleIcon key="failed" weight="fill" className="size-3.5 text-destructive" />],
    ["upcoming", <CircleIcon key="upcoming" className="size-3.5 text-muted-foreground/40" />],
  ]).get(props.state);
  const icon = props.waitingLabel != null
    ? <HourglassMediumIcon className="size-3.5 text-orange-600 dark:text-orange-400" />
    : stateIcon;
  return (
    <Link
      href={urlString`/projects/internal/gtm/admin/${props.stepId}?targetProjectId=${props.projectId}`}
      className={cn(
        "group/step flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-sm no-underline transition-colors duration-150 hover:bg-foreground/[0.04] hover:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        props.state === "current" && "bg-foreground/[0.04] font-medium",
        props.state === "upcoming" && "text-muted-foreground/60",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">{props.label}</span>
      {props.waitingLabel != null && <DesignBadge label={props.waitingLabel} color="orange" size="sm" />}
      <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover/step:translate-x-0.5 group-hover/step:transition-none" />
    </Link>
  );
}

/** The one or two facts that explain the phase, so staff don't have to open the ops cards to learn them. */
function detailLines(status: GrowthStatus, nowMillis: number, waitingForAdminRelease: boolean): string[] {
  const lines: string[] = [];
  if (status.onboarding.completed && status.onboarding.completedAtMillis != null) {
    lines.push(`Onboarded ${formatGrowthRelativeTime(status.onboarding.completedAtMillis, nowMillis)}`);
  }
  if (status.analysis.state === "failed" && status.analysis.errorMessage != null) {
    lines.push(`Deep research error: ${status.analysis.errorMessage}`);
  }
  if (status.interview.state !== "completed") {
    const label = INTERVIEW_LABELS.get(status.interview.state) ?? throwErr(`INTERVIEW_LABELS is missing an entry for interview state ${status.interview.state}`);
    lines.push(`Interview ${label} — ${status.interview.answeredCount}/${status.interview.estimatedTotal} answered`);
  }
  lines.push(waitingForAdminRelease
    ? "Report waiting for admin release"
    : status.latestReport == null ? "No report published yet" : `Report published ${formatGrowthRelativeTime(status.latestReport.createdAtMillis, nowMillis)}`);
  return lines;
}

export function GrowthAdminLifecycleCard(props: { projectId: string, status: GrowthStatus, gate: GrowthAdminEditGate, nowMillis: number, hasUnpublishedReport: boolean }) {
  const steps = getGrowthAdminTimelineStepStates(props.status);
  const waitingForInterviewApproval = growthAdminInterviewIsAwaitingApproval(props.status);
  const waitingForAdminRelease = growthAdminReportIsAwaitingRelease(props.status, props.hasUnpublishedReport);
  return (
    <DesignCard title="Onboarding progress" icon={PulseIcon}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <DesignBadge
            label={PHASE_LABELS.get(props.gate.phase) ?? throwErr(`PHASE_LABELS is missing an entry for growth phase ${props.gate.phase}`)}
            color={PHASE_COLORS.get(props.gate.phase) ?? throwErr(`PHASE_COLORS is missing an entry for growth phase ${props.gate.phase}`)}
            size="sm"
          />
        </div>
        <div className="flex max-w-md flex-col gap-1">
          {GROWTH_ADMIN_LIFECYCLE_STEPS.map((step) => {
            const state = steps.get(step.id) ?? throwErr(`getGrowthAdminTimelineStepStates returned no state for step ${step.id}`);
            const waitingLabel = step.id === "interview" && waitingForInterviewApproval
              ? "Waiting for admin approval"
              : step.id === "report" && waitingForAdminRelease ? "Waiting for admin release" : undefined;
            return <StepLink key={step.id} projectId={props.projectId} stepId={step.id} label={step.label} state={state} waitingLabel={waitingLabel} />;
          })}
        </div>
        <div className="space-y-1.5">
          <h3 className="text-xs font-semibold text-foreground">Logs</h3>
          <div className="space-y-0.5">
            {detailLines(props.status, props.nowMillis, waitingForAdminRelease).map((line) => (
              <p key={line} className="text-xs text-muted-foreground">{line}</p>
            ))}
          </div>
        </div>
      </div>
    </DesignCard>
  );
}
