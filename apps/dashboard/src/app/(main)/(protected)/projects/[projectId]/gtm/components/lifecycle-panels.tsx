"use client";

import { DesignAlert, DesignBadge, DesignButton, DesignCard, DesignInput } from "@/components/design-components";
import { Link } from "@/components/link";
import { useRouter } from "@/components/router";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { ActionDialog } from "@/components/ui/action-dialog";
import { Textarea } from "@/components/ui/textarea";
import { TooltipPortal } from "@radix-ui/react-tooltip";
import { useGrowthStatus } from "@/lib/growth/growth-data";
import { completeGrowthOnboarding, resolveGrowthIntegrations, restartGrowthOnboarding, retryGrowthAnalysis } from "@/lib/growth/growth-api";
import { getGrowthComputeMetricsTickerFrame, GROWTH_COMPUTE_METRICS_TICK_MILLIS } from "@/lib/growth/growth-compute-metrics-ticker";
import { getGrowthTimelineStepStates, type GrowthTimelineStepState } from "@/lib/growth/growth-timeline";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import type { GrowthAnalysisStep, GrowthComputeMetrics, GrowthIntegrations, GrowthStatus } from "@/lib/growth/growth-types";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  CircleIcon,
  CircleNotchIcon,
  HourglassMediumIcon,
  PlugsConnectedIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { useAdminApp, useProjectId } from "../../use-admin-app";
import { useGrowthHref } from "./action-card";
import { GrowthStatusGate } from "./frame";
import { GROWTH_HOLD_BODY, GROWTH_HOLD_SHORT, GROWTH_INTERVIEW_PREPARING_DETAIL } from "./report-hold";
import { GrowthTimeline, GrowthTimelineStep } from "./timeline";

/**
 * The overview is a vertical lifecycle timeline and doubles as the app's main navigation: the current
 * step expands into its content (form, checklist, buttons into the deeper pages), done steps collapse
 * to one-line rows with quiet links, upcoming steps are muted previews. Which step is in which state
 * is derived in lib/growth/growth-timeline.ts so it can never disagree with getGrowthPhase.
 */
export function GrowthLifecycleOverview() {
  return (
    <GrowthStatusGate>
      {(status) => <GrowthLifecycleTimeline status={status} />}
    </GrowthStatusGate>
  );
}

/** Complete lifecycle timeline shared by the pre-activation overview and Growth settings. */
export function GrowthLifecycleTimeline(props: { status: GrowthStatus }) {
  const steps = getGrowthTimelineStepStates(props.status);
  const stepState = (id: Parameters<typeof steps.get>[0]): GrowthTimelineStepState => {
    const state = steps.get(id);
    if (state == null) throw new Error(`getGrowthTimelineStepStates unexpectedly returned no state for step ${id}`);
    return state;
  };
  return (
    <div className="flex flex-col gap-3">
      <GrowthPipelineHealthLine status={props.status} />
      <GrowthTimeline>
        <SetUpStep status={props.status} state={stepState("set-up")} />
        <ComputeMetricsStep status={props.status} state={stepState("compute-metrics")} />
        {/* <IntegrationsStep status={props.status} state={stepState("integrations")} /> */}
        <AnalysisStep status={props.status} state={stepState("analysis")} />
        <InterviewStep status={props.status} state={stepState("interview")} />
        <ReportStep status={props.status} state={stepState("report")} />
      </GrowthTimeline>
    </div>
  );
}

function GoToButton(props: { href: string, variant?: "default" | "outline", children: React.ReactNode }) {
  const router = useRouter();
  return (
    <DesignButton variant={props.variant} onClick={() => router.push(props.href)}>
      <span className="flex items-center gap-2">{props.children}<ArrowRightIcon className="size-4" /></span>
    </DesignButton>
  );
}

/** Quiet inline link for collapsed done rows — navigation without competing with the current step's buttons. */
function QuietLink(props: { href: string, children: React.ReactNode, newTab?: boolean }) {
  return (
    <Link
      href={props.href}
      target={props.newTab ? "_blank" : undefined}
      rel={props.newTab ? "noopener noreferrer" : undefined}
      className="text-sm font-medium text-foreground/70 underline underline-offset-2 transition-colors duration-150 hover:text-foreground hover:transition-none"
    >
      {props.children}
    </Link>
  );
}

function isValidWebsiteUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function OnboardingForm() {
  const app = useAdminApp();
  const { demo, refresh } = useGrowthStatus();
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [companySummary, setCompanySummary] = useState("");
  const [additionalNotes, setAdditionalNotes] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  return (
    <DesignCard>
      <div className="flex max-w-xl flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="growth-onboarding-website">Website URL</label>
          <DesignInput
            id="growth-onboarding-website"
            type="url"
            placeholder="https://your-product.com"
            value={websiteUrl}
            onChange={(event) => {
              setWebsiteUrl(event.target.value);
              setValidationError(null);
            }}
          />
          {validationError != null && <p className="text-sm text-destructive">{validationError}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="growth-onboarding-summary">What does your company do? <span className="font-normal text-muted-foreground">(optional)</span></label>
          <DesignInput
            id="growth-onboarding-summary"
            placeholder="One or two sentences about your product and who it's for"
            value={companySummary}
            onChange={(event) => setCompanySummary(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="growth-onboarding-additional-notes">Additional notes <span className="font-normal text-muted-foreground">(optional)</span></label>
          <Textarea
            id="growth-onboarding-additional-notes"
            maxLength={10_000}
            placeholder="Share goals, constraints, competitors, or anything else the analysis should consider"
            value={additionalNotes}
            onChange={(event) => setAdditionalNotes(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">These notes are provided to the AI as context for its analysis.</p>
        </div>
        {submitError != null && <DesignAlert variant="error">{submitError}</DesignAlert>}
        <div className="flex items-center gap-3">
          {/* In demo mode the underlying project (the internal project) doesn't actually have the
            * growth app enabled, so firing the real onboarding request would always fail — mutations
            * are disabled with a notice instead, matching the other growth pages' demo convention. */}
          <DesignButton
            disabled={demo}
            onClick={async () => {
              setSubmitError(null);
              if (!isValidWebsiteUrl(websiteUrl)) {
                setValidationError("Enter a full URL, including https://.");
                return;
              }
              try {
                await completeGrowthOnboarding(app, {
                  websiteUrl,
                  companySummary: companySummary.trim().length === 0 ? null : companySummary.trim(),
                  additionalNotes: additionalNotes.trim().length === 0 ? null : additionalNotes.trim(),
                });
              } catch (error) {
                setSubmitError(error instanceof Error ? error.message : String(error));
                return;
              }
              await refresh();
            }}
          >
            Start the analysis
          </DesignButton>
          {demo && <span className="text-sm text-muted-foreground">Demo mode — onboarding is disabled on fixture data.</span>}
        </div>
      </div>
    </DesignCard>
  );
}
export function RestartOnboardingButton() {
  const app = useAdminApp();
  const { data, demo, refresh } = useGrowthStatus();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // This is a page-level escape hatch, not part of the setup step itself. Keep it hidden in the same
  // states where the lifecycle previously omitted it: while status is unavailable, before onboarding
  // completes, after the workspace is released, and for immutable demo fixtures.
  if (demo || data.status !== "loaded" || !data.value.onboarding.completed || data.value.latestReport != null) return null;

  return (
    <>
      <DesignButton variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>Restart onboarding</DesignButton>
      <ActionDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Restart onboarding?"
        description="You'll be asked for your website and description again, and any analysis still running will stop. Your existing findings, reports, and action items are kept."
        danger
        okButton={{
          label: "Restart onboarding",
          onClick: async () => {
            await restartGrowthOnboarding(app);
            await refresh();
          },
        }}
        cancelButton
      />
    </>
  );
}

function SetUpStep(props: { status: GrowthStatus, state: GrowthTimelineStepState }) {
  if (props.state === "done") {
    return (
      <GrowthTimelineStep
        state="done"
        title="Set up"
        summary={props.status.onboarding.websiteUrl ?? undefined}
      />
    );
  }
  // "Set up" is the first step and is never phase-backed, so the derivation can only ever give it
  // "done" (handled above) or "current" — anything else means the two files disagree.
  if (props.state !== "current") {
    throwErr(`The set-up timeline step can only be "done" or "current", got "${props.state}"`);
  }
  return (
    <GrowthTimelineStep
      state="current"
      title="Set up"
      subtitle="Tell us where your product lives and we'll take it from there"
    >
      <OnboardingForm />
    </GrowthTimelineStep>
  );
}

/**
 * One row of the deep-analysis checklist.
 *
 * `waiting` marks a row that is blocked on the customer rather than on us (today: the interview).
 * A spinner there would claim we're working while we're actually waiting for them, so the row gets
 * a plain focused ring instead. `children` renders under the row, indented to the label column —
 * that's where the interview's call to action lives, so the ask sits with the step it belongs to
 * rather than below the whole checklist, where it read as unrelated to the row asking for it.
 */
function StepRow(props: { step: GrowthAnalysisStep, waiting?: boolean, runningLabel?: string, children?: ReactNode }) {
  const { step } = props;
  const stateIcon = new Map([
    ["pending", <CircleIcon key="pending" className="size-4 text-muted-foreground/40" />],
    ["running", <CircleNotchIcon key="running" className="size-4 animate-spin text-cyan-600 dark:text-cyan-400" />],
    ["done", <CheckCircleIcon key="done" weight="fill" className="size-4 text-emerald-600 dark:text-emerald-400" />],
    ["failed", <WarningCircleIcon key="failed" weight="fill" className="size-4 text-destructive" />],
  ]).get(step.state) ?? <CircleIcon className="size-4 text-muted-foreground/40" />;
  const icon = props.waiting === true
    ? <CircleIcon weight="bold" className="size-4 text-cyan-600 dark:text-cyan-400" />
    : stateIcon;
  const labelClassName = step.state === "pending" ? "text-sm text-muted-foreground/60" : "text-sm";
  return (
    <div>
      <div className="flex items-center gap-3 py-1.5">
        {icon}
        {step.description == null ? (
          <span className={labelClassName}>{step.label}</span>
        ) : (
          // Not `SimpleTooltip`: its content is centre-aligned and capped at 15rem, which is fine for the
          // short strings it was built for but turns a three-sentence explanation into a tall ragged column.
          // Composed here instead so the copy gets a left-aligned, wider box; a global TooltipProvider is
          // already mounted in layout-client.tsx. `tabIndex` is what makes the hint keyboard-reachable —
          // Radix only opens on focus for a focusable trigger.
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                className={`${labelClassName} cursor-help underline decoration-dotted decoration-foreground/25 underline-offset-4 transition-colors hover:decoration-foreground/60 hover:transition-none`}
              >
                {step.label}
              </span>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent side="right" align="start" className="max-w-80">
                <p className="text-xs leading-relaxed text-wrap">{step.description}</p>
              </TooltipContent>
            </TooltipPortal>
          </Tooltip>
        )}
        {step.state === "running" && <DesignBadge label={props.runningLabel ?? "In progress"} color="cyan" size="sm" />}
        {step.state === "failed" && <DesignBadge label="Failed" color="red" size="sm" />}
      </div>
      {props.children != null && <div className="pb-2 pl-7 pt-1">{props.children}</div>}
    </div>
  );
}

/**
 * The animated sub-list under the running "Computing metrics" header: cycles through the catalog's
 * metric labels so the breadth of the rollup registers. The sequencing is pure (and tested) in
 * growth-compute-metrics-ticker.ts; this component only owns the timer. The ticker is presentational
 * pacing over the real phase state — the phase alone decides done/failed, so unmounting mid-pass
 * (phase finished) loses nothing.
 */
function ComputeMetricsTicker(props: { metricLabels: string[] }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((current) => current + 1), GROWTH_COMPUTE_METRICS_TICK_MILLIS);
    return () => clearInterval(interval);
  }, []);
  const frame = getGrowthComputeMetricsTickerFrame(props.metricLabels, tick, 3);
  if (frame == null) return null;
  return (
    <div className="flex flex-col gap-1 pl-7 pt-1.5">
      {frame.done.map((label) => (
        <div key={label} className="flex items-center gap-2 text-xs text-muted-foreground/60">
          <CheckCircleIcon weight="fill" className="size-3.5 text-emerald-600/60 dark:text-emerald-400/60" />
          <span>Computing {label.toLowerCase()}</span>
        </div>
      ))}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CircleNotchIcon className="size-3.5 animate-spin text-cyan-600 dark:text-cyan-400" />
        <span>Computing {frame.current.toLowerCase()}…</span>
      </div>
    </div>
  );
}

/**
 * The compute-metrics phase as its own timeline point before deep analysis (user decision: a
 * first-class step, never nested under the analysis). The step state comes from
 * growth-timeline.ts's derivation; this component only decides what each state looks like.
 * "hidden" (a run predating the phase) renders nothing, keeping old runs' timelines unchanged;
 * before onboarding the derivation yields "upcoming", so the step previews even with no run.
 */
function ComputeMetricsStep(props: { status: GrowthStatus, state: GrowthTimelineStepState }) {
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  if (props.state === "hidden") return null;
  const computeMetrics = props.status.analysis.computeMetrics;
  if (props.state === "upcoming" || computeMetrics == null) {
    return (
      <GrowthTimelineStep
        state="upcoming"
        title="Computing metrics"
        subtitle="We compute and store dozens of daily metrics from the data already in your project."
      />
    );
  }
  const metricCount = computeMetrics.metricLabels.length;
  switch (props.state) {
    case "done": {
      return (
        <GrowthTimelineStep
          state="done"
          title="Computing metrics"
          summary={`Computed ${metricCount} metrics`}
        />
      );
    }
    case "failed": {
      // Only the failed state itself — the run-level retry affordance lives in the analysis step's
      // AnalysisFailedContent, and duplicating it here would give the timeline two competing retries.
      return (
        <GrowthTimelineStep state="failed" title="Computing metrics" badge={<DesignBadge label="Failed" color="red" size="sm" />}>
          <DesignAlert variant="error">Computing metrics failed — retry the analysis below to run it again.</DesignAlert>
        </GrowthTimelineStep>
      );
    }
    case "current": {
      return (
        <GrowthTimelineStep
          state="current"
          title="Computing metrics"
          subtitle="Rolling up daily metrics from your project's data"
          badge={computeMetrics.state === "running" ? <DesignBadge label="In progress" color="cyan" size="sm" /> : undefined}
        >
          <DesignCard>
            {computeMetrics.state === "running" ? (
              <div className="flex flex-col">
                <div className="flex items-center gap-3 py-1.5">
                  <CircleNotchIcon className="size-4 animate-spin text-cyan-600 dark:text-cyan-400" />
                  <span className="text-sm">Computing metrics</span>
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">{metricCount} metrics</span>
                </div>
                <ComputeMetricsTicker metricLabels={computeMetrics.metricLabels} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Queued — metric computation starts any moment now.</p>
            )}
          </DesignCard>
        </GrowthTimelineStep>
      );
    }
  }
}

/**
 * The human-gated integrations phase as its own timeline point between computing metrics and deep
 * analysis, matching its real position in the run. Step state comes from growth-timeline.ts;
 * "hidden" (runs predating the phase) renders nothing.
 *
 * The "current" state maps to the wire's "waiting" — the one the run actually pauses on: the
 * backend rests the run until the user answers, and NOTHING else can settle it (the tick's
 * auto-settle only copies a prior run's explicit skip). So both answers must stay reachable at all
 * times; this panel is the only way to resume a dormant run.
 *
 * In particular, connecting must never gate the answer. Connecting reuses the Meta flow on the
 * ad-accounts page, which in this build is a browser-only preview (see lib/ad-platforms/
 * ad-platforms-api.ts) — it stores nothing server-side, so the backend cannot detect it and the
 * status endpoint reports no connection by construction. An earlier version keyed the primary
 * button off that never-true signal, which left anyone who did connect staring at an unchanged
 * card with no way forward but "Skip". Continue is therefore unconditional, and the copy here
 * promises only what a build with no ad-platform backend can actually deliver.
 */
export function IntegrationsStep(props: { status: GrowthStatus, state: GrowthTimelineStepState }) {
  const app = useAdminApp();
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const { demo, refresh } = useGrowthStatus();
  const [actionError, setActionError] = useState<string | null>(null);
  if (props.state === "hidden") return null;
  const integrations = props.status.analysis.integrations;
  if (props.state === "upcoming" || integrations == null) {
    return (
      <GrowthTimelineStep
        state="upcoming"
        title="Integrations"
        subtitle="Optionally connect external services like Meta ads so the analysis can use them too."
      />
    );
  }
  switch (props.state) {
    case "done": {
      return (
        <GrowthTimelineStep
          state="done"
          title="Integrations"
          // Both answers run the analysis on product data alone in this build; the real difference
          // is memory, so that is what the summary reports rather than a connection it cannot verify.
          summary={integrations.state === "connected"
            ? "Continued — the analysis runs on product data only"
            : "Skipped — the analysis runs on product data only, and future runs won't ask"}
        />
      );
    }
    // "failed" can't be produced for this step (the phase auto-settles or waits), but rendering the
    // upcoming preview is the safe fallback.
    case "failed": {
      return (
        <GrowthTimelineStep
          state="upcoming"
          title="Integrations"
          subtitle="Optionally connect external services like Meta ads so the analysis can use them too."
        />
      );
    }
    case "current": {
      const answer = async (action: "skip" | "continue") => {
        setActionError(null);
        const runId = props.status.analysis.runId
          ?? throwErr("The integrations step is waiting but the status carries no run id — the backend only sends this block for an existing run.");
        try {
          await resolveGrowthIntegrations(app, runId, action);
        } catch (error) {
          // Includes the 409 for an answer that raced the tick's auto-settle (a stale panel must
          // refresh rather than believe its click landed) and the 400 for a run with no
          // integrations phase at all; never swallowed.
          setActionError(error instanceof Error ? error.message : String(error));
          return;
        }
        await refresh();
      };
      return (
        <GrowthTimelineStep
          state="current"
          title="Integrations"
          subtitle="Do you want to connect external services so the analysis can use them too?"
        >
          <DesignCard title="Connect external services" subtitle="Ad platforms are a preview in this build and don't feed the analysis yet" icon={PlugsConnectedIcon}>
            <div className="flex flex-col gap-4">
              {actionError != null && <DesignAlert variant="error">{actionError}</DesignAlert>}
              <p className="text-sm text-muted-foreground">
                The analysis is paused until you answer. Continue keeps this question for your next run;
                skipping answers it for good, and future runs won&apos;t ask again.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {/* Unconditional, and first: this is the only control that resumes a dormant run, so it
                  * must never be hidden behind a connection state the backend cannot observe. */}
                <DesignButton disabled={demo} onClick={async () => await answer("continue")}>
                  Continue
                </DesignButton>
                <DesignButton
                  variant="outline"
                  disabled={demo}
                  onClick={() => {
                    // A NEW TAB, not router.push. Connecting is a multi-step detour through Meta's own
                    // consent screen, and navigating there in place unmounts this step — the user loses
                    // their position in onboarding and has to find their way back. In a separate tab the
                    // run stays on screen and they can answer here when they return.
                    // noopener/noreferrer: the opened tab must not get a handle on this one.
                    window.open(withQuery(`/projects/${projectId}/gtm/ad-accounts`), "_blank", "noopener,noreferrer");
                  }}
                >
                  Connect Meta ads
                </DesignButton>
                <DesignButton variant="ghost" disabled={demo} onClick={async () => await answer("skip")}>
                  Skip
                </DesignButton>
                {demo && <span className="text-sm text-muted-foreground">Demo mode — integrations are disabled on fixture data.</span>}
              </div>
            </div>
          </DesignCard>
        </GrowthTimelineStep>
      );
    }
  }
}

function AnalysisFailedContent(props: { status: GrowthStatus }) {
  const app = useAdminApp();
  const { demo, refresh } = useGrowthStatus();
  const [retryError, setRetryError] = useState<string | null>(null);
  return (
    <>
      <DesignAlert variant="error">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>
            The analysis failed{props.status.analysis.errorMessage != null ? `: ${props.status.analysis.errorMessage}` : "."}
          </span>
          {/* Demo mode renders fixture data for a project that doesn't actually have the growth app
            * enabled, so a real retry request would always fail — disabled, like all demo mutations. */}
          <DesignButton
            variant="outline"
            size="sm"
            disabled={demo}
            onClick={async () => {
              setRetryError(null);
              try {
                await retryGrowthAnalysis(app);
              } catch (error) {
                setRetryError(error instanceof Error ? error.message : String(error));
                return;
              }
              await refresh();
            }}
          >
            Retry analysis
          </DesignButton>
        </div>
      </DesignAlert>
      {demo && <p className="text-sm text-muted-foreground">Demo mode — retrying is disabled on fixture data.</p>}
      {retryError != null && <DesignAlert variant="error">Retrying failed: {retryError}</DesignAlert>}
    </>
  );
}

/** The two interview states the customer can still act on — everything else has nothing to invite them to. */
function interviewIsOpen(interview: GrowthStatus["interview"]): boolean {
  return interview.state === "ready" || interview.state === "in_progress";
}

/**
 * The interview's ask: what it's for, how far they've got, and the way in. Two surfaces show it —
 * inline under the "Your interview" checklist row while the analysis is still running, and as a
 * card once the interview is the current timeline step — so the copy and the button live here
 * rather than being written twice and drifting apart.
 *
 * `heading` is only passed by the card: inline, the checklist row above it is already the heading.
 */
function InterviewInvite(props: { status: GrowthStatus, heading?: string }) {
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const interview = props.status.interview;
  if (!interviewIsOpen(interview)) return null;
  const inProgress = interview.state === "in_progress";
  return (
    <div className="flex flex-col gap-4">
      <div>
        {props.heading != null && <p className="text-sm font-medium text-foreground">{props.heading}</p>}
        <p className={`text-sm text-muted-foreground${props.heading != null ? " mt-1" : ""}`}>
          Answer a few questions while the analysis continues so the report fits your business.
        </p>
        {inProgress && (
          <p className="mt-1 text-sm text-muted-foreground">
            You have answered {interview.answeredCount} of about {interview.estimatedTotal} so far.
          </p>
        )}
      </div>
      <div>
        <GoToButton href={withQuery(`/projects/${projectId}/gtm/interview`)}>
          {inProgress ? "Continue the interview" : "Take the interview"}
        </GoToButton>
      </div>
    </div>
  );
}

function EmbeddedInterviewCard(props: { status: GrowthStatus }) {
  if (!interviewIsOpen(props.status.interview)) return null;
  return (
    <DesignCard>
      <InterviewInvite status={props.status} heading="Your interview is ready" />
    </DesignCard>
  );
}

/**
 * Id of the synthesized interview row. The checklist render needs to single it out: it is the one
 * row waiting on the customer rather than on us, so it carries the ask and a waiting marker.
 */
const GROWTH_INTERVIEW_ROW_ID = "customer-interview";

/** Customer-facing steps that keep the initial analysis visibly active through publication. */
function analysisLoadingSteps(status: GrowthStatus): GrowthAnalysisStep[] | null {
  const steps = status.analysis.steps;
  if (steps == null || status.release.state !== "preparing") return steps;
  // "preparing" (plan held for review) is a running row, not a pending one: something is genuinely
  // happening to this step, and a pending circle would read as "we haven't got to it yet".
  const interviewState = status.interview.state === "completed"
    ? "done"
    : status.interview.state === "preparing" || status.interview.state === "ready" || status.interview.state === "in_progress"
      ? "running"
      : "pending";
  return [
    ...steps,
    {
      id: GROWTH_INTERVIEW_ROW_ID,
      label: "Your interview",
      description: "A short set of questions generated from the analysis. Your answers give the final report context that product data and website research cannot provide.",
      state: interviewState,
    },
    {
      id: "report-release",
      label: "Preparing your report",
      description: "Combines the analysis and your answers into the report that opens the Growth workspace.",
      state: status.interview.state === "completed" ? "running" : "pending",
    },
  ];
}

function AnalysisStep(props: { status: GrowthStatus, state: GrowthTimelineStepState }) {
  const { status, state } = props;
  switch (state) {
    case "done": {
      const completedAt = status.analysis.completedAtMillis;
      return (
        <GrowthTimelineStep
          state="done"
          title="Deep analysis"
          summary={completedAt != null ? `Completed ${new Date(completedAt).toLocaleDateString()}` : "Completed"}
        />
      );
    }
    case "failed": {
      return (
        <GrowthTimelineStep state="failed" title="Deep analysis" badge={<DesignBadge label="Failed" color="red" size="sm" />}>
          <AnalysisFailedContent status={status} />
        </GrowthTimelineStep>
      );
    }
    case "current": {
      const steps = analysisLoadingSteps(status);
      return (
        <GrowthTimelineStep
          state="current"
          title="Deep analysis"
          subtitle={GROWTH_HOLD_SHORT}
          badge={<DesignBadge label="In progress" color="cyan" size="sm" />}
        >
          <DesignCard>
            {steps == null ? (
              <p className="text-sm text-muted-foreground">Your analysis is queued and will start any moment now.</p>
            ) : (
              <div className="flex flex-col">
                {/*
                  Every row still pending means the run exists and this step is "current", but the
                  orchestrator has not dispatched a single phase yet — so the card renders as a
                  column of motionless blank circles, which reads as broken rather than as waiting.
                  Say what is actually happening instead. Deliberately NOT a spinner on the first
                  row: nothing is running, and spinning a row would claim a phase had started when
                  it hadn't.
                */}
                {steps.every((step) => step.state === "pending") && (
                  <p className="pb-3 text-sm text-muted-foreground">Your analysis is queued and will start any moment now.</p>
                )}
                {steps.map((step) => {
                  if (step.id !== GROWTH_INTERVIEW_ROW_ID) return <StepRow key={step.id} step={step} />;
                  // The interview row is the only one where no machine is working: it is either
                  // held while its questions are finalized, or waiting on the customer. Either way
                  // a spinner would claim we're computing something, so the row takes a still ring
                  // and says beneath itself what is actually being waited for.
                  const preparing = status.interview.state === "preparing";
                  const open = interviewIsOpen(status.interview);
                  return (
                    <StepRow key={step.id} step={step} waiting={preparing || open} runningLabel={preparing ? "Preparing" : undefined}>
                      {preparing
                        ? <p className="text-sm text-muted-foreground">{GROWTH_INTERVIEW_PREPARING_DETAIL}</p>
                        : open ? <InterviewInvite status={status} /> : undefined}
                    </StepRow>
                  );
                })}
              </div>
            )}
          </DesignCard>
        </GrowthTimelineStep>
      );
    }
    case "upcoming": {
      return (
        <GrowthTimelineStep
          state="upcoming"
          title="Deep analysis"
          subtitle="A deep look at your website, competitors, audiences, and project data."
        />
      );
    }
    // Only the two phase-backed steps (computing metrics, integrations) can be hidden.
    case "hidden": {
      return throwErr("The deep-analysis timeline step is never hidden");
    }
  }
}

function InterviewStep(props: { status: GrowthStatus, state: GrowthTimelineStepState }) {
  const { status, state } = props;
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const interview = status.interview;
  switch (state) {
    case "done": {
      // A completed interview with zero answers means every question was skipped.
      return (
        <GrowthTimelineStep
          state="done"
          title="Interview"
          summary={
            <>
              {interview.answeredCount > 0 ? `${interview.answeredCount} answers` : "Skipped"}
              {" · "}
              <QuietLink href={withQuery(`/projects/${projectId}/gtm/interview`)}>Review</QuietLink>
            </>
          }
        />
      );
    }
    case "current": {
      return (
        <GrowthTimelineStep
          state="current"
          title="Interview"
          subtitle="Answer a few questions so the report fits your business"
          badge={interview.state === "in_progress" ? <DesignBadge label={`${interview.answeredCount} of ~${interview.estimatedTotal} answered`} color="purple" size="sm" /> : undefined}
        >
          <EmbeddedInterviewCard status={status} />
        </GrowthTimelineStep>
      );
    }
    // "failed" only exists for the analysis step, but rendering it as upcoming is the safe fallback.
    case "failed":
    case "upcoming": {
      return (
        <GrowthTimelineStep
          state="upcoming"
          title="Interview"
          subtitle="A few quick questions so the report fits your business — most are multiple choice."
        />
      );
    }
    // Hidden only while the interview is embedded in the initial Deep analysis loading state.
    case "hidden": {
      return null;
    }
  }
}

function reportTriggerLabel(status: GrowthStatus): string | null {
  const report = status.latestReport;
  if (report == null) return null;
  return report.trigger === "milestone" ? (report.milestoneLabel ?? "Milestone") : report.trigger === "manual" ? "Manual run" : "Initial analysis";
}

function ReportStep(props: { status: GrowthStatus, state: GrowthTimelineStepState }) {
  const { status, state } = props;
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const report = status.latestReport;
  switch (state) {
    case "done": {
      return (
        <GrowthTimelineStep
          state="done"
          title="Report"
          isLast
          summary={
            <>
              {report != null ? `Created ${new Date(report.createdAtMillis).toLocaleDateString()}` : null}
              {report != null && " · "}
              <QuietLink href={withQuery(`/projects/${projectId}/gtm/report`)}>Read</QuietLink>
            </>
          }
        />
      );
    }
    case "current": {
      // The report step becomes current the moment the interview is submitted, but the report is
      // written by a later phase and then withheld until it has been read at Hexclave's end — so for
      // roughly a day there is nothing to open. Offering "Read the report" here used to send people
      // to a page that said "No report yet"; say what is actually happening instead. `latestReport`
      // is the only honest signal, and it now means "released to this customer": it is exactly what
      // the report page can render.
      //
      // The spinner that used to sit here is gone with the few-minutes promise it illustrated. A
      // spinner sets the expectation that something resolves while you watch, and this does not.
      if (report == null) {
        return (
          <GrowthTimelineStep state="current" title="Report" isLast subtitle="Writing your report from the analysis and your interview answers. Takes ~4 mins.">
            <DesignCard>
              <div className="flex items-start gap-3">
                <HourglassMediumIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
                <p className="text-sm text-muted-foreground">{GROWTH_HOLD_BODY}</p>
              </div>
            </DesignCard>
          </GrowthTimelineStep>
        );
      }
      const triggerLabel = reportTriggerLabel(status);
      return (
        <GrowthTimelineStep
          state="current"
          title="Report"
          isLast
          subtitle={`Created ${new Date(report.createdAtMillis).toLocaleDateString()}`}
          badge={triggerLabel != null ? <DesignBadge label={triggerLabel} color="blue" size="sm" /> : undefined}
        >
          <DesignCard>
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                The full picture of where your product stands and the actions we recommend, based on the
                analysis and your interview answers.
                {status.counts.suggestedActions > 0 && (
                  <> It came with {status.counts.suggestedActions} suggested {status.counts.suggestedActions === 1 ? "action" : "actions"}.</>
                )}
              </p>
              <div><GoToButton href={withQuery(`/projects/${projectId}/gtm/report`)}>View report</GoToButton></div>
            </div>
          </DesignCard>
        </GrowthTimelineStep>
      );
    }
    case "failed":
    case "upcoming": {
      return (
        <GrowthTimelineStep
          state="upcoming"
          title="Report"
          isLast
          subtitle="A full growth report with what we found and what to do about it."
        />
      );
    }
    // Only the two phase-backed steps (computing metrics, integrations) can be hidden.
    case "hidden": {
      return throwErr("The report timeline step is never hidden");
    }
  }
}

/**
 * One quiet line when the canonical pipeline workflows need attention (deleted, edited away from
 * the default, or failing). Healthy pipelines render NOTHING — the pipeline is plumbing, and a
 * permanent "everything is fine" indicator would just be noise on the overview.
 */
function GrowthPipelineHealthLine(props: { status: GrowthStatus }) {
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const issues = props.status.orchestration.workflows.flatMap((workflow) => {
    // The pipeline workflows are only installed at onboarding, so before onboarding their absence
    // is the expected state, not a deletion — warning there scolds every fresh project.
    if (!workflow.exists) {
      return props.status.onboarding.completed
        ? [`${workflow.workflowId} was deleted (restoring automatically)`]
        : [];
    }
    const parts: string[] = [];
    if (workflow.edited) parts.push(`${workflow.workflowId} was edited`);
    // lastFailedRunSummary reports the most recent FAILED run, which newer successful runs may have
    // superseded — hence "a run … failed", not "is failing".
    if (workflow.lastFailedRunSummary != null) parts.push(`a run of ${workflow.workflowId} failed`);
    return parts;
  });
  if (issues.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <WarningCircleIcon className="size-3.5 text-amber-600 dark:text-amber-400" />
      <span>Pipeline needs attention: {issues.join("; ")}.</span>
      <QuietLink href={withQuery(`/projects/${projectId}/gtm/settings`)}>Review in settings</QuietLink>
    </p>
  );
}
