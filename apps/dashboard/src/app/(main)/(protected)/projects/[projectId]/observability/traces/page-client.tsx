"use client";

import { DesignAlert, DesignButton, DesignInput, DesignSelectorDropdown } from "@/components/design-components";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { ChartLineIcon, CheckIcon, CopyIcon, LinkSimpleIcon, StackIcon, TreeStructureIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDebounce } from "use-debounce";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { useAdminApp } from "../../use-admin-app";
import { AiSpanDetailSection } from "./ai-span";
import {
  ErrorDisplay,
  RowDetailDialog,
  isDateValue,
  parseClickHouseDate,
  type RowData,
} from "../../analytics/shared";
import { SpanTreeList } from "./span-tree";
import {
  buildTraces,
  selectPrimaryTrace,
  traceContainsSpanId,
  type EventInput,
  type SpanInput,
  type Trace,
} from "./trace-utils";
import { TraceVolumeChart } from "./trace-volume-chart";
import {
  getTraceVolumeQuery,
  parseTraceVolumeRows,
  type TraceTimeRangeHours,
  type TraceVolumeBucket,
} from "./trace-volume";
import { TraceWaterfall } from "./waterfall";
import {
  selectValueToServiceIdentity,
  serviceIdentitiesFromTraceRow,
  serviceIdentityEquals,
  serviceIdentityLabel,
  serviceIdentityToSelectValue,
  parseServiceIdentityRow,
  type ServiceIdentity,
} from "../service-identity";
import { ALL_SERVICES_SELECT_VALUE, queryObservability, readLocationSearch, replaceLocationSearch, useServiceIdentityLoader } from "../filters";
import { getErrorMessage, tryParseJson } from "../format";
import { ObservabilityPageLayout } from "../observability-page-layout";
import {
  OBSERVABILITY_PANE_CLASSES,
  ObservabilityEmptyState,
  ObservabilityLoadingState,
  ObservabilityPaneBody,
  ObservabilityPaneHeader,
  ObservabilityRefreshButton,
  ObservabilitySplitLayout,
  ObservabilityTimeRangeToggle,
  ObservabilityToolbar,
} from "../page-chrome";
import { TelemetryRowLinks } from "../telemetry-row-links";
import {
  DEFAULT_TRACE_PAGE_URL_STATE,
  parseTracePageUrlState,
  serializeTracePageUrlState,
  type TracePageUrlState,
} from "./trace-url-state";

import {
  TRACE_SERVICES_QUERY,
  getRecentTraceRootsQuery,
  getPageViewChildrenQuery,
  getSelectedTraceSpanQuery,
  getSelectedTraceLinksQuery,
  getSelectedTraceEventQuery,
  getSpanDetailQuery,
  PAGE_VIEW_CHILDREN_CAP,
  ROOT_PAGE_SIZE,
  SPAN_DETAIL_COLUMNS,
  SPAN_LINKS_CAP,
  SPAN_TECHNICAL_DETAIL_COLUMNS,
  TRACE_EVENT_WINDOW_SLACK_MS,
  TRACE_SPANS_CAP,
  parseEventRow,
  parseSpanRow,
  parseUniqueSpanRows,
  parseUniqueTraceRootRows,
  parseTraceLinkRows,
  type TraceLink,
  type TraceRootCursor,
  type TraceRootSpan,
} from "./trace-queries";

const SEARCH_DEBOUNCE_MS = 300;

function readInitialTracePageUrlState(): TracePageUrlState {
  if (typeof window === "undefined") return DEFAULT_TRACE_PAGE_URL_STATE;
  return parseTracePageUrlState(new URLSearchParams(window.location.search));
}

function HeaderCountStat({ icon, value, label }: { icon: React.ReactNode, value: number, label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-muted-foreground">
          {icon}
          <span className="font-mono text-[11px] tabular-nums">{value}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const initialUrlState = useState(readInitialTracePageUrlState)[0];

  const [hours, setHours] = useState<TraceTimeRangeHours>(initialUrlState.hours);
  const [service, setService] = useState<ServiceIdentity | null>(initialUrlState.service);
  const [services, setServices] = useState<ServiceIdentity[]>([]);
  const [search, setSearch] = useState(initialUrlState.search);
  const [debouncedSearch] = useDebounce(search.trim(), SEARCH_DEBOUNCE_MS);
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);
  const [linkedSelection, setLinkedSelection] = useState<{ traceId: string, spanId: string | null } | null>(null);
  const [detailRow, setDetailRow] = useState<RowData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pinnedTraceId, setPinnedTraceId] = useState<string | null>(initialUrlState.traceId);
  const [highlightSpanId, setHighlightSpanId] = useState<string | null>(initialUrlState.spanId);
  const [highlightEventType, setHighlightEventType] = useState<string | null>(initialUrlState.eventType);
  const [highlightEventAtMs, setHighlightEventAtMs] = useState<number | null>(initialUrlState.eventAtMs);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const [seedTraceMiss, setSeedTraceMiss] = useState<string | null>(null);

  const [rootSpans, setRootSpans] = useState<TraceRootSpan[]>([]);
  const [expandedPageViewIds, setExpandedPageViewIds] = useState<ReadonlySet<string>>(() => new Set());
  const [childrenByPageViewId, setChildrenByPageViewId] = useState<ReadonlyMap<string, Trace[]>>(() => new Map());
  const [loadingPageViewIds, setLoadingPageViewIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedSpans, setSelectedSpans] = useState<SpanInput[]>([]);
  const [selectedEvents, setSelectedEvents] = useState<EventInput[]>([]);
  const [selectedLinks, setSelectedLinks] = useState<TraceLink[]>([]);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [rootLoading, setRootLoading] = useState(true);
  const [rootLoadingMore, setRootLoadingMore] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [rootLoadMoreError, setRootLoadMoreError] = useState<string | null>(null);
  const [rootCursor, setRootCursor] = useState<TraceRootCursor | null>(null);
  const [hasMoreRoots, setHasMoreRoots] = useState(false);
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceError, setTraceError] = useState<string | null>(null);
  const [traceResultWasCapped, setTraceResultWasCapped] = useState(false);
  const [linksResultWasCapped, setLinksResultWasCapped] = useState(false);
  const [traceVolume, setTraceVolume] = useState<TraceVolumeBucket[]>([]);
  const [traceVolumeLoading, setTraceVolumeLoading] = useState(true);
  const [traceVolumeError, setTraceVolumeError] = useState<string | null>(null);

  const rootRequestSeqRef = useRef(0);
  const rootLoadMoreInFlightRef = useRef(false);
  const traceRequestSeqRef = useRef(0);
  const traceVolumeRequestSeqRef = useRef(0);
  const detailRequestSeqRef = useRef(0);

  const loadTraceServices = useServiceIdentityLoader(adminApp, TRACE_SERVICES_QUERY);

  const loadRoots = useCallback(async () => {
    const seq = ++rootRequestSeqRef.current;
    setRootLoading(true);
    setRootError(null);
    setRootLoadMoreError(null);
    try {
      const rootQuery = getRecentTraceRootsQuery(null, service, debouncedSearch);
      const [recentRootsResponse, nextServices] = await Promise.all([
        queryObservability(adminApp, {
          query: rootQuery.query,
          params: { ...rootQuery.params, hours },
        }),
        loadTraceServices(),
      ]);
      const recentRootRows = recentRootsResponse.result;
      if (seq !== rootRequestSeqRef.current) return;
      const nextRoots = parseUniqueTraceRootRows(recentRootRows);
      setServices(nextServices);
      setService((current) => (
        current == null || nextServices.some((candidate) => serviceIdentityEquals(candidate, current))
          ? current
          : null
      ));
      setRootSpans(nextRoots);
      const lastRoot = nextRoots.at(-1);
      setRootCursor(lastRoot == null ? null : { activityMs: lastRoot.activityMs, id: lastRoot.id });
      setHasMoreRoots(recentRootRows.length === ROOT_PAGE_SIZE);
      const matchingRoot = pinnedTraceId == null
        ? null
        : (nextRoots.find((span) => span.traceId === pinnedTraceId) ?? null);
      setSeedTraceMiss(pinnedTraceId != null && matchingRoot == null ? pinnedTraceId : null);
      setSelectedRootId((currentRootId) => {
        if (matchingRoot != null) return matchingRoot.id;
        if (pinnedTraceId != null) return null;
        if (currentRootId != null && nextRoots.some((span) => span.id === currentRootId)) return currentRootId;
        return nextRoots[0]?.id ?? null;
      });
      setNowMs(Date.now());
    } catch (e) {
      if (seq !== rootRequestSeqRef.current) return;
      setRootError(getErrorMessage(e));
    } finally {
      if (seq === rootRequestSeqRef.current) setRootLoading(false);
    }
  }, [adminApp, debouncedSearch, hours, loadTraceServices, pinnedTraceId, service]);

  const loadTraceVolume = useCallback(async () => {
    const seq = ++traceVolumeRequestSeqRef.current;
    setTraceVolumeLoading(true);
    setTraceVolumeError(null);
    try {
      const volumeQuery = getTraceVolumeQuery(hours, service);
      const response = await queryObservability(adminApp, {
        query: volumeQuery.query,
        params: volumeQuery.params,
      });
      if (seq !== traceVolumeRequestSeqRef.current) return;
      setTraceVolume(parseTraceVolumeRows(response.result));
    } catch (error) {
      if (seq !== traceVolumeRequestSeqRef.current) return;
      setTraceVolumeError(getErrorMessage(error));
    } finally {
      if (seq === traceVolumeRequestSeqRef.current) setTraceVolumeLoading(false);
    }
  }, [adminApp, hours, service]);

  const loadMoreRoots = useCallback(async () => {
    if (!hasMoreRoots || rootCursor == null || rootLoadMoreInFlightRef.current) return;
    rootLoadMoreInFlightRef.current = true;
    const seq = rootRequestSeqRef.current;
    setRootLoadingMore(true);
    setRootLoadMoreError(null);
    try {
      const rootQuery = getRecentTraceRootsQuery(rootCursor, service, debouncedSearch);
      const response = await queryObservability(adminApp, {
        query: rootQuery.query,
        params: { ...rootQuery.params, hours },
      });
      const nextPageRows = response.result;
      if (seq !== rootRequestSeqRef.current) return;
      const nextPage = parseUniqueTraceRootRows(nextPageRows);
      setRootSpans((currentRoots) => parseUniqueTraceRootRows([
        ...currentRoots.map((span) => span.raw),
        ...nextPageRows,
      ]).sort((a, b) => b.activityMs - a.activityMs || stringCompare(b.id, a.id)));
      const lastRoot = nextPage.at(-1);
      setRootCursor(lastRoot == null ? null : { activityMs: lastRoot.activityMs, id: lastRoot.id });
      setHasMoreRoots(response.result.length === ROOT_PAGE_SIZE);
    } catch (error) {
      if (seq !== rootRequestSeqRef.current) return;
      setRootLoadMoreError(getErrorMessage(error));
    } finally {
      rootLoadMoreInFlightRef.current = false;
      if (seq === rootRequestSeqRef.current) setRootLoadingMore(false);
    }
  }, [adminApp, debouncedSearch, hasMoreRoots, hours, rootCursor, service]);

  const requestMoreRoots = useCallback(() => {
    runAsynchronouslyWithAlert(loadMoreRoots);
  }, [loadMoreRoots]);

  const loadSelectedTrace = useCallback(async (traceId: string, focusSpanId: string | null = null) => {
    const seq = ++traceRequestSeqRef.current;
    setTraceLoading(true);
    setTraceError(null);
    try {
      const spanQuery = getSelectedTraceSpanQuery(traceId, focusSpanId);
      const linksQuery = getSelectedTraceLinksQuery(traceId);
      const [spansResponse, linksResponse] = await Promise.all([
        queryObservability(adminApp, {
          query: spanQuery.query,
          params: spanQuery.params,
        }),
        queryObservability(adminApp, linksQuery),
      ]);
      if (seq !== traceRequestSeqRef.current) return;
      const spans = parseUniqueSpanRows(spansResponse.result);
      let events: EventInput[] = [];
      if (spans.length > 0) {
        const loadedAtMs = Date.now();
        const spanStartMs = Math.min(...spans.map((span) => span.startMs));
        const spansResultWasCapped = spansResponse.result.length >= TRACE_SPANS_CAP;
        const spanEndMs = spansResultWasCapped
          ? loadedAtMs
          : Math.max(...spans.map((span) => span.endMs ?? loadedAtMs));
        const eventQuery = getSelectedTraceEventQuery(traceId, highlightEventAtMs, {
          startMs: (highlightEventAtMs == null ? spanStartMs : Math.min(spanStartMs, highlightEventAtMs)) - TRACE_EVENT_WINDOW_SLACK_MS,
          endMs: (highlightEventAtMs == null ? spanEndMs : Math.max(spanEndMs, highlightEventAtMs)) + TRACE_EVENT_WINDOW_SLACK_MS,
        });
        const eventsResponse = await queryObservability(adminApp, {
          query: eventQuery.query,
          params: eventQuery.params,
        });
        if (seq !== traceRequestSeqRef.current) return;
        events = eventsResponse.result
          .map(parseEventRow)
          .filter((event): event is EventInput => event != null);
      }
      setSelectedSpans(spans);
      setSelectedEvents(events);
      setSelectedLinks(parseTraceLinkRows(linksResponse.result));
      setTraceResultWasCapped(spansResponse.result.length >= TRACE_SPANS_CAP);
      setLinksResultWasCapped(linksResponse.result.length > SPAN_LINKS_CAP);
      setNowMs(Date.now());
    } catch (e) {
      if (seq !== traceRequestSeqRef.current) return;
      setTraceError(getErrorMessage(e));
    } finally {
      if (seq === traceRequestSeqRef.current) setTraceLoading(false);
    }
  }, [adminApp, highlightEventAtMs]);

  const lastAutomaticRootLoadRef = useRef<{
    adminApp: typeof adminApp,
    hours: number,
    service: ServiceIdentity | null,
    search: string,
  } | null>(null);
  useEffect(() => {
    // Deliberate dep comparison instead of keying the effect on `loadRoots`:
    // `loadRoots` also depends on `pinnedTraceId`, but changing the selection
    // must not refetch the root list — only filters (app/hours/service/search)
    // should trigger an automatic reload.
    const lastLoad = lastAutomaticRootLoadRef.current;
    if (
      lastLoad?.adminApp === adminApp
      && lastLoad.hours === hours
      && (
        (lastLoad.service == null && service == null)
        || (lastLoad.service != null && service != null && serviceIdentityEquals(lastLoad.service, service))
      )
      && lastLoad.search === debouncedSearch
    ) return;
    lastAutomaticRootLoadRef.current = { adminApp, hours, service, search: debouncedSearch };
    runAsynchronouslyWithAlert(loadRoots);
  }, [adminApp, debouncedSearch, hours, loadRoots, service]);

  useEffect(() => {
    runAsynchronouslyWithAlert(loadTraceVolume);
  }, [loadTraceVolume]);

  const selectedRootTraceId = useMemo(() => (
    selectedRootId == null
      ? null
      : (rootSpans.find((span) => span.id === selectedRootId)?.traceId ?? null)
  ), [rootSpans, selectedRootId]);
  const selectedTraceId = linkedSelection?.traceId ?? pinnedTraceId ?? selectedRootTraceId;
  const selectedTraceServices = useMemo(() => {
    if (selectedRootId == null) return [];
    const selectedRoot = rootSpans.find((span) => span.id === selectedRootId);
    return selectedRoot == null ? [] : serviceIdentitiesFromTraceRow(selectedRoot.raw);
  }, [rootSpans, selectedRootId]);
  const waterfallHighlight = useMemo(() => ({
    spanId: linkedSelection?.spanId ?? highlightSpanId,
    eventType: linkedSelection == null ? highlightEventType : null,
    eventAtMs: linkedSelection == null ? highlightEventAtMs : null,
  }), [highlightEventAtMs, highlightEventType, highlightSpanId, linkedSelection]);

  useEffect(() => {
    replaceLocationSearch(serializeTracePageUrlState({
      hours,
      service,
      search: search.trim(),
      traceId: linkedSelection?.traceId ?? pinnedTraceId,
      spanId: linkedSelection?.spanId ?? (pinnedTraceId == null ? null : highlightSpanId),
      eventType: linkedSelection != null || pinnedTraceId == null ? null : highlightEventType,
      eventAtMs: linkedSelection != null || pinnedTraceId == null ? null : highlightEventAtMs,
    }, readLocationSearch()));
  }, [highlightEventAtMs, highlightEventType, highlightSpanId, hours, linkedSelection, pinnedTraceId, search, service]);

  useEffect(() => {
    if (!shareLinkCopied) return;
    const timeout = window.setTimeout(() => setShareLinkCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [shareLinkCopied]);

  useEffect(() => {
    if (selectedTraceId == null) {
      setSelectedSpans([]);
      setSelectedEvents([]);
      setSelectedLinks([]);
      return;
    }
    runAsynchronouslyWithAlert(loadSelectedTrace(selectedTraceId, linkedSelection?.spanId ?? highlightSpanId));
  }, [highlightSpanId, linkedSelection?.spanId, loadSelectedTrace, selectedTraceId]);

  const { traces: rootTraces } = useMemo(() => buildTraces(rootSpans, []), [rootSpans]);

  const togglePageView = useCallback((pageViewSpanId: string) => {
    setExpandedPageViewIds((previous) => {
      const next = new Set(previous);
      if (next.has(pageViewSpanId)) next.delete(pageViewSpanId);
      else next.add(pageViewSpanId);
      return next;
    });
    if (childrenByPageViewId.has(pageViewSpanId) || loadingPageViewIds.has(pageViewSpanId)) return;
    setLoadingPageViewIds((previous) => new Set(previous).add(pageViewSpanId));
    runAsynchronouslyWithAlert((async () => {
      try {
        const childQuery = getPageViewChildrenQuery(pageViewSpanId);
        const response = await queryObservability(adminApp, childQuery);
        const childSpans = parseUniqueSpanRows(response.result);
        const { traces } = buildTraces(childSpans, []);
        setChildrenByPageViewId((previous) => new Map(previous).set(pageViewSpanId, traces));
      } finally {
        setLoadingPageViewIds((previous) => {
          const next = new Set(previous);
          next.delete(pageViewSpanId);
          return next;
        });
      }
    })());
  }, [adminApp, childrenByPageViewId, loadingPageViewIds]);

  const searchNeedle = search.trim().toLowerCase();

  const { selectedTrace, unattachedEventCount } = useMemo<{ selectedTrace: Trace | null, unattachedEventCount: number }>(() => {
    if (selectedTraceId == null) return { selectedTrace: null, unattachedEventCount: 0 };
    const { traces, unattachedEvents } = buildTraces(selectedSpans, selectedEvents);
    return {
      selectedTrace: linkedSelection?.spanId == null
        ? selectPrimaryTrace(traces, selectedTraceId)
        : traces.find((trace) => traceContainsSpanId(trace, linkedSelection.spanId ?? "")) ?? null,
      unattachedEventCount: unattachedEvents.length,
    };
  }, [linkedSelection, selectedEvents, selectedSpans, selectedTraceId]);

  const openEventDetail = useCallback((raw: RowData) => {
    detailRequestSeqRef.current += 1;
    setDetailLoading(false);
    setDetailRow(raw);
  }, []);

  const openSpanDetail = useCallback(async (span: SpanInput) => {
    const seq = ++detailRequestSeqRef.current;
    setDetailRow(span.raw);
    setDetailLoading(true);
    try {
      const detailQuery = getSpanDetailQuery(span.traceId, span.id);
      const response = await queryObservability(adminApp, {
        query: detailQuery.query,
        params: detailQuery.params,
      });
      if (seq !== detailRequestSeqRef.current) return;
      const detailResult = response.result.at(0);
      if (detailResult == null) {
        throw new Error(`Span ${JSON.stringify(span.id)} no longer exists in trace ${JSON.stringify(span.traceId)}`);
      }
      const parsedDetail = parseSpanRow(detailResult);
      if (parsedDetail == null) {
        throw new Error(`Span detail query returned an invalid row for ${JSON.stringify(span.id)}`);
      }
      setDetailRow(parsedDetail.raw);
    } finally {
      if (seq === detailRequestSeqRef.current) setDetailLoading(false);
    }
  }, [adminApp]);

  const refresh = useCallback(async () => {
    await Promise.all([
      loadRoots(),
      loadTraceVolume(),
      selectedTraceId == null
        ? Promise.resolve()
        : loadSelectedTrace(selectedTraceId, linkedSelection?.spanId ?? highlightSpanId),
    ]);
  }, [highlightSpanId, linkedSelection?.spanId, loadRoots, loadSelectedTrace, loadTraceVolume, selectedTraceId]);

  const headerActions = (
    <TooltipProvider>
      <ObservabilityToolbar
        filters={(
          <DesignSelectorDropdown
            value={serviceIdentityToSelectValue(service)}
            onValueChange={(value) => setService(selectValueToServiceIdentity(value))}
            options={[
              { value: ALL_SERVICES_SELECT_VALUE, label: "All services" },
              ...services.map((identity) => ({
                value: serviceIdentityToSelectValue(identity),
                label: serviceIdentityLabel(identity),
              })),
            ]}
            size="sm"
            disabled={rootLoading}
          />
        )}
        stats={(
          <>
            <HeaderCountStat icon={<TreeStructureIcon className="h-3.5 w-3.5" />} value={rootTraces.length} label={`${rootTraces.length.toLocaleString()} ${rootTraces.length === 1 ? "trace" : "traces"}`} />
            <HeaderCountStat icon={<StackIcon className="h-3.5 w-3.5" />} value={selectedTrace?.spanCount ?? 0} label={`${(selectedTrace?.spanCount ?? 0).toLocaleString()} spans in the selected trace`} />
            <HeaderCountStat icon={<ChartLineIcon className="h-3.5 w-3.5" />} value={selectedTrace?.eventCount ?? 0} label={`${(selectedTrace?.eventCount ?? 0).toLocaleString()} events in the selected trace`} />
            {selectedLinks.length > 0 && (
              <HeaderCountStat icon={<LinkSimpleIcon className="h-3.5 w-3.5" />} value={selectedLinks.length} label={`${selectedLinks.length.toLocaleString()} non-hierarchical span ${selectedLinks.length === 1 ? "link" : "links"} in the selected trace`} />
            )}
          </>
        )}
        range={<ObservabilityTimeRangeToggle hours={hours} onChange={setHours} />}
        actions={(
          <>
            <ObservabilityRefreshButton
              loading={rootLoading || traceLoading || traceVolumeLoading}
              onRefresh={refresh}
            />
            <DesignButton
              className="shrink-0"
              variant="secondary"
              size="sm"
              aria-label={shareLinkCopied ? "Link copied" : "Copy link to this view"}
              title={shareLinkCopied ? "Copied!" : "Copy link to this view"}
              onClick={() => runAsynchronouslyWithAlert(async () => {
                const viewedId = linkedSelection?.traceId ?? pinnedTraceId ?? selectedTraceId;
                if (viewedId != null && pinnedTraceId == null && linkedSelection == null) setPinnedTraceId(viewedId);
                const params = serializeTracePageUrlState({
                  hours,
                  service,
                  search: search.trim(),
                  traceId: viewedId,
                  spanId: linkedSelection?.spanId ?? highlightSpanId,
                  eventType: linkedSelection != null ? null : highlightEventType,
                  eventAtMs: linkedSelection != null ? null : highlightEventAtMs,
                }, new URLSearchParams());
                const query = params.toString();
                await navigator.clipboard.writeText(
                  `${window.location.origin}${window.location.pathname}${query === "" ? "" : `?${query}`}`,
                );
                setShareLinkCopied(true);
              })}
            >
              {shareLinkCopied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
            </DesignButton>
          </>
        )}
      />
    </TooltipProvider>
  );

  return (
    <AppEnabledGuard appId="observability">
      <ObservabilityPageLayout
        title="Traces"
        actions={headerActions}
      >
        {seedTraceMiss != null && (
          <DesignAlert
            variant="info"
            title="That trace isn't in this window"
            description={
              <>
                Nothing in the last {hours}h inbox matches trace{" "}
                <code className="font-mono">{seedTraceMiss}</code>. The waterfall below still
                loads it. Widen the time range, or clear the service filter, to find it in the
                list.
              </>
            }
          />
        )}

        {traceResultWasCapped && !traceLoading && traceError == null && (
          <DesignAlert
            variant="warning"
            title="Selected trace is unusually large"
            description="Showing the earliest 10,000 spans in this trace."
          />
        )}

        {linksResultWasCapped && !traceLoading && traceError == null && (
          <DesignAlert
            variant="warning"
            title="Selected trace has an unusually large number of span links"
            description={`Showing the first ${SPAN_LINKS_CAP.toLocaleString()} span links in this trace; further links exist but are not listed.`}
          />
        )}

        <TraceVolumeChart
          buckets={traceVolume}
          hours={hours}
          loading={traceVolumeLoading}
          error={traceVolumeError}
          onRetry={loadTraceVolume}
        />

        <ObservabilitySplitLayout
          sidebarLabel="Trace list"
          detailLabel="Selected trace waterfall"
          sidebar={(
            <>
              <ObservabilityPaneHeader>
                <DesignInput
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter…"
                  size="sm"
                  className="min-w-0 flex-1"
                />
                {!rootLoading && rootError == null && (
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{rootTraces.length.toLocaleString()}</span>
                )}
              </ObservabilityPaneHeader>
              <ObservabilityPaneBody>
                {rootLoading && <ObservabilityLoadingState label="Loading traces…" />}
                {!rootLoading && rootError != null && (
                  <ErrorDisplay error={rootError} onRetry={loadRoots} />
                )}
                {!rootLoading && rootError == null && rootTraces.length === 0 && (
                  <ObservabilityEmptyState
                    icon={TreeStructureIcon}
                    title={search.trim() !== "" ? "No traces match the filter" : "No spans in this time range"}
                  >
                    {search.trim() === "" && (
                      <pre className="max-w-full overflow-auto rounded-lg bg-muted/30 p-3 text-left font-mono text-[11px] text-muted-foreground">
                        {`const span = app.startSpan("checkout");\nawait span.trackEvent("item_added",\n  { sku: "T-100" });\nawait span.end();`}
                      </pre>
                    )}
                  </ObservabilityEmptyState>
                )}
                {!rootLoading && rootError == null && rootTraces.length > 0 && (
                  <SpanTreeList
                    traces={rootTraces}
                    nowMs={nowMs}
                    activeSpanId={selectedRootId}
                    onSelectSpan={(rootId) => {
                      setLinkedSelection(null);
                      setSelectedRootId(rootId);
                      const root = rootSpans.find((span) => span.id === rootId);
                      setPinnedTraceId(root?.traceId ?? null);
                      setHighlightSpanId(null);
                      setHighlightEventType(null);
                      setHighlightEventAtMs(null);
                    }}
                    expandedPageViewIds={expandedPageViewIds}
                    childrenByPageViewId={childrenByPageViewId}
                    loadingPageViewIds={loadingPageViewIds}
                    onTogglePageView={togglePageView}
                    hasMore={hasMoreRoots}
                    loadingMore={rootLoadingMore}
                    loadMoreError={rootLoadMoreError}
                    onLoadMore={requestMoreRoots}
                  />
                )}
              </ObservabilityPaneBody>
            </>
          )}
          detail={(
            <div className={cn(OBSERVABILITY_PANE_CLASSES, "flex min-h-[420px] min-w-0 flex-1 flex-col overflow-hidden")}>
              {linkedSelection !== null && (
                <div className="flex items-center justify-between gap-3 border-b border-border/50 bg-foreground/[0.03] px-3 py-2">
                  <div className="min-w-0 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Following span link</span>{" "}
                    <span className="font-mono">{(pinnedTraceId ?? selectedRootTraceId)?.slice(0, 8) ?? "trace"}</span>{" → "}
                    <span className="font-mono">{linkedSelection.traceId.slice(0, 8)}/{linkedSelection.spanId?.slice(0, 6) ?? "root"}</span>
                  </div>
                  <DesignButton
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setLinkedSelection(null)}
                  >
                    Back to originating trace
                  </DesignButton>
                </div>
              )}
              {traceLoading && (
                <div className="flex flex-1 items-center justify-center">
                  <ObservabilityLoadingState label="Loading trace…" />
                </div>
              )}
              {!traceLoading && traceError == null && selectedTrace == null && linkedSelection === null && (
                <div className="flex flex-1 items-center justify-center">
                  <ObservabilityEmptyState
                    icon={StackIcon}
                    title="Select a trace to see its waterfall"
                  />
                </div>
              )}
              {!traceLoading && traceError == null && selectedTrace == null && linkedSelection !== null && (
                <div className="p-4">
                  <DesignAlert
                    variant="warning"
                    title="Linked span is unavailable"
                    description="The link was retained, but its same-project target was not found. The linked trace may have been sampled out independently, expired, or not arrived yet."
                  />
                </div>
              )}
              {!traceLoading && traceError == null && selectedTrace != null && (
                <TraceWaterfall
                  trace={selectedTrace}
                  services={linkedSelection === null ? selectedTraceServices : []}
                  nowMs={nowMs}
                  needle={searchNeedle}
                  unattachedEventCount={unattachedEventCount}
                  links={selectedLinks}
                  highlight={waterfallHighlight}
                  onSelectSpan={(span) => {
                    setPinnedTraceId(span.traceId);
                    setHighlightSpanId(span.id);
                    setHighlightEventType(null);
                    setHighlightEventAtMs(null);
                    runAsynchronouslyWithAlert(openSpanDetail(span));
                  }}
                  onSelectEvent={(event) => {
                    setPinnedTraceId(event.traceId ?? selectedTraceId);
                    setHighlightSpanId(event.spanId);
                    setHighlightEventType(event.eventType);
                    setHighlightEventAtMs(event.atMs);
                    openEventDetail(event.raw);
                  }}
                  onOpenLink={(link) => {
                    setLinkedSelection({ traceId: link.linkedTraceId, spanId: link.linkedSpanId });
                  }}
                />
              )}
              {!traceLoading && traceError != null && (
                <div className="flex flex-1 items-center justify-center py-24">
                  <ErrorDisplay
                    error={traceError}
                    onRetry={() => (
                      selectedTraceId == null
                        ? Promise.resolve()
                        : loadSelectedTrace(selectedTraceId)
                    )}
                  />
                </div>
              )}
            </div>
          )}
        />

        <RowDetailDialog
          row={detailRow}
          columns={detailRow != null ? Object.keys(detailRow) : []}
          open={detailRow != null}
          technicalColumns={SPAN_TECHNICAL_DETAIL_COLUMNS}
          loading={detailLoading}
          extraContent={detailRow == null ? null : (
            <>
              <TelemetryRowLinks row={detailRow} projectId={adminApp.projectId} showTrace={false} />
              {/* Fragment children sit directly inside the dialog's space-y-4
                  stack, which keeps the AI section above the raw data field
                  with the standard section spacing. */}
              <AiSpanDetailSection row={detailRow} />
            </>
          )}
          onOpenChange={(open) => {
            if (!open) {
              detailRequestSeqRef.current += 1;
              setDetailLoading(false);
              setDetailRow(null);
            }
          }}
        />
      </ObservabilityPageLayout>
    </AppEnabledGuard>
  );
}
