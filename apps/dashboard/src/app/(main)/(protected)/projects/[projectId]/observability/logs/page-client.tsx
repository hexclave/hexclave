"use client";

import { Link } from "@/components/link";
import { DesignButton, DesignSelectorDropdown } from "@/components/design-components";
import { Button } from "@/components/ui";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { ArrowClockwiseIcon, ListMagnifyingGlassIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { useAdminApp } from "../../use-admin-app";
import { RowDetailDialog } from "../../analytics/shared";
import {
  QueryDataGrid,
  type QueryDataGridColumnConfig,
  type QueryDataGridToolbarContext,
} from "../../analytics/tables/query-data-grid";
import type { RowData } from "../../analytics/shared";
import {
  parseServiceIdentityRow,
  selectValueToServiceIdentity,
  serviceIdentityEquals,
  serviceIdentityLabel,
  serviceIdentityToSelectValue,
  type ServiceIdentity,
} from "../service-identity";
import { ALL_SERVICES_SELECT_VALUE, isObservabilityTimeRangeHours, readLocationSearch, replaceLocationSearch, useServiceIdentityLoader, type ObservabilityTimeRangeHours } from "../filters";
import { tryParseJson } from "../format";
import { LogLevelChip } from "../log-level";
import { issueSearchHref } from "../issues/issue-links";
import { ObservabilityPageLayout } from "../observability-page-layout";
import { ObservabilityEmptyState, ObservabilityToolbar, ObservabilityTimeRangeToggle } from "../page-chrome";
import { TelemetryRowLinks } from "../telemetry-row-links";
import {
  DEFAULT_LOG_TIME_RANGE_HOURS,
  LOG_LEVELS,
  parseLogFilters,
  serializeLogFilters,
  type LogLevel,
} from "./log-filters";

export { DEFAULT_LOG_TIME_RANGE_HOURS, LOG_LEVELS, type LogLevel };

const ALL_LEVELS_SELECT_VALUE = "all";

export function selectValueToLogLevel(value: string): LogLevel | null {
  if (value === ALL_LEVELS_SELECT_VALUE) return null;
  const level = LOG_LEVELS.find((candidate) => candidate === value);
  if (level == null) throw new Error(`Unexpected log level select value: ${value}`);
  return level;
}

export const LOG_SERVICES_QUERY = `
SELECT service_namespace, service_name
FROM default.logs
WHERE 1 = 1
  AND service_name IS NOT NULL
  AND service_name != ''
GROUP BY service_namespace, service_name
ORDER BY service_namespace ASC, service_name ASC
LIMIT 500
`;

export function getLogsQuery(
  hours: number,
  level: LogLevel | null = null,
  service: ServiceIdentity | null = null,
): {
  query: string,
  params: Record<string, string | number>,
} {
  if (!isObservabilityTimeRangeHours(hours)) {
    throw new Error(`Unknown logs time range: ${hours}`);
  }
  if (level != null && !LOG_LEVELS.includes(level)) {
    throw new Error(`Unknown log level: ${level}`);
  }
  const params: Record<string, string | number> = {};
  if (service != null) {
    params.serviceNamespace = service.namespace;
    params.serviceName = service.name;
  }
  const levelExpression = "coalesce(nullIf(e.level, ''), nullIf(lowerUTF8(e.severity_text), ''), '')";
  const levelCondition = level == null ? "" : `\n  AND ${levelExpression} = '${level}'`;
  const serviceCondition = service == null ? "" : `
  AND coalesce(e.service_namespace, '') = {serviceNamespace:String}
  AND e.service_name = {serviceName:String}`;
  return {
    query: `
SELECT
  e.event_at,
  ${levelExpression} AS level,
  if(JSONExtractString(toString(e.body), 'type') = 'string', JSONExtractString(toString(e.body), 'value'), toString(e.body)) AS message,
  e.service_namespace,
  e.service_name,
  e.deployment_environment_name,
  e.user_id,
  u.display_name AS user_display_name,
  u.primary_email AS user_primary_email,
  e.data,
  e.trace_id,
  e.span_id,
  e.session_replay_id,
  e.session_replay_segment_id,
  e.refresh_token_id
FROM default.logs AS e
LEFT JOIN default.users AS u ON toString(u.id) = e.user_id
WHERE e.event_at >= now64(3) - INTERVAL ${hours} HOUR${levelCondition}${serviceCondition}
`,
    params,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function userLabel(row: RowData): string | null {
  const userId = stringOrNull(row.user_id);
  if (userId == null) return null;
  return stringOrNull(row.user_display_name) ?? stringOrNull(row.user_primary_email) ?? userId;
}

const LOG_COLUMN_CONFIGS = new Map<string, QueryDataGridColumnConfig>([
  ["event_at", { header: "Time", width: 170 }],
  ["level", {
    header: "Level",
    width: 90,
    renderCell: (value) => <LogLevelChip level={typeof value === "string" ? value : ""} />,
  }],
  ["message", {
    header: "Message",
    width: 320,
    flex: 1,
    renderCell: (value) => {
      const message = stringOrNull(value);
      if (message == null) return <span className="text-muted-foreground/50">—</span>;
      return <span className="block truncate font-mono text-xs" title={message}>{message}</span>;
    },
  }],
  ["service_name", {
    header: "Service",
    width: 140,
    renderCell: (_value, row) => {
      const service = parseServiceIdentityRow(row);
      const label = serviceIdentityLabel(service);
      return <span className="block truncate text-xs" title={label}>{label}</span>;
    },
  }],
  ["service_namespace", { hidden: true }],
  ["deployment_environment_name", { header: "Environment", width: 130 }],
  ["user_id", {
    header: "User",
    width: 200,
    renderCell: (_value, row) => {
      const label = userLabel(row);
      if (label == null) return <span className="text-muted-foreground/50">—</span>;
      return <span className="block truncate text-xs" title={label}>{label}</span>;
    },
  }],
  ["data", { hidden: true }],
  ["trace_id", { hidden: true }],
  ["span_id", { hidden: true }],
  ["session_replay_id", { hidden: true }],
  ["session_replay_segment_id", { hidden: true }],
  ["refresh_token_id", { hidden: true }],
  ["user_display_name", { hidden: true }],
  ["user_primary_email", { hidden: true }],
]);

const LOG_DETAIL_MAIN_COLUMNS = [
  "message",
  "level",
  "event_at",
  "service_namespace",
  "service_name",
  "deployment_environment_name",
  "user_id",
  "data",
] as const;
export const LOG_DETAIL_TECHNICAL_COLUMNS = [
  "trace_id",
  "span_id",
  "session_replay_id",
  "session_replay_segment_id",
  "refresh_token_id",
] as const;

function LogDetailExtraContent({ row, projectId }: { row: RowData, projectId: string }) {
  const userId = stringOrNull(row.user_id);
  const data = tryParseJson(row.data);
  const fingerprint = typeof data === "object" && data != null && "error_fingerprint" in data
    ? stringOrNull(data.error_fingerprint)
    : null;
  const message = stringOrNull(row.message);

  if (userId == null && fingerprint == null && stringOrNull(row.trace_id) == null && stringOrNull(row.session_replay_id) == null) {
    return null;
  }

  return (
    <div className="space-y-3">
      {fingerprint != null && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-red-500/5 px-3 py-2 text-xs ring-1 ring-red-500/20">
          <span className="font-medium text-red-700 dark:text-red-400">Error fingerprint:</span>
          <code className="font-mono text-foreground">{fingerprint}</code>
          {message != null && (
            <Button size="sm" variant="outline" asChild className="ml-auto h-6 px-2 text-[11px]">
              <Link href={issueSearchHref(projectId, message)}>View issue</Link>
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {userId != null && (
          <Button size="sm" variant="outline" asChild>
            <Link href={`/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}`}>
              View user
            </Link>
          </Button>
        )}
        <TelemetryRowLinks row={row} projectId={projectId} />
      </div>
    </div>
  );
}

function LogsEmptyState({ filterActive }: { filterActive: boolean }) {
  return (
    <ObservabilityEmptyState
      icon={ListMagnifyingGlassIcon}
      title={filterActive ? "No matching logs" : "No logs yet"}
      description={filterActive
        ? "No logs match the selected filters in this time range. Clear a filter or widen the range."
        : <>
          Logs appear automatically once your app uses the SDK — console
          warnings and errors are captured with no setup. Log explicitly with{" "}
          <code className="rounded bg-foreground/[0.05] px-1 py-0.5 font-mono text-xs text-foreground">
            app.logger.info(...)
          </code>
          .
        </>}
    />
  );
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const initialFilters = useState(() => parseLogFilters(
    typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search),
  ))[0];
  const [hours, setHours] = useState<ObservabilityTimeRangeHours>(initialFilters.hours);
  const [level, setLevel] = useState<LogLevel | null>(initialFilters.level);
  const [service, setService] = useState<ServiceIdentity | null>(initialFilters.service);
  const [services, setServices] = useState<ServiceIdentity[]>([]);
  const [servicesLoading, setServicesLoading] = useState(true);
  const [detailRow, setDetailRow] = useState<RowData | null>(null);
  const logsQuery = useMemo(() => getLogsQuery(hours, level, service), [hours, level, service]);

  useEffect(() => {
    replaceLocationSearch(serializeLogFilters({ hours, level, service }, readLocationSearch()));
  }, [hours, level, service]);

  const loadLogServices = useServiceIdentityLoader(adminApp, LOG_SERVICES_QUERY);

  useEffect(() => {
    let cancelled = false;
    setServicesLoading(true);
    runAsynchronouslyWithAlert(async () => {
      try {
        const nextServices = await loadLogServices();
        if (cancelled) return;
        setServices(nextServices);
        setService((current) => (
          current == null || nextServices.some((candidate) => serviceIdentityEquals(candidate, current))
            ? current
            : null
        ));
      } finally {
        if (!cancelled) setServicesLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadLogServices]);

  const refreshLogsAndServices = useCallback(async (reloadLogs: () => void) => {
    reloadLogs();
    const nextServices = await loadLogServices(true);
    setServices(nextServices);
    setService((current) => (
      current == null || nextServices.some((candidate) => serviceIdentityEquals(candidate, current))
        ? current
        : null
    ));
  }, [loadLogServices]);

  const renderToolbarExtra = useCallback(
    (context: QueryDataGridToolbarContext<RowData>) => (
      <span className="hidden h-[22px] shrink-0 items-center rounded-full bg-foreground/[0.04] px-2 text-[10px] tabular-nums text-muted-foreground ring-1 ring-foreground/[0.06] sm:inline-flex">
        {context.hasMore
          ? `${context.rowCount.toLocaleString()}+ logs`
          : `${context.rowCount.toLocaleString()} logs`}
      </span>
    ),
    [],
  );

  const renderToolbarActions = useCallback(
    (context: QueryDataGridToolbarContext<RowData>) => (
      <DesignButton
        variant="ghost"
        size="sm"
        loading={context.isRefetching}
        onClick={() => refreshLogsAndServices(context.reload)}
        className="gap-1.5"
      >
        <ArrowClockwiseIcon className="h-3.5 w-3.5" />
        Refresh
      </DesignButton>
    ),
    [refreshLogsAndServices],
  );

  const detailColumns = useMemo(() => {
    if (detailRow == null) return [];
    return [...LOG_DETAIL_MAIN_COLUMNS, ...LOG_DETAIL_TECHNICAL_COLUMNS]
      .filter((column) => column in detailRow);
  }, [detailRow]);

  return (
    <AppEnabledGuard appId="observability">
      <ObservabilityPageLayout
        title="Logs"
        actions={(
          <ObservabilityToolbar
            filters={(
              <>
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
                  disabled={servicesLoading}
                />
                <DesignSelectorDropdown
                  value={level ?? ALL_LEVELS_SELECT_VALUE}
                  onValueChange={(value) => setLevel(selectValueToLogLevel(value))}
                  options={[
                    { value: ALL_LEVELS_SELECT_VALUE, label: "All levels" },
                    ...LOG_LEVELS.map((candidate) => ({
                      value: candidate,
                      label: candidate.charAt(0).toUpperCase() + candidate.slice(1),
                    })),
                  ]}
                  size="sm"
                />
              </>
            )}
            range={<ObservabilityTimeRangeToggle hours={hours} onChange={setHours} />}
          />
        )}
      >
        <QueryDataGrid
          query={logsQuery.query}
          queryParams={logsQuery.params}
          mode="one-shot"
          defaultOrderBy="event_at"
          defaultOrderDir="desc"
          columnConfigs={LOG_COLUMN_CONFIGS}
          onRowClick={setDetailRow}
          toolbarExtra={renderToolbarExtra}
          toolbarActions={renderToolbarActions}
          exportFilename="logs-export"
          emptyState={<LogsEmptyState filterActive={level != null || service != null} />}
          fillHeight={false}
          horizontalScrollbarPosition="top"
        />

        <RowDetailDialog
          row={detailRow}
          columns={detailColumns}
          open={detailRow != null}
          onOpenChange={(open) => {
            if (!open) setDetailRow(null);
          }}
          title="Log details"
          technicalColumns={LOG_DETAIL_TECHNICAL_COLUMNS}
          extraContent={detailRow == null ? null : (
            <LogDetailExtraContent row={detailRow} projectId={adminApp.projectId} />
          )}
        />
      </ObservabilityPageLayout>
    </AppEnabledGuard>
  );
}
