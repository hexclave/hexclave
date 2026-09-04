"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignInput,
  DesignPillToggle,
  DesignSelectorDropdown,
} from "@/components/design-components";
import { useRouter } from "@/components/router";
import { useUpdateConfig } from "@/components/config-update";
import {
  createExperimentRun,
  FeatureFlagsBackendUnavailableError,
  transitionExperimentRun,
} from "@/lib/feature-flags/admin-adapter";
import {
  experimentConfigUpdates,
  toExperimentRunConfig,
  formatBps,
  validateExperimentConfig,
  type ExperimentConfig,
  type ExperimentMetric,
  type ExperimentMetricRole,
  type MetricSource,
  type MetricSourceType,
} from "@/lib/feature-flags/config";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import {
  CalendarBlankIcon,
  ChartBarIcon,
  FlagIcon,
  LightbulbIcon,
  PlusIcon,
  RocketLaunchIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useId, useMemo, useState } from "react";
import { PageLayout } from "../../../page-layout";
import { useAdminApp } from "../../../use-admin-app";
import { AnalyticsRequiredGuard, generateShortId, PercentField, useFeatureFlagsSection } from "../../shared";

const WIZARD_STEPS = [
  { id: "hypothesis", label: "Hypothesis", icon: LightbulbIcon },
  { id: "flag", label: "Flag & traffic", icon: FlagIcon },
  { id: "metrics", label: "Metrics", icon: ChartBarIcon },
  { id: "schedule", label: "Delivery & schedule", icon: CalendarBlankIcon },
  { id: "review", label: "Review & start", icon: RocketLaunchIcon },
] as const;

type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

const METRIC_TYPE_OPTIONS: { value: MetricSourceType, label: string }[] = [
  { value: "page_view", label: "Page view" },
  { value: "click", label: "Click" },
  { value: "funnel", label: "Funnel" },
  { value: "custom_event", label: "Custom event" },
  { value: "numeric_value", label: "Numeric value" },
];

const ATTRIBUTION_WINDOW_OPTIONS = [
  { value: "24", label: "24 hours" },
  { value: "72", label: "3 days" },
  { value: "168", label: "7 days" },
  { value: "336", label: "14 days" },
  { value: "720", label: "30 days" },
];

export default function PageClient() {
  return (
    <PageLayout title="New experiment" description="Design an A/B experiment on top of a feature flag">
      <AnalyticsRequiredGuard>
        <ExperimentWizard />
      </AnalyticsRequiredGuard>
    </PageLayout>
  );
}

function defaultMetricSource(type: MetricSourceType): MetricSource {
  switch (type) {
    case "page_view": { return { type, urlPattern: "/" }; }
    case "click": { return { type, selector: "" }; }
    case "funnel": { return { type, steps: [{ eventName: "" }, { eventName: "" }] }; }
    case "custom_event": { return { type, eventName: "" }; }
    case "numeric_value": { return { type, eventName: "", propertyName: "", aggregation: "sum" }; }
  }
}

function ExperimentWizard() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const router = useRouter();
  const updateConfig = useUpdateConfig();
  const section = useFeatureFlagsSection();

  const [step, setStep] = useState<WizardStepId>("hypothesis");
  const [displayName, setDisplayName] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [flagKey, setFlagKey] = useState("");
  const [assignmentUnit, setAssignmentUnit] = useState<"user" | "team">("user");
  const [controlVariantId, setControlVariantId] = useState("");
  const [trafficBps, setTrafficBps] = useState(10_000);
  const [weightsByVariantId, setWeightsByVariantId] = useState<Map<string, number>>(new Map());
  const [metrics, setMetrics] = useState<ExperimentMetric[]>([{
    id: generateShortId("metric"),
    label: "",
    role: "primary",
    source: defaultMetricSource("custom_event"),
  }]);
  const [attributionWindowHours, setAttributionWindowHours] = useState(168);
  const [mutualExclusionGroup, setMutualExclusionGroup] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [startFailedNotice, setStartFailedNotice] = useState<string | null>(null);
  // Set after the first successful config write so retrying (e.g. after a
  // failed start) updates the same experiment instead of creating duplicates.
  const [savedExperimentId, setSavedExperimentId] = useState<string | null>(null);
  const [runCreated, setRunCreated] = useState(false);

  const eligibleFlags = useMemo(
    () => [...section.flags.entries()].filter(([, flag]) => !flag.archived && flag.variants.length >= 2),
    [section],
  );
  const selectedFlag = section.flags.get(flagKey);

  const draft = useMemo<ExperimentConfig>(() => ({
    displayName,
    hypothesis,
    flagKey,
    assignmentUnit,
    controlVariantId,
    allocation: selectedFlag == null ? [] : selectedFlag.variants
      .map((variant) => ({ variantId: variant.id, weightBps: weightsByVariantId.get(variant.id) ?? 0 }))
      .filter((entry) => entry.weightBps > 0),
    trafficBps,
    metrics,
    attributionWindowHours,
    mutualExclusionGroup: mutualExclusionGroup.trim().length > 0 ? mutualExclusionGroup.trim() : null,
    schedule: {
      startAtIso: startAt.length > 0 ? new Date(startAt).toISOString() : null,
      endAtIso: endAt.length > 0 ? new Date(endAt).toISOString() : null,
    },
    archived: false,
    createdAtMillis: Date.now(),
  }), [displayName, hypothesis, flagKey, assignmentUnit, controlVariantId, selectedFlag, weightsByVariantId, trafficBps, metrics, attributionWindowHours, mutualExclusionGroup, startAt, endAt]);

  const validationErrors = useMemo(() => validateExperimentConfig(draft, section), [draft, section]);

  const stepIndex = WIZARD_STEPS.findIndex((candidate) => candidate.id === step);
  const scheduledForFuture = draft.schedule.startAtIso != null
    && new Date(draft.schedule.startAtIso).getTime() > new Date().getTime();

  const save = async (startAfterSave: boolean): Promise<void> => {
    const experimentId = savedExperimentId ?? generateShortId("experiment");
    const updated = await updateConfig({
      adminApp,
      configUpdate: experimentConfigUpdates(experimentId, draft, section),
      pushable: true,
    });
    if (!updated) return;
    setSavedExperimentId(experimentId);
    try {
      if (!runCreated) {
        await createExperimentRun(adminApp, experimentId, toExperimentRunConfig(draft, section));
        setRunCreated(true);
      }
      // A future start remains an immutable DRAFT run for the schedule
      // processor. Starting it here would bypass the schedule configured in
      // the wizard and expose traffic immediately.
      if (startAfterSave && !scheduledForFuture) {
        await transitionExperimentRun(adminApp, experimentId, "start");
      }
    } catch (error) {
      if (error instanceof FeatureFlagsBackendUnavailableError) {
        // The config write succeeded, so don't fail the whole flow — land
        // on the detail page with an explicit notice instead.
        setStartFailedNotice(
          "The experiment definition was saved, but its run could not be created or started: this server does not expose the experiment-run endpoints yet.",
        );
        return;
      }
      throw error;
    }
    router.push(urlString`/projects/${project.id}/feature-flags/experiments/${experimentId}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {WIZARD_STEPS.map((wizardStep, index) => (
          <button
            key={wizardStep.id}
            type="button"
            className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors duration-150 hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/[0.2] ${
              wizardStep.id === step
                ? "bg-foreground/[0.08] text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setStep(wizardStep.id)}
          >
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-foreground/[0.08] text-[10px] tabular-nums">{index + 1}</span>
            {wizardStep.label}
          </button>
        ))}
      </div>

      {startFailedNotice != null && (
        <DesignAlert variant="warning" title="Saved, but not started" description={startFailedNotice} />
      )}

      {step === "hypothesis" && (
        <DesignCard title="Hypothesis" subtitle="What do you believe, and how will you know?" icon={LightbulbIcon} gradient="purple">
          <div className="flex flex-col gap-4 max-w-2xl">
            <LabeledInput label="Experiment name" placeholder="Checkout redesign vs. classic" value={displayName} onChange={setDisplayName} />
            <LabeledTextarea
              label="Hypothesis"
              placeholder="Showing the redesigned checkout will increase completed purchases, because the shorter form reduces drop-off."
              value={hypothesis}
              onChange={setHypothesis}
            />
          </div>
        </DesignCard>
      )}

      {step === "flag" && (
        <DesignCard title="Flag & traffic" subtitle="Which variants compete, and who is enrolled" icon={FlagIcon} gradient="purple">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1 max-w-md">
              <span className="text-xs font-medium text-muted-foreground">Feature flag</span>
              {eligibleFlags.length === 0 ? (
                <DesignAlert
                  variant="info"
                  title="No eligible flags"
                  description="Experiments compare flag variants, so you need a non-archived flag with at least two variants first."
                />
              ) : (
                <DesignSelectorDropdown
                  size="sm"
                  value={flagKey}
                  placeholder="Select a flag"
                  onValueChange={(value) => {
                    setFlagKey(value);
                    const flag = section.flags.get(value);
                    if (flag != null) {
                      setControlVariantId(flag.variants[0]?.id ?? "");
                      // Seed an even split across all variants; weights are
                      // editable below.
                      const base = Math.floor(10_000 / flag.variants.length);
                      const remainder = 10_000 - base * flag.variants.length;
                      setWeightsByVariantId(new Map(flag.variants.map((variant, index): [string, number] => [
                        variant.id,
                        base + (index < remainder ? 1 : 0),
                      ])));
                    }
                  }}
                  options={eligibleFlags.map(([key, flag]) => ({ value: key, label: `${flag.displayName} (${key})` }))}
                />
              )}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Assignment unit</span>
              <div className="self-start">
                <DesignPillToggle
                  size="sm"
                  options={[
                    { id: "user", label: "Per user" },
                    { id: "team", label: "Per team" },
                  ]}
                  selected={assignmentUnit}
                  onSelect={(id) => setAssignmentUnit(id === "team" ? "team" : "user")}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                Team-level assignment gives every member of a team the same variant.
              </span>
            </div>
            <div className="max-w-xs">
              <PercentField label="Traffic enrolled in the experiment" bps={trafficBps} onBpsChange={setTrafficBps} />
            </div>
            {selectedFlag != null && (
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">Variant allocation (of enrolled traffic)</span>
                <div className="flex flex-wrap gap-4">
                  {selectedFlag.variants.map((variant) => (
                    <PercentField
                      key={variant.id}
                      label={variant.label}
                      bps={weightsByVariantId.get(variant.id) ?? 0}
                      onBpsChange={(bps) => setWeightsByVariantId((weights) => new Map(weights).set(variant.id, bps))}
                    />
                  ))}
                </div>
                <AllocationTotal weightsByVariantId={weightsByVariantId} variantIds={selectedFlag.variants.map((variant) => variant.id)} />
              </div>
            )}
          </div>
        </DesignCard>
      )}

      {step === "metrics" && (
        <DesignCard title="Metrics" subtitle="One primary metric decides the experiment; guardrails protect you" icon={ChartBarIcon} gradient="purple">
          <div className="flex flex-col gap-3">
            {metrics.map((metric, index) => (
              <MetricEditor
                key={metric.id}
                metric={metric}
                onChange={(updated) => setMetrics((current) => current.map((other, otherIndex) => otherIndex === index ? updated : other))}
                onRemove={() => setMetrics((current) => current.filter((_, otherIndex) => otherIndex !== index))}
                removeDisabled={metrics.length === 1}
              />
            ))}
            <div>
              <DesignButton
                variant="outline"
                size="sm"
                onClick={() => setMetrics((current) => [...current, {
                  id: generateShortId("metric"),
                  label: "",
                  role: current.some((metric) => metric.role === "primary") ? "secondary" : "primary",
                  source: defaultMetricSource("custom_event"),
                }])}
              >
                <PlusIcon className="h-3.5 w-3.5 mr-1" />
                Add metric
              </DesignButton>
            </div>
          </div>
        </DesignCard>
      )}

      {step === "schedule" && (
        <DesignCard title="Delivery & schedule" subtitle="Attribution, exclusion, and timing" icon={CalendarBlankIcon} gradient="purple">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Attribution window</span>
              <DesignSelectorDropdown
                size="sm"
                value={String(attributionWindowHours)}
                onValueChange={(value) => {
                  const parsed = Number(value);
                  if (Number.isFinite(parsed) && parsed > 0) setAttributionWindowHours(parsed);
                }}
                options={ATTRIBUTION_WINDOW_OPTIONS}
              />
              <span className="text-xs text-muted-foreground">
                Conversions count when they happen within this window after a user&apos;s first exposure.
              </span>
            </div>
            <LabeledInput
              label="Mutual exclusion group (optional)"
              placeholder="e.g. checkout-tests"
              value={mutualExclusionGroup}
              onChange={setMutualExclusionGroup}
              helper="Experiments in the same group never enroll the same user simultaneously."
            />
            <LabeledInput label="Start (optional)" type="datetime-local" value={startAt} onChange={setStartAt} helper="Leave empty to start manually." />
            <LabeledInput label="End (optional)" type="datetime-local" value={endAt} onChange={setEndAt} helper="Leave empty to complete manually." />
          </div>
        </DesignCard>
      )}

      {step === "review" && (
        <DesignCard title="Review & start" subtitle="Check the setup before enrolling traffic" icon={RocketLaunchIcon} gradient="purple">
          <div className="flex flex-col gap-3">
            {validationErrors.length > 0 ? (
              <DesignAlert
                variant="error"
                title="Fix these before starting"
                description={
                  <ul className="list-disc pl-4 space-y-1">
                    {validationErrors.map((error, index) => <li key={index}>{error}</li>)}
                  </ul>
                }
              />
            ) : (
              <ul className="text-sm space-y-1.5">
                <ReviewLine label="Hypothesis" value={hypothesis} />
                <ReviewLine label="Flag" value={selectedFlag != null ? `${selectedFlag.displayName} (${flagKey})` : flagKey} />
                <ReviewLine label="Assignment" value={`${assignmentUnit}-level, ${formatBps(trafficBps)} of traffic, ${draft.allocation.length} variants`} />
                <ReviewLine label="Metrics" value={`${metrics.filter((metric) => metric.role === "primary").length} primary, ${metrics.filter((metric) => metric.role === "secondary").length} secondary, ${metrics.filter((metric) => metric.role === "guardrail").length} guardrail`} />
                <ReviewLine label="Attribution window" value={ATTRIBUTION_WINDOW_OPTIONS.find((option) => option.value === String(attributionWindowHours))?.label ?? `${attributionWindowHours} hours`} />
                <ReviewLine label="Schedule" value={startAt.length > 0 || endAt.length > 0 ? `${startAt.length > 0 ? `from ${startAt}` : "manual start"} ${endAt.length > 0 ? `until ${endAt}` : ""}`.trim() : "manual start and completion"} />
              </ul>
            )}
            <DesignAlert
              variant="info"
              title="Results are probabilistic"
              description="Experiment results are Bayesian estimates — credible intervals and probabilities, never guarantees. Plan to run until the interval is narrow enough for your decision."
            />
            <div className="flex items-center justify-end gap-2">
              <DesignButton variant="secondary" size="sm" disabled={validationErrors.length > 0} onClick={async () => await save(false)}>
                Save as draft
              </DesignButton>
              <DesignButton size="sm" disabled={validationErrors.length > 0} onClick={async () => await save(true)}>
                <RocketLaunchIcon className="h-4 w-4 mr-1" />
                {scheduledForFuture ? "Save & schedule" : "Save & start"}
              </DesignButton>
            </div>
          </div>
        </DesignCard>
      )}

      <div className="flex items-center justify-between">
        <DesignButton
          variant="secondary"
          size="sm"
          disabled={stepIndex === 0}
          onClick={() => setStep(WIZARD_STEPS[Math.max(0, stepIndex - 1)].id)}
        >
          Back
        </DesignButton>
        {stepIndex < WIZARD_STEPS.length - 1 && (
          <DesignButton size="sm" onClick={() => setStep(WIZARD_STEPS[stepIndex + 1].id)}>
            Next
          </DesignButton>
        )}
      </div>
    </div>
  );
}

function AllocationTotal(props: { weightsByVariantId: Map<string, number>, variantIds: string[] }) {
  const total = props.variantIds.reduce((sum, variantId) => sum + (props.weightsByVariantId.get(variantId) ?? 0), 0);
  return (
    <span className={total === 10_000 ? "text-xs text-muted-foreground" : "text-xs text-red-600 dark:text-red-400"}>
      Total: {formatBps(total)}{total !== 10_000 && " — must add up to exactly 100%"}
    </span>
  );
}

function ReviewLine(props: { label: string, value: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className="text-muted-foreground w-40 shrink-0">{props.label}</span>
      <span className="min-w-0 break-words">{props.value}</span>
    </li>
  );
}

function LabeledInput(props: {
  label: string,
  value: string,
  onChange: (value: string) => void,
  placeholder?: string,
  type?: string,
  helper?: string,
}) {
  const inputId = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">{props.label}</label>
      <DesignInput
        id={inputId}
        size="sm"
        type={props.type}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.helper != null && <span className="text-xs text-muted-foreground">{props.helper}</span>}
    </div>
  );
}

function LabeledTextarea(props: {
  label: string,
  value: string,
  onChange: (value: string) => void,
  placeholder?: string,
}) {
  const inputId = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">{props.label}</label>
      <textarea
        id={inputId}
        className="w-full min-h-[96px] rounded-xl border border-black/[0.08] dark:border-white/[0.06] bg-white/80 dark:bg-foreground/[0.03] px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/[0.1]"
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

function MetricEditor(props: {
  metric: ExperimentMetric,
  removeDisabled: boolean,
  onChange: (metric: ExperimentMetric) => void,
  onRemove: () => void,
}) {
  const { metric } = props;
  const roleColors: ReadonlyMap<ExperimentMetricRole, "green" | "blue" | "orange"> = new Map([
    ["primary", "green"],
    ["secondary", "blue"],
    ["guardrail", "orange"],
  ]);

  return (
    <div className="rounded-xl bg-foreground/[0.03] ring-1 ring-black/[0.05] dark:ring-white/[0.05] p-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <DesignBadge label={metric.role} color={roleColors.get(metric.role) ?? "blue"} size="sm" />
        <DesignInput
          size="sm"
          className="max-w-xs"
          aria-label="Metric label"
          placeholder="e.g. Completed purchases"
          value={metric.label}
          onChange={(event) => props.onChange({ ...metric, label: event.target.value })}
        />
        <DesignSelectorDropdown
          size="sm"
          className="w-36"
          value={metric.role}
          onValueChange={(value) => {
            if (value === "primary" || value === "secondary" || value === "guardrail") {
              props.onChange({ ...metric, role: value });
            }
          }}
          options={[
            { value: "primary", label: "Primary" },
            { value: "secondary", label: "Secondary" },
            { value: "guardrail", label: "Guardrail" },
          ]}
        />
        <DesignSelectorDropdown
          size="sm"
          className="w-40"
          value={metric.source.type}
          onValueChange={(value) => {
            const type = METRIC_TYPE_OPTIONS.find((option) => option.value === value)?.value;
            if (type != null) props.onChange({ ...metric, source: defaultMetricSource(type) });
          }}
          options={METRIC_TYPE_OPTIONS}
        />
        <div className="ml-auto">
          <DesignButton
            variant="ghost"
            size="icon"
            aria-label={`Remove metric ${metric.label}`}
            disabled={props.removeDisabled}
            onClick={props.onRemove}
          >
            <TrashIcon className="h-4 w-4" />
          </DesignButton>
        </div>
      </div>
      <MetricSourceFields
        source={metric.source}
        onChange={(source) => props.onChange({ ...metric, source })}
      />
    </div>
  );
}

function MetricSourceFields(props: { source: MetricSource, onChange: (source: MetricSource) => void }) {
  const { source } = props;
  switch (source.type) {
    case "page_view": {
      return (
        <LabeledInput
          label="URL pattern"
          placeholder="/checkout/success"
          value={source.urlPattern}
          onChange={(urlPattern) => props.onChange({ ...source, urlPattern })}
          helper="Counts a conversion when the user views a matching page."
        />
      );
    }
    case "click": {
      return (
        <LabeledInput
          label="CSS selector"
          placeholder="#buy-button"
          value={source.selector}
          onChange={(selector) => props.onChange({ ...source, selector })}
          helper="Counts a conversion when the user clicks a matching element."
        />
      );
    }
    case "funnel": {
      return (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">Funnel steps (in order)</span>
          {source.steps.map((step, index) => (
            <div key={index} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-5 text-right tabular-nums">{index + 1}.</span>
              <DesignInput
                size="sm"
                className="max-w-xs font-mono"
                aria-label={`Funnel step ${index + 1} event name`}
                placeholder="event-name"
                value={step.eventName}
                onChange={(event) => props.onChange({
                  ...source,
                  steps: source.steps.map((other, otherIndex) => otherIndex === index ? { eventName: event.target.value } : other),
                })}
              />
              <DesignButton
                variant="ghost"
                size="icon"
                aria-label={`Remove funnel step ${index + 1}`}
                disabled={source.steps.length <= 2}
                onClick={() => props.onChange({ ...source, steps: source.steps.filter((_, otherIndex) => otherIndex !== index) })}
              >
                <TrashIcon className="h-4 w-4" />
              </DesignButton>
            </div>
          ))}
          <div>
            <DesignButton
              variant="ghost"
              size="sm"
              onClick={() => props.onChange({ ...source, steps: [...source.steps, { eventName: "" }] })}
            >
              <PlusIcon className="h-3.5 w-3.5 mr-1" />
              Add step
            </DesignButton>
          </div>
          <span className="text-xs text-muted-foreground">Converts when a user completes every step in order within the attribution window.</span>
        </div>
      );
    }
    case "custom_event": {
      return (
        <LabeledInput
          label="Event name"
          placeholder="purchase-completed"
          value={source.eventName}
          onChange={(eventName) => props.onChange({ ...source, eventName })}
          helper="Counts a conversion when your code captures this custom event."
        />
      );
    }
    case "numeric_value": {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <LabeledInput
            label="Event name"
            placeholder="purchase-completed"
            value={source.eventName}
            onChange={(eventName) => props.onChange({ ...source, eventName })}
          />
          <LabeledInput
            label="Numeric property"
            placeholder="value"
            value={source.propertyName}
            onChange={(propertyName) => props.onChange({ ...source, propertyName })}
          />
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Aggregation</span>
            <DesignSelectorDropdown
              size="sm"
              value={source.aggregation}
              onValueChange={(value) => {
                if (value === "sum" || value === "average") props.onChange({ ...source, aggregation: value });
              }}
              options={[
                { value: "sum", label: "Sum per user" },
                { value: "average", label: "Average per user" },
              ]}
            />
          </div>
        </div>
      );
    }
  }
}
