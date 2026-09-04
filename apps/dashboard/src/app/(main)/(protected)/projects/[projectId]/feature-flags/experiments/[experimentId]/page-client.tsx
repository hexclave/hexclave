"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignDialog,
  DesignDialogClose,
  DesignEmptyState,
  DesignInput,
  DesignProgressBar,
  DesignSkeleton,
  DesignTable,
  DesignTableBody,
  DesignTableCell,
  DesignTableHead,
  DesignTableHeader,
  DesignTableRow,
} from "@/components/design-components";
import { useRouter } from "@/components/router";
import { useUpdateConfig } from "@/components/config-update";
import {
  completeExperimentRun,
  createExperimentRun,
  getExperimentRun,
  getExperimentResults,
  transitionExperimentRun,
  type ExperimentResults,
  type ExperimentRun,
  type ExperimentRunTransition,
} from "@/lib/feature-flags/admin-adapter";
import {
  flagConfigPath,
  formatBps,
  toExperimentRunConfig,
  type ExperimentConfig,
  type ExperimentMetric,
  type FlagConfig,
  type FeatureFlagsSection,
} from "@/lib/feature-flags/config";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import {
  ChartBarIcon,
  FlagIcon,
  FlaskIcon,
  LightbulbIcon,
  PauseIcon,
  PlayIcon,
  RocketLaunchIcon,
  TrophyIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { PageLayout } from "../../../page-layout";
import { useAdminApp } from "../../../use-admin-app";
import {
  AdapterErrorAlert,
  type AdapterLoadState,
  AnalyticsRequiredGuard,
  BackendUnavailableAlert,
  ExperimentStatusBadge,
  formatRelativeTime,
  useAdapterData,
  useFeatureFlagsSection,
} from "../../shared";

type PageClientProps = {
  experimentId: string,
};

// Sentinels for Radix Select options that mean "no selection" — Radix forbids
// empty-string item values.

export default function PageClient({ experimentId }: PageClientProps) {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const router = useRouter();
  const section = useFeatureFlagsSection();
  const experiment = section.experiments.get(experimentId);
  const flag = experiment != null ? section.flags.get(experiment.flagKey) : undefined;

  if (experiment == null) {
    return (
      <PageLayout title="Experiment not found">
        <DesignAlert
          variant="error"
          title="This experiment does not exist"
          description={`No experiment with the ID "${experimentId}" is configured in this project.`}
        />
        <div>
          <DesignButton
            variant="secondary"
            size="sm"
            onClick={() => router.push(urlString`/projects/${project.id}/feature-flags/experiments`)}
          >
            Back to experiments
          </DesignButton>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title={experiment.displayName}
      description={
        <span className="flex flex-wrap items-center gap-2">
          {flag != null && (
            <button
              type="button"
              className="inline-flex focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/[0.2] rounded-md"
              aria-label={`Open flag ${flag.displayName}`}
              onClick={() => router.push(urlString`/projects/${project.id}/feature-flags/flags/${experiment.flagKey}`)}
            >
              <DesignBadge label={flag.displayName} color="blue" size="sm" icon={FlagIcon} />
            </button>
          )}
          <span className="text-xs">{experiment.assignmentUnit}-level · {formatBps(experiment.trafficBps)} of traffic enrolled</span>
        </span>
      }
    >
      <AnalyticsRequiredGuard>
        <ExperimentDetail experimentId={experimentId} experiment={experiment} flag={flag ?? null} section={section} />
      </AnalyticsRequiredGuard>
    </PageLayout>
  );
}

function ExperimentDetail(props: {
  experimentId: string,
  experiment: ExperimentConfig,
  flag: FlagConfig | null,
  section: FeatureFlagsSection,
}) {
  const adminApp = useAdminApp();

  const [runRevision, setRunRevision] = useState(0);
  const runState = useAdapterData(
    async () => await getExperimentRun(adminApp, props.experimentId),
    [adminApp, props.experimentId, runRevision],
  );

  const [sinceDate, setSinceDate] = useState("");
  const [untilDate, setUntilDate] = useState("");
  const runStatus = runState.status === "ok" ? runState.data.status : null;
  const resultsEligible = runStatus === "running" || runStatus === "paused" || runStatus === "completed";

  const resultsState = useAdapterData(
    async () => resultsEligible
      ? await getExperimentResults(adminApp, props.experimentId, {
        ...sinceDate.length > 0 ? { sinceIso: new Date(sinceDate).toISOString() } : {},
        ...untilDate.length > 0 ? { untilIso: new Date(untilDate).toISOString() } : {},
      })
      : null,
    [adminApp, props.experimentId, sinceDate, untilDate, resultsEligible, runRevision],
  );

  if (runState.status === "loading") {
    return (
      <div className="flex flex-col gap-4">
        <DesignSkeleton className="h-24 rounded-2xl" />
        <DesignSkeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  if (runState.status === "unavailable") {
    return (
      <div className="flex flex-col gap-4">
        <BackendUnavailableAlert what="Experiment lifecycle and results" />
        <HypothesisCard experiment={props.experiment} />
      </div>
    );
  }

  if (runState.status === "error") {
    return (
      <div className="flex flex-col gap-4">
        <AdapterErrorAlert what="the experiment run" message={runState.message} />
        <HypothesisCard experiment={props.experiment} />
      </div>
    );
  }

  const run = runState.data;
  const results = resultsState.status === "ok" ? resultsState.data : null;
  const reloadRun = () => setRunRevision((revision) => revision + 1);

  return (
    <div className="flex flex-col gap-4">
      <LifecycleCard
        experimentId={props.experimentId}
        experiment={props.experiment}
        flag={props.flag}
        section={props.section}
        run={run}
        results={results}
        onChanged={reloadRun}
      />
      <HypothesisCard experiment={props.experiment} />
      <ExposuresCard experiment={props.experiment} flag={props.flag} run={run} resultsState={resultsState} />

      <DesignCard
        title="Results"
        subtitle="Bayesian estimates — probabilities and credible intervals, not guarantees"
        icon={ChartBarIcon}
        gradient="cyan"
      >
        <div className="flex flex-col gap-4">
          {!resultsEligible ? (
            <DesignEmptyState
              icon={ChartBarIcon}
              title="Experiment not started"
              description={run.status === "scheduled"
                ? "Results will appear after the scheduled experiment begins enrolling subjects."
                : "Start the experiment to begin collecting exposures and conversion data."}
            />
          ) : (
            <>
              <ResultsFilters
                sinceDate={sinceDate}
                onSinceChange={setSinceDate}
                untilDate={untilDate}
                onUntilChange={setUntilDate}
              />
              {resultsState.status === "loading" && <DesignSkeleton className="h-40 rounded-xl" />}
              {resultsState.status === "unavailable" && <BackendUnavailableAlert what="Experiment results" />}
              {resultsState.status === "error" && <AdapterErrorAlert what="experiment results" message={resultsState.message} />}
              {resultsState.status === "ok" && resultsState.data == null && (
                <DesignEmptyState
                  icon={ChartBarIcon}
                  title="No results available"
                  description="The experiment has started, but results are not available yet."
                />
              )}
              {resultsState.status === "ok" && resultsState.data != null && (
                <ResultsSection
                  experiment={props.experiment}
                  flag={props.flag}
                  results={resultsState.data}
                />
              )}
            </>
          )}
        </div>
      </DesignCard>
    </div>
  );
}

function HypothesisCard({ experiment }: { experiment: ExperimentConfig }) {
  return (
    <DesignCard title="Hypothesis" icon={LightbulbIcon} gradient="purple">
      <p className="text-sm">{experiment.hypothesis}</p>
      <p className="text-xs text-muted-foreground mt-2">
        Attribution window: {experiment.attributionWindowHours} hours
        {experiment.mutualExclusionGroup != null && <> · mutual exclusion group: {experiment.mutualExclusionGroup}</>}
        {experiment.schedule.startAtIso != null && <> · starts {new Date(experiment.schedule.startAtIso).toLocaleString()}</>}
        {experiment.schedule.endAtIso != null && <> · ends {new Date(experiment.schedule.endAtIso).toLocaleString()}</>}
      </p>
    </DesignCard>
  );
}

function LifecycleCard(props: {
  experimentId: string,
  experiment: ExperimentConfig,
  flag: FlagConfig | null,
  section: FeatureFlagsSection,
  run: ExperimentRun,
  results: ExperimentResults | null,
  onChanged: () => void,
}) {
  const adminApp = useAdminApp();
  const updateConfig = useUpdateConfig();
  const [completeOpen, setCompleteOpen] = useState(false);
  const [rolloutOpen, setRolloutOpen] = useState(false);
  const rolloutFlag = props.flag;
  const winnerRollout = props.results?.winnerRollout ?? null;

  const transition = async (name: ExperimentRunTransition) => {
    if (name === "start" && props.run.status === "not_started") {
      await createExperimentRun(adminApp, props.experimentId, toExperimentRunConfig(props.experiment, props.section));
    }
    await transitionExperimentRun(adminApp, props.experimentId, name);
    props.onChanged();
  };

  const winnerVariant = winnerRollout == null
    ? null
    : props.flag?.variants.find((variant) => variant.id === winnerRollout.variantId) ?? null;
  const winnerLabel = winnerVariant?.label ?? winnerRollout?.variantId ?? null;

  return (
    <DesignCard title="Status" icon={FlaskIcon} gradient="default">
      <div className="flex flex-wrap items-center gap-3">
        <ExperimentStatusBadge status={props.run.status} />
        {props.run.startedAtIso != null && (
          <span className="text-xs text-muted-foreground">started {formatRelativeTime(props.run.startedAtIso)}</span>
        )}
        {props.run.completedAtIso != null && (
          <span className="text-xs text-muted-foreground">completed {formatRelativeTime(props.run.completedAtIso)}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {(props.run.status === "not_started" || props.run.status === "draft" || props.run.status === "scheduled") && (
            <DesignButton size="sm" onClick={async () => await transition("start")}>
              <PlayIcon className="h-4 w-4 mr-1" />
              Start
            </DesignButton>
          )}
          {props.run.status === "running" && (
            <DesignButton variant="outline" size="sm" onClick={async () => await transition("pause")}>
              <PauseIcon className="h-4 w-4 mr-1" />
              Pause
            </DesignButton>
          )}
          {props.run.status === "paused" && (
            <DesignButton size="sm" onClick={async () => await transition("resume")}>
              <PlayIcon className="h-4 w-4 mr-1" />
              Resume
            </DesignButton>
          )}
          {(props.run.status === "running" || props.run.status === "paused") && (
            <DesignButton variant="outline" size="sm" onClick={() => setCompleteOpen(true)}>
              <TrophyIcon className="h-4 w-4 mr-1" />
              Complete…
            </DesignButton>
          )}
        </div>
      </div>

      {props.run.status === "completed" && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {winnerLabel != null ? (
            <>
              <DesignBadge label={`Winner declared: ${winnerLabel}`} color="green" size="sm" icon={TrophyIcon} />
              {props.flag != null && (
                <DesignButton size="sm" onClick={() => setRolloutOpen(true)}>
                  <RocketLaunchIcon className="h-4 w-4 mr-1" />
                  Roll out winner
                </DesignButton>
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">Completed without declaring a winner.</span>
          )}
        </div>
      )}

      <DesignDialog
        open={completeOpen}
        onOpenChange={setCompleteOpen}
        size="md"
        icon={TrophyIcon}
        title="Complete experiment"
        description="Enrollment stops. Hexclave keeps computing results from the frozen run snapshot and its attribution window."
        footer={
          <>
            <DesignDialogClose asChild>
              <DesignButton variant="secondary" size="sm">Cancel</DesignButton>
            </DesignDialogClose>
            <DesignButton
              size="sm"
              onClick={async () => {
                await completeExperimentRun(adminApp, props.experimentId, {
                  winnerVariantId: null,
                });
                setCompleteOpen(false);
                props.onChanged();
              }}
            >
              Complete experiment
            </DesignButton>
          </>
        }
      >
        <DesignAlert
          variant="info"
          title="Winner selection stays evidence-based"
          description="A winner appears only after every variant reaches the minimum sample size, probability-to-be-best is at least 95%, and neither a guardrail regression nor SRM is present."
        />
      </DesignDialog>

      {rolloutFlag != null && winnerRollout != null && winnerLabel != null && (
        <DesignDialog
          open={rolloutOpen}
          onOpenChange={setRolloutOpen}
          size="md"
          icon={RocketLaunchIcon}
          title={`Roll out "${winnerLabel}"`}
          description={`Flag: ${rolloutFlag.displayName}`}
          footer={
            <>
              <DesignDialogClose asChild>
                <DesignButton variant="secondary" size="sm">Cancel</DesignButton>
              </DesignDialogClose>
              <DesignButton
                size="sm"
                onClick={async () => {
                  await updateConfig({
                    adminApp,
                    // Path update so sibling flag properties (rules, variants,
                    // holdout) stay untouched.
                    configUpdate: {
                      [`${flagConfigPath(rolloutFlag.internalId)}.variants.${winnerRollout.variantId}`]: {
                        value: winnerRollout.flagValue,
                        description: winnerVariant?.label ?? winnerRollout.variantId,
                      },
                      [`${flagConfigPath(rolloutFlag.internalId)}.rules.__default`]: {
                        enabled: true,
                        priority: 0,
                        rolloutBasisPoints: 10_000,
                        allocationSalt: `${props.experiment.flagKey}.__default`,
                        stickyBy: "distinctId",
                        variantKey: winnerRollout.variantId,
                      },
                    },
                    pushable: true,
                  });
                  setRolloutOpen(false);
                }}
              >
                Confirm rollout
              </DesignButton>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            The frozen winning value is restored and the flag&apos;s default rule changes to serve <span className="font-medium text-foreground">{winnerLabel}</span> to
            all traffic that no targeting rule captures. Targeting rules, the holdout, and the fallback variant are not modified —
            review them afterwards if they should change too.
          </p>
        </DesignDialog>
      )}
    </DesignCard>
  );
}

function ExposuresCard(props: {
  experiment: ExperimentConfig,
  flag: FlagConfig | null,
  run: ExperimentRun,
  resultsState: AdapterLoadState<ExperimentResults | null>,
}) {
  const resultsEligible = props.run.status === "running" || props.run.status === "paused" || props.run.status === "completed";
  const results = props.resultsState.status === "ok" ? props.resultsState.data : null;
  return (
    <DesignCard
      title="Exposures & allocation"
      subtitle={results == null ? undefined : `${results.totalExposures.toLocaleString()} total exposures`}
      icon={UsersThreeIcon}
      gradient="cyan"
    >
      {resultsEligible && props.resultsState.status === "loading" && <DesignSkeleton className="h-24 rounded-xl" />}
      {resultsEligible && props.resultsState.status === "unavailable" && <BackendUnavailableAlert what="Exposure totals" />}
      {resultsEligible && props.resultsState.status === "error" && <AdapterErrorAlert what="exposure totals" message={props.resultsState.message} />}
      {(!resultsEligible || (props.resultsState.status === "ok" && (results == null || results.exposuresByVariant.length === 0))) && (
        <DesignEmptyState
          icon={UsersThreeIcon}
          title="No exposures yet"
          description="Exposures appear once the experiment is running and users evaluate the linked flag."
        />
      )}
      {props.resultsState.status === "ok" && results != null && results.exposuresByVariant.length > 0 && (
        <div className="flex flex-col gap-3">
          {results.exposuresByVariant.map((entry) => {
            const variantLabel = props.flag?.variants.find((variant) => variant.id === entry.variantId)?.label ?? entry.variantId;
            const expectedBps = props.experiment.allocation.find((allocation) => allocation.variantId === entry.variantId)?.weightBps ?? 0;
            return (
              <div key={entry.variantId} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium">{variantLabel}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {entry.exposures.toLocaleString()} exposures · expected {formatBps(expectedBps)}
                  </span>
                </div>
                <DesignProgressBar
                  value={entry.exposures}
                  max={Math.max(1, results.totalExposures)}
                  gradient="cyan"
                  size="sm"
                />
              </div>
            );
          })}
        </div>
      )}
    </DesignCard>
  );
}

function ResultsFilters(props: {
  sinceDate: string,
  onSinceChange: (value: string) => void,
  untilDate: string,
  onUntilChange: (value: string) => void,
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">From</span>
        <DesignInput
          size="sm"
          type="date"
          aria-label="Results from date"
          value={props.sinceDate}
          onChange={(event) => props.onSinceChange(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Until</span>
        <DesignInput
          size="sm"
          type="date"
          aria-label="Results until date"
          value={props.untilDate}
          onChange={(event) => props.onUntilChange(event.target.value)}
        />
      </div>
    </div>
  );
}

function ResultsSection(props: {
  experiment: ExperimentConfig,
  flag: FlagConfig | null,
  results: ExperimentResults,
}) {
  const { results } = props;
  const metricsById = new Map(props.experiment.metrics.map((metric): [string, ExperimentMetric] => [metric.id, metric]));

  if (results.totalExposures === 0) {
    return (
      <DesignEmptyState
        icon={ChartBarIcon}
        title="No experiment data yet"
        description="Results will appear after the first eligible subjects evaluate the linked flag."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {results.srm.detected && (
        <DesignAlert
          variant="error"
          title="Sample ratio mismatch detected"
          description={`The observed variant split deviates from the configured allocation more than chance plausibly allows${results.srm.pValue == null ? "" : ` (p = ${results.srm.pValue.toPrecision(2)})`}. Results are unreliable until the assignment issue is found and fixed.`}
        />
      )}
      {results.insufficientData && (
        <DesignAlert
          variant="info"
          title="Not enough data yet"
          description={`Fewer than ${results.minimumExposuresPerVariant.toLocaleString()} exposures per variant. Credible intervals are still wide — avoid drawing conclusions.`}
        />
      )}
      {results.metrics.map((metricResult) => {
        const metric = metricsById.get(metricResult.metricId);
        if (metric == null) {
          // The backend reported a metric the config no longer contains (e.g.
          // the metric was removed after the run started). Surface it rather
          // than dropping data silently.
          return (
            <DesignAlert
              key={metricResult.metricId}
              variant="warning"
              title={`Unknown metric ${metricResult.metricId}`}
              description="The backend returned results for a metric that is no longer part of this experiment's configuration."
            />
          );
        }
        return (
          <MetricResultTable
            key={metricResult.metricId}
            metric={metric}
            metricResult={metricResult}
            flag={props.flag}
            controlVariantId={results.controlVariantId}
          />
        );
      })}
    </div>
  );
}

function MetricResultTable(props: {
  metric: ExperimentMetric,
  metricResult: ExperimentResults["metrics"][number],
  flag: FlagConfig | null,
  controlVariantId: string,
}) {
  const roleColor = props.metric.role === "primary" ? "green" : props.metric.role === "guardrail" ? "orange" : "blue";
  const isNumeric = props.metric.source.type === "numeric_value";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{props.metric.label}</span>
        <DesignBadge label={props.metric.role} color={roleColor} size="sm" />
        {props.metricResult.guardrailBreached && (
          <DesignBadge label="Guardrail breached" color="red" size="sm" />
        )}
      </div>
      {props.metricResult.guardrailBreached && (
        <DesignAlert
          variant="warning"
          title="Guardrail metric degraded"
          description="This guardrail shows credible evidence of regression. Consider pausing the experiment while you investigate."
        />
      )}
      <DesignTable>
        <DesignTableHeader>
          <DesignTableRow>
            <DesignTableHead>Variant</DesignTableHead>
            <DesignTableHead>Exposures</DesignTableHead>
            <DesignTableHead>{isNumeric ? "Value" : "Conversions"}</DesignTableHead>
            {!isNumeric && <DesignTableHead>Conv. rate</DesignTableHead>}
            <DesignTableHead>Lift vs control</DesignTableHead>
            <DesignTableHead>95% credible interval</DesignTableHead>
            <DesignTableHead>P(best)</DesignTableHead>
          </DesignTableRow>
        </DesignTableHeader>
        <DesignTableBody>
          {props.metricResult.perVariant.map((variantResult) => {
            const variantLabel = props.flag?.variants.find((variant) => variant.id === variantResult.variantId)?.label
              ?? variantResult.variantId;
            return (
              <DesignTableRow key={variantResult.variantId}>
                <DesignTableCell>
                  <span className="text-sm font-medium">{variantLabel}</span>
                  {variantResult.variantId === props.controlVariantId && <span className="text-xs text-muted-foreground ml-1.5">(control)</span>}
                </DesignTableCell>
                <DesignTableCell><span className="tabular-nums text-sm">{variantResult.exposures.toLocaleString()}</span></DesignTableCell>
                <DesignTableCell><span className="tabular-nums text-sm">{isNumeric ? formatNumericValue(variantResult.value) : variantResult.value.toLocaleString()}</span></DesignTableCell>
                {!isNumeric && (
                  <DesignTableCell>
                    <span className="tabular-nums text-sm">
                      {variantResult.conversionRate != null ? formatPercent(variantResult.conversionRate) : "—"}
                    </span>
                  </DesignTableCell>
                )}
                <DesignTableCell>
                  <span className={`tabular-nums text-sm ${liftClass(variantResult.liftVsControl)}`}>
                    {variantResult.liftVsControl != null ? formatSignedPercent(variantResult.liftVsControl) : "—"}
                  </span>
                </DesignTableCell>
                <DesignTableCell>
                  <span className="tabular-nums text-xs text-muted-foreground">
                    [{isNumeric ? formatNumericValue(variantResult.credibleIntervalLow) : formatPercent(variantResult.credibleIntervalLow)}, {isNumeric ? formatNumericValue(variantResult.credibleIntervalHigh) : formatPercent(variantResult.credibleIntervalHigh)}]
                  </span>
                </DesignTableCell>
                <DesignTableCell>
                  <span className="tabular-nums text-sm">{formatPercent(variantResult.probabilityBest)}</span>
                </DesignTableCell>
              </DesignTableRow>
            );
          })}
        </DesignTableBody>
      </DesignTable>
    </div>
  );
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatSignedPercent(fraction: number): string {
  const formatted = formatPercent(Math.abs(fraction));
  return fraction >= 0 ? `+${formatted}` : `−${formatted}`;
}

function formatNumericValue(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function liftClass(lift: number | null): string {
  if (lift == null || lift === 0) return "";
  return lift > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
}
