"use client";

import {
  DesignAnalyticsCard,
  DesignAnalyticsCardHeader,
  DesignBadge,
  DesignButton,
  DesignInput,
} from "@/components/design-components";
import { cn } from "@/lib/utils";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  GraphIcon,
  MagnifyingGlassIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { useAdminApp } from "../../use-admin-app";
import { getErrorMessage } from "../format";
import { ObservabilityPageLayout } from "../observability-page-layout";
import {
  ObservabilityEmptyState,
  ObservabilityErrorState,
  ObservabilityLoadingState,
  ObservabilityRefreshButton,
  ObservabilityTimeRangeToggle,
  ObservabilityToolbar,
} from "../page-chrome";
import {
  serviceIdentityEquals,
  serviceIdentityLabel,
  type ServiceIdentity,
} from "../service-identity";
import { ServiceSparkline } from "./service-sparkline";
import {
  buildServiceTimelines,
  DEFAULT_SERVICE_TIME_RANGE_HOURS,
  dependenciesForService,
  getServiceBucketGranularity,
  getServiceDependenciesQuery,
  getServiceTimelineQuery,
  getServicesSummaryQuery,
  parseServiceDependencyRow,
  parseServiceSummaryRow,
  rankServiceAttention,
  relativeChange,
  serviceErrorRate,
  type ServiceAttentionSignal,
  type ServiceDependency,
  type ServiceSummary,
  type ServiceTimeline,
  type ServiceTimeRangeHours,
} from "./services-data";
import { observabilityTimeRangeLabel, queryObservability } from "../filters";
import {
  attentionReasonDescription,
  attentionReasonLabel,
  formatAbsoluteTime,
  formatCount,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatSignedPercent,
} from "./services-format";

type SortColumn = "attention" | "name" | "requests" | "errors" | "latency" | "lastSeen";

function identityKey(identity: ServiceIdentity): string {
  return serviceIdentityLabel(identity);
}

function DeltaLabel({
  ratio,
  higherIsWorse,
  className,
}: {
  ratio: number | null,
  higherIsWorse: boolean,
  className?: string,
}) {
  if (ratio == null) return <span className={cn("text-muted-foreground/60", className)}>—</span>;
  const meaningful = Math.abs(ratio) >= 0.05;
  const bad = higherIsWorse ? ratio > 0 : ratio < 0;
  return (
    <span
      className={cn(
        "tabular-nums",
        !meaningful && "text-muted-foreground/60",
        meaningful && bad && "text-red-600 dark:text-red-400",
        meaningful && !bad && "text-emerald-600 dark:text-emerald-400",
        className,
      )}
    >
      {formatSignedPercent(ratio)}
    </span>
  );
}

function AttentionCard({
  signals,
  timelines,
  bucketLabel,
  bucketNoun,
  rangeLabel,
  nowMs,
  onSelect,
}: {
  signals: readonly ServiceAttentionSignal[],
  timelines: ReadonlyMap<string, ServiceTimeline>,
  bucketLabel: string,
  bucketNoun: string,
  rangeLabel: string,
  nowMs: number,
  onSelect: (identity: ServiceIdentity) => void,
}) {
  if (signals.length === 0) {
    return (
      <DesignAnalyticsCard gradient="green">
        <div className="flex items-center gap-3 p-4">
          <CheckCircleIcon className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="min-w-0">
            <p className="text-sm font-medium">Nothing needs attention</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              No error bursts, error spikes, latency regressions or newly silent services in the
              last {rangeLabel}, compared with the {rangeLabel} before it.
            </p>
          </div>
        </div>
      </DesignAnalyticsCard>
    );
  }

  return (
    <DesignAnalyticsCard gradient="orange">
      <DesignAnalyticsCardHeader
        label="Needs attention"
        right={(
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            vs. previous {rangeLabel}
          </span>
        )}
      />
      <div>
        {signals.map((signal) => {
          const timeline = timelines.get(identityKey(signal.identity)) ?? null;
          return (
            <button
              key={identityKey(signal.identity)}
              type="button"
              onClick={() => onSelect(signal.identity)}
              className={cn(
                "flex w-full items-center gap-4 border-b border-foreground/[0.05] px-4 py-3 text-left last:border-b-0",
                "transition-colors duration-150 hover:bg-foreground/[0.025] hover:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{serviceIdentityLabel(signal.identity)}</span>
                  {signal.reasons.map((reason) => (
                    <DesignBadge
                      key={reason}
                      label={attentionReasonLabel(reason)}
                      color={reason === "latency-regression" ? "orange" : reason === "went-silent" ? "blue" : "red"}
                      size="sm"
                    />
                  ))}
                </span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {attentionReasonDescription(signal.reasons[0], {
                    errorCount: signal.summary.errorCount,
                    baselineErrorCount: signal.summary.baselineErrorCount,
                    latestBucketErrorCount: signal.latestBucketErrorCount,
                    bucketNoun,
                    p95DurationMs: signal.summary.p95DurationMs,
                    baselineP95DurationMs: signal.summary.baselineP95DurationMs,
                    baselineRequestCount: signal.summary.baselineRequestCount,
                  })}
                </span>
              </span>
              {timeline != null && (
                <ServiceSparkline
                  buckets={timeline.buckets}
                  bucketLabel={bucketLabel}
                  className="hidden w-32 shrink-0 sm:flex"
                />
              )}
              <span className="w-24 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {signal.summary.lastErrorAt == null
                  ? "no errors"
                  : `last ${formatRelativeTime(signal.summary.lastErrorAt, nowMs)}`}
              </span>
            </button>
          );
        })}
      </div>
    </DesignAnalyticsCard>
  );
}

function DependencyList({
  label,
  direction,
  dependencies,
  onSelect,
}: {
  label: string,
  direction: "incoming" | "outgoing",
  dependencies: readonly ServiceDependency[],
  onSelect: (identity: ServiceIdentity) => void,
}) {
  return (
    <div className="min-w-0">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="space-y-2">
        {dependencies.length === 0 ? (
          <div className="rounded-xl border border-dashed border-foreground/[0.1] px-3 py-5 text-center text-xs text-muted-foreground">
            None observed
          </div>
        ) : dependencies.slice(0, 6).map((dependency) => {
          const identity = direction === "incoming" ? dependency.source : dependency.target;
          const failing = dependency.errorCount > 0;
          return (
            <button
              key={`${serviceIdentityLabel(dependency.source)}→${serviceIdentityLabel(dependency.target)}`}
              type="button"
              onClick={() => onSelect(identity)}
              className={cn(
                "w-full min-w-0 rounded-xl px-3 py-2 text-left ring-1",
                "transition-colors duration-150 hover:transition-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                failing
                  ? "bg-red-500/[0.06] ring-red-500/20 hover:bg-red-500/[0.1]"
                  : "bg-foreground/[0.025] ring-foreground/[0.06] hover:bg-foreground/[0.05]",
              )}
            >
              <span className="block truncate text-xs font-medium">{serviceIdentityLabel(identity)}</span>
              <span className="mt-0.5 block text-[10px] tabular-nums text-muted-foreground">
                {formatCount(dependency.callCount)} calls
                {dependency.p95DurationMs != null && ` · p95 ${formatDuration(dependency.p95DurationMs)}`}
                {failing && (
                  <span className="text-red-600 dark:text-red-400">
                    {" · "}{formatCount(dependency.errorCount)} errors
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ServiceTopology({
  selected,
  dependencies,
  timeline,
  bucketLabel,
  nowMs,
  onSelect,
}: {
  selected: ServiceSummary,
  dependencies: readonly ServiceDependency[],
  timeline: ServiceTimeline | null,
  bucketLabel: string,
  nowMs: number,
  onSelect: (identity: ServiceIdentity) => void,
}) {
  const { incoming, outgoing } = dependenciesForService(dependencies, selected.identity);
  const errorRate = serviceErrorRate(selected);
  const requestChange = relativeChange(selected.requestCount, selected.baselineRequestCount);
  const latencyChange = selected.p95DurationMs != null && selected.baselineP95DurationMs != null
    ? relativeChange(selected.p95DurationMs, selected.baselineP95DurationMs)
    : null;

  return (
    <DesignAnalyticsCard gradient="blue" className="overflow-hidden">
      <DesignAnalyticsCardHeader
        label="Dependency map"
        right={<span className="text-[10px] text-muted-foreground">Immediate span relationships</span>}
      />
      <div className="grid min-h-56 items-center gap-3 p-4 md:grid-cols-[minmax(0,1fr)_2rem_minmax(13rem,0.9fr)_2rem_minmax(0,1fr)]">
        <DependencyList label="Calls into" direction="incoming" dependencies={incoming} onSelect={onSelect} />
        <div className="hidden items-center justify-center text-muted-foreground/50 md:flex">
          <ArrowRightIcon className="h-4 w-4" />
        </div>
        <div className="rounded-2xl bg-blue-500/[0.07] p-4 ring-1 ring-blue-500/20">
          <p className="truncate text-center text-sm font-semibold">{serviceIdentityLabel(selected.identity)}</p>
          <p className="mt-0.5 text-center text-[10px] tabular-nums text-muted-foreground">
            active {formatRelativeTime(selected.lastSeenAt, nowMs)}
          </p>
          {timeline != null && (
            <ServiceSparkline buckets={timeline.buckets} bucketLabel={bucketLabel} className="mt-3" />
          )}
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Requests</dt>
              <dd className="text-sm font-semibold tabular-nums">{formatCount(selected.requestCount)}</dd>
              <dd className="text-[10px]"><DeltaLabel ratio={requestChange} higherIsWorse={false} /></dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">p95</dt>
              <dd className="text-sm font-semibold tabular-nums">{formatDuration(selected.p95DurationMs)}</dd>
              <dd className="text-[10px]"><DeltaLabel ratio={latencyChange} higherIsWorse /></dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Errors</dt>
              <dd className={cn(
                "text-sm font-semibold tabular-nums",
                selected.errorCount > 0 && "text-red-600 dark:text-red-400",
              )}>
                {formatCount(selected.errorCount)}
              </dd>
              <dd className="text-[10px] tabular-nums text-muted-foreground">
                {selected.lastErrorAt == null
                  ? "none in window"
                  : `last ${formatRelativeTime(selected.lastErrorAt, nowMs)}`}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">Error rate</dt>
              <dd className="text-sm font-semibold tabular-nums">
                {errorRate == null ? "—" : formatPercent(errorRate)}
              </dd>
              <dd className="text-[10px] tabular-nums text-muted-foreground">
                {errorRate == null ? "sampled spans" : `of ${formatCount(selected.requestCount)} requests`}
              </dd>
            </div>
          </dl>
          <p className="mt-3 border-t border-foreground/[0.06] pt-2 text-center text-[10px] tabular-nums text-muted-foreground">
            {incoming.length} in · {outgoing.length} out · {formatCount(selected.traceCount)} traces
          </p>
        </div>
        <div className="hidden items-center justify-center text-muted-foreground/50 md:flex">
          <ArrowRightIcon className="h-4 w-4" />
        </div>
        <DependencyList label="Calls out to" direction="outgoing" dependencies={outgoing} onSelect={onSelect} />
      </div>
    </DesignAnalyticsCard>
  );
}

const SORT_COLUMNS: readonly {
  id: Exclude<SortColumn, "attention">,
  label: string,
  columnClassName: string,
}[] = [
  { id: "name", label: "Service", columnClassName: "col-start-1 text-left" },
  { id: "requests", label: "Requests", columnClassName: "col-start-4 text-right" },
  { id: "errors", label: "Errors", columnClassName: "col-start-6 text-right" },
  { id: "latency", label: "p95", columnClassName: "col-start-7 text-right" },
  { id: "lastSeen", label: "Last seen", columnClassName: "col-start-8 text-right" },
];

const INVENTORY_GRID_CLASS = "grid-cols-[minmax(11rem,1.4fr)_6rem_minmax(4rem,0.8fr)_5.5rem_4.5rem_5.5rem_5rem_6rem]";

function ServiceInventory({
  services,
  timelines,
  attentionKeys,
  bucketLabel,
  nowMs,
  selectedIdentity,
  onSelect,
}: {
  services: readonly ServiceSummary[],
  timelines: ReadonlyMap<string, ServiceTimeline>,
  attentionKeys: ReadonlySet<string>,
  bucketLabel: string,
  nowMs: number,
  selectedIdentity: ServiceIdentity | null,
  onSelect: (identity: ServiceIdentity) => void,
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortColumn>("attention");

  const visibleServices = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = needle === ""
      ? [...services]
      : services.filter((service) => serviceIdentityLabel(service.identity).toLowerCase().includes(needle));

    return filtered.sort((left, right) => {
      switch (sort) {
        case "attention": {
          const leftFlagged = attentionKeys.has(identityKey(left.identity)) ? 1 : 0;
          const rightFlagged = attentionKeys.has(identityKey(right.identity)) ? 1 : 0;
          return rightFlagged - leftFlagged
            || right.errorCount - left.errorCount
            || right.requestCount - left.requestCount
            || stringCompare(serviceIdentityLabel(left.identity), serviceIdentityLabel(right.identity));
        }
        case "name": {
          return stringCompare(serviceIdentityLabel(left.identity), serviceIdentityLabel(right.identity));
        }
        case "requests": {
          return right.requestCount - left.requestCount;
        }
        case "errors": {
          return right.errorCount - left.errorCount;
        }
        case "latency": {
          return (right.p95DurationMs ?? -1) - (left.p95DurationMs ?? -1);
        }
        case "lastSeen": {
          return stringCompare(right.lastSeenAt, left.lastSeenAt);
        }
      }
    });
  }, [attentionKeys, search, services, sort]);

  return (
    <DesignAnalyticsCard gradient="slate">
      <DesignAnalyticsCardHeader
        label="All services"
        right={(
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {visibleServices.length === services.length
              ? `${services.length} total`
              : `${visibleServices.length} of ${services.length}`}
          </span>
        )}
      />
      <div className="border-b border-foreground/[0.05] p-3">
        <div className="relative max-w-xs">
          <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <DesignInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter services…"
            aria-label="Filter services"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[880px]">
          <div className={cn(
            "grid items-center gap-3 border-b border-foreground/[0.05] px-4 py-2",
            "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground",
            INVENTORY_GRID_CLASS,
          )}>
            {SORT_COLUMNS.map((column) => (
              <button
                key={column.id}
                type="button"
                onClick={() => setSort(column.id)}
                aria-pressed={sort === column.id}
                className={cn(
                  "uppercase tracking-wider",
                  "transition-colors duration-150 hover:text-foreground hover:transition-none",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                  column.columnClassName,
                  sort === column.id && "text-foreground",
                )}
              >
                {column.label}
              </button>
            ))}
            <span className="col-start-2">Status</span>
            <span className="col-start-3">Trend ({bucketLabel})</span>
            <span className="col-start-5 text-right">Δ req</span>
          </div>

          {visibleServices.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">No services match this filter.</p>
          ) : visibleServices.map((service) => {
            const key = identityKey(service.identity);
            const timeline = timelines.get(key) ?? null;
            const selected = selectedIdentity != null && serviceIdentityEquals(service.identity, selectedIdentity);
            const flagged = attentionKeys.has(key);
            const errorRate = serviceErrorRate(service);
            const requestChange = relativeChange(service.requestCount, service.baselineRequestCount);
            return (
              <button
                key={key}
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(service.identity)}
                className={cn(
                  "grid w-full items-center gap-3 border-b border-foreground/[0.05] px-4 py-2.5 text-left last:border-b-0",
                  "transition-colors duration-150 hover:transition-none",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
                  INVENTORY_GRID_CLASS,
                  selected ? "bg-blue-500/[0.07]" : "hover:bg-foreground/[0.025]",
                )}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{serviceIdentityLabel(service.identity)}</span>
                  <span className="mt-0.5 block text-[10px] tabular-nums text-muted-foreground">
                    {service.instanceCount === 0
                      ? `${formatCount(service.spanCount)} spans`
                      : `${formatCount(service.instanceCount)} ${service.instanceCount === 1 ? "instance" : "instances"}`}
                    {service.openSpanCount > 0 && ` · ${formatCount(service.openSpanCount)} open`}
                  </span>
                </span>

                <span>
                  {flagged ? (
                    <DesignBadge label="Attention" color="red" size="sm" />
                  ) : service.requestCount === 0 ? (
                    <DesignBadge label="Idle" color="blue" size="sm" />
                  ) : (
                    <DesignBadge label="Steady" color="green" size="sm" />
                  )}
                </span>

                <span className="min-w-0">
                  {timeline != null ? (
                    <ServiceSparkline buckets={timeline.buckets} bucketLabel={bucketLabel} />
                  ) : (
                    <span className="block text-[10px] text-muted-foreground/60">—</span>
                  )}
                </span>

                <span className="text-right text-xs tabular-nums">{formatCount(service.requestCount)}</span>

                <span className="text-right text-[11px]">
                  <DeltaLabel ratio={requestChange} higherIsWorse={false} />
                </span>

                <span className="text-right">
                  <span className={cn(
                    "block text-xs tabular-nums",
                    service.errorCount > 0 && "text-red-600 dark:text-red-400",
                  )}>
                    {formatCount(service.errorCount)}
                  </span>
                  {service.lastErrorAt != null && (
                    <span className="mt-0.5 block text-[10px] tabular-nums text-muted-foreground">
                      {errorRate == null
                        ? formatRelativeTime(service.lastErrorAt, nowMs)
                        : formatPercent(errorRate)}
                    </span>
                  )}
                </span>

                <span className="text-right text-xs tabular-nums">{formatDuration(service.p95DurationMs)}</span>

                <span
                  className="text-right text-[11px] tabular-nums text-muted-foreground"
                  title={formatAbsoluteTime(service.lastSeenAt)}
                >
                  {formatRelativeTime(service.lastSeenAt, nowMs)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </DesignAnalyticsCard>
  );
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const [hours, setHours] = useState<ServiceTimeRangeHours>(DEFAULT_SERVICE_TIME_RANGE_HOURS);
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [dependencies, setDependencies] = useState<ServiceDependency[]>([]);
  const [timelines, setTimelines] = useState<ReadonlyMap<string, ServiceTimeline>>(new Map());
  const [selectedIdentity, setSelectedIdentity] = useState<ServiceIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAtMs, setLoadedAtMs] = useState(() => Date.now());
  const requestSequenceRef = useRef(0);

  const granularity = getServiceBucketGranularity(hours);
  const rangeLabel = observabilityTimeRangeLabel(hours);

  const loadServices = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const summaryQuery = getServicesSummaryQuery(hours);
      const dependencyQuery = getServiceDependenciesQuery(hours);
      const timelineQuery = getServiceTimelineQuery(hours);
      const [summaryResponse, dependencyResponse, timelineResponse] = await Promise.all([
        queryObservability(adminApp, {
          query: summaryQuery.query,
          params: summaryQuery.params,
        }),
        queryObservability(adminApp, {
          query: dependencyQuery.query,
          params: dependencyQuery.params,
        }),
        queryObservability(adminApp, {
          query: timelineQuery.query,
          params: timelineQuery.params,
        }),
      ]);
      if (requestSequence !== requestSequenceRef.current) return;
      const nextServices = summaryResponse.result.map(parseServiceSummaryRow);
      const nextDependencies = dependencyResponse.result.map(parseServiceDependencyRow);
      const nowMs = Date.now();
      const nextTimelines = buildServiceTimelines(timelineResponse.result, hours, nowMs);
      setServices(nextServices);
      setDependencies(nextDependencies);
      setTimelines(nextTimelines);
      setLoadedAtMs(nowMs);
      setSelectedIdentity((current) => {
        if (current != null && nextServices.some((service) => serviceIdentityEquals(service.identity, current))) {
          return current;
        }
        const ranked = rankServiceAttention(nextServices, nextTimelines);
        return ranked.at(0)?.identity ?? nextServices.at(0)?.identity ?? null;
      });
    } catch (caught) {
      if (requestSequence !== requestSequenceRef.current) return;
      setError(getErrorMessage(caught));
    } finally {
      if (requestSequence === requestSequenceRef.current) setLoading(false);
    }
  }, [adminApp, hours]);

  useEffect(() => {
    runAsynchronouslyWithAlert(loadServices);
  }, [loadServices]);

  const attentionSignals = useMemo(
    () => rankServiceAttention(services, timelines),
    [services, timelines],
  );
  const attentionKeys = useMemo(
    () => new Set(attentionSignals.map((signal) => identityKey(signal.identity))),
    [attentionSignals],
  );
  const selectedService = useMemo(() => (
    selectedIdentity == null
      ? null
      : services.find((service) => serviceIdentityEquals(service.identity, selectedIdentity)) ?? null
  ), [selectedIdentity, services]);

  const sampledServiceCount = services.filter((service) => service.sampledSpanCount > 0).length;

  const headerActions = (
    <ObservabilityToolbar
      range={<ObservabilityTimeRangeToggle hours={hours} onChange={setHours} />}
      actions={<ObservabilityRefreshButton onRefresh={loadServices} loading={loading} />}
    />
  );

  return (
    <AppEnabledGuard appId="observability">
      <ObservabilityPageLayout
        title="Services"
        actions={headerActions}
      >
        {error != null && (
          <ObservabilityErrorState
            title="Services could not be loaded"
            description={error}
            onRetry={loadServices}
          />
        )}

        {loading && services.length === 0 ? (
          <DesignAnalyticsCard gradient="slate">
            <ObservabilityLoadingState label="Loading service telemetry…" />
          </DesignAnalyticsCard>
        ) : services.length === 0 && error == null ? (
          <DesignAnalyticsCard gradient="slate">
            <ObservabilityEmptyState
              icon={GraphIcon}
              title="No instrumented services in this window"
              description="Services appear here when spans report an OpenTelemetry service name. Try a longer time range or send a traced request."
            />
          </DesignAnalyticsCard>
        ) : (
          <>
            <AttentionCard
              signals={attentionSignals}
              timelines={timelines}
              bucketLabel={granularity.label}
              bucketNoun={granularity.bucketNoun}
              rangeLabel={rangeLabel}
              nowMs={loadedAtMs}
              onSelect={setSelectedIdentity}
            />

            {selectedService != null && (
              <ServiceTopology
                selected={selectedService}
                dependencies={dependencies}
                timeline={timelines.get(identityKey(selectedService.identity)) ?? null}
                bucketLabel={granularity.label}
                nowMs={loadedAtMs}
                onSelect={setSelectedIdentity}
              />
            )}

            <ServiceInventory
              services={services}
              timelines={timelines}
              attentionKeys={attentionKeys}
              bucketLabel={granularity.label}
              nowMs={loadedAtMs}
              selectedIdentity={selectedService?.identity ?? null}
              onSelect={setSelectedIdentity}
            />

            {sampledServiceCount > 0 && (
              <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-muted-foreground">
                <WarningCircleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>
                  {sampledServiceCount === 1 ? "One service reports" : `${sampledServiceCount} services report`} spans
                  produced by Hexclave&apos;s own backend, which keeps every failing trace but only a fraction of the
                  successful ones. Error rates are therefore hidden for those services; counts and window-over-window
                  trends stay comparable, because the same sampling applies to both windows.
                </span>
              </p>
            )}
          </>
        )}
      </ObservabilityPageLayout>
    </AppEnabledGuard>
  );
}
