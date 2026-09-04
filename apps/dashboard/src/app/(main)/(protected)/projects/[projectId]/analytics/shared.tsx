"use client";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { SimpleTooltip } from "@/components/ui/simple-tooltip";
import { cn } from "@/lib/utils";
import {
  ArrowClockwiseIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { Alert, AlertDescription, Button } from "@/components/ui";
import { Link } from "@/components/link";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import { PLAN_LIMITS, resolvePlanId } from "@hexclave/shared/dist/plans";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import { Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useAdminApp } from "../use-admin-app";

// ============================================================================
// Types
// ============================================================================

export type RowData = Record<string, Json>;

export type ConfigFolder = {
  displayName: string,
  sortOrder?: number,
  queries: Record<string, {
    displayName: string,
    sqlQuery: string,
    description?: string,
  }>,
};

export type FolderWithId = {
  id: string,
  displayName: string,
  sortOrder: number,
  queries: Array<{
    id: string,
    displayName: string,
    sqlQuery: string,
    description?: string,
  }>,
};

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Detect if a value is a date string (YYYY-MM-DD or YYYY-MM-DD HH:MM:SS format)
 */
export function isDateValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?/.test(value);
}

/**
 * Detect if a value is a JSON object/array
 */
export function isJsonValue(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/**
 * Parse ClickHouse date string as UTC.
 * ClickHouse dates are in UTC but formatted without timezone indicator.
 * e.g., "2026-01-29 02:08:20.970" - need to treat as UTC
 */
export function parseClickHouseDate(value: string): Date {
  const trimmed = value.trim();
  // Handle date-only strings (YYYY-MM-DD) by appending time
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(trimmed + "T00:00:00Z");
  }
  // Replace space with T and append Z to parse as UTC
  const normalized = trimmed.replace(" ", "T") + (trimmed.includes("Z") || trimmed.includes("+") ? "" : "Z");
  return new Date(normalized);
}

// ============================================================================
// Components
// ============================================================================

/**
 * Component for displaying JSON values with optional truncation
 */
export function JsonValue({ value, truncate = true }: { value: unknown, truncate?: boolean }) {
  const formatted = JSON.stringify(value, null, 2);
  const preview = JSON.stringify(value);

  if (truncate && preview.length > 60) {
    return (
      <SimpleTooltip tooltip={<pre className="text-xs max-w-md overflow-auto max-h-64">{formatted}</pre>}>
        <span className="cursor-help text-muted-foreground">
          {preview.slice(0, 57)}...
        </span>
      </SimpleTooltip>
    );
  }

  return <span className="text-muted-foreground">{preview}</span>;
}

/**
 * Format a cell value for display with appropriate rendering based on type.
 * Renders dates using toLocaleString, JSON with preview/truncation, and strings with truncation.
 */
export function CellValue({ value, truncate = true }: { value: unknown, truncate?: boolean }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/50">—</span>;
  }

  if (isDateValue(value)) {
    const date = parseClickHouseDate(value);
    return <span>{date.toLocaleString()}</span>;
  }

  if (isJsonValue(value)) {
    return <JsonValue value={value} truncate={truncate} />;
  }

  const str = String(value);
  if (truncate && str.length > 100) {
    return (
      <SimpleTooltip tooltip={str}>
        <span className="cursor-help">{str.slice(0, 97)}...</span>
      </SimpleTooltip>
    );
  }

  return <span>{str}</span>;
}

/**
 * Dialog for displaying all fields of a single row
 */
export function RowDetailDialog({
  row,
  columns,
  open,
  onOpenChange,
}: {
  row: RowData | null,
  columns: string[],
  open: boolean,
  onOpenChange: (open: boolean) => void,
}) {
  if (!row) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Row Details</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            {columns.map((column) => (
              <div key={column} className="space-y-1">
                <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {column}
                </Label>
                <div className="font-mono text-sm bg-muted/30 rounded px-3 py-2 overflow-auto max-h-48">
                  {isJsonValue(row[column]) ? (
                    <pre className="whitespace-pre-wrap break-all">
                      {JSON.stringify(row[column], null, 2)}
                    </pre>
                  ) : (
                    <CellValue value={row[column]} truncate={false} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Simple virtualized flat table for displaying query results.
 * For tables with sorting/pagination, see the tables page-client.tsx.
 */
export function VirtualizedFlatTable({
  columns,
  rows,
  onRowClick,
}: {
  columns: string[],
  rows: RowData[],
  onRowClick: (row: RowData) => void,
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 10,
  });

  // Column widths - distribute based on content type
  const columnWidths = useMemo(() => {
    const widths = new Map<string, string>();
    columns.forEach((col) => {
      if (col.includes("id") && col !== "project_id") {
        widths.set(col, "minmax(200px, 1fr)");
      } else if (col.includes("_at") || col.includes("date")) {
        widths.set(col, "minmax(100px, 140px)");
      } else if (col === "data" || col.includes("json")) {
        widths.set(col, "minmax(180px, 2fr)");
      } else if (col === "event_type" || col === "type") {
        widths.set(col, "minmax(100px, 160px)");
      } else {
        widths.set(col, "minmax(80px, 1fr)");
      }
    });
    return widths;
  }, [columns]);

  const gridTemplateColumns = columns.map((col) => columnWidths.get(col) ?? "1fr").join(" ");
  const minContentWidth = columns.length * 120;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div
        ref={parentRef}
        className="flex-1 overflow-auto"
      >
        <div style={{ minWidth: `${minContentWidth}px` }}>
          {/* Sticky header */}
          <div
            className="grid gap-3 px-3 py-1.5 border-b border-border/50 bg-muted/40 backdrop-blur-sm sticky top-0 z-10"
            style={{ gridTemplateColumns }}
          >
            {columns.map((column) => (
              <span
                key={column}
                className="font-mono text-xs font-medium text-muted-foreground"
              >
                {column}
              </span>
            ))}
          </div>

          {/* Virtualized rows container */}
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: "100%",
              position: "relative",
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];

              return (
                <div
                  key={virtualRow.index}
                  className={cn(
                    "absolute left-0 right-0 grid gap-3 px-3 items-center cursor-pointer",
                    "border-b border-border/30 hover:bg-muted/30 transition-colors hover:transition-none",
                    virtualRow.index % 2 === 0 ? "bg-transparent" : "bg-muted/10"
                  )}
                  style={{
                    top: `${virtualRow.start}px`,
                    height: `${virtualRow.size}px`,
                    gridTemplateColumns,
                  }}
                  onClick={() => onRowClick(row)}
                >
                  {columns.map((column) => (
                    <div key={column} className="font-mono text-[11px] truncate">
                      <CellValue value={row[column]} />
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Error display component for query errors with retry button
 */
export function ErrorDisplay({ error, onRetry }: { error: unknown, onRetry: () => void | Promise<void> }) {
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-red-500/10 flex items-center justify-center">
        <WarningCircleIcon className="h-7 w-7 text-red-500" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">Query Error</h3>
        <p className="text-xs text-muted-foreground max-w-md break-words font-mono whitespace-pre-wrap">
          {message}
        </p>
      </div>
      <button
        onClick={() => runAsynchronouslyWithAlert(onRetry)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-foreground/[0.06] hover:bg-foreground/[0.1] transition-colors hover:transition-none"
      >
        <ArrowClockwiseIcon className="h-3.5 w-3.5" />
        Retry
      </button>
    </div>
  );
}

/**
 * The plan-limit banners live on core dashboard pages (overview, analytics,
 * session replays) but read the internal project's billing state from
 * bulldozer (plan usage, owned products, item quantities). Billing is not
 * essential to those pages, so a bulldozer outage must not take them down:
 * on any read failure we report it and render nothing rather than letting the
 * error escape to the page. `Suspense` keeps the banner from blocking the page
 * while its data loads.
 */
function BillingBannerErrorFallback({ location, error }: { location: string, error: unknown }) {
  useEffect(() => {
    captureError(location, error);
  }, [location, error]);
  return null;
}

function ResilientBillingBanner(props: { children: ReactNode, location: string }) {
  return (
    <ErrorBoundary errorComponent={({ error }) => <BillingBannerErrorFallback location={props.location} error={error} />}>
      <Suspense fallback={null}>
        {props.children}
      </Suspense>
    </ErrorBoundary>
  );
}

/**
 * Shows a warning banner when analytics event usage is at 80%+ or 100%.
 * Fetches the billing team's analytics_events item and computes usage against the plan's total allocation.
 */
export function AnalyticsEventLimitBanner() {
  return (
    <ResilientBillingBanner location="analytics-limit-banner:billing-read-failed">
      <AnalyticsEventLimitBannerContent />
    </ResilientBillingBanner>
  );
}

function AnalyticsEventLimitBannerContent() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const planUsage = adminApp.usePlanUsage();
  const user = useDashboardInternalUser();
  const teams = user.useTeams();

  const ownerTeam = useMemo(
    () => teams.find(t => t.id === project.ownerTeamId),
    [teams, project.ownerTeamId],
  );

  if (!planUsage.arePlanLimitsEnforced || ownerTeam == null) {
    return null;
  }

  return <AnalyticsEventLimitBannerInner team={ownerTeam} projectId={project.id} />;
}

/**
 * Shows a warning banner when session replay usage is at 80%+ or 100%.
 * Since the limit is the same across all plans, no upgrade button is shown.
 */
export function SessionReplayLimitBanner() {
  return (
    <ResilientBillingBanner location="session-replay-limit-banner:billing-read-failed">
      <SessionReplayLimitBannerContent />
    </ResilientBillingBanner>
  );
}

function SessionReplayLimitBannerContent() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const planUsage = adminApp.usePlanUsage();
  const user = useDashboardInternalUser();
  const teams = user.useTeams();

  const ownerTeam = useMemo(
    () => teams.find(t => t.id === project.ownerTeamId),
    [teams, project.ownerTeamId],
  );

  if (!planUsage.arePlanLimitsEnforced || ownerTeam == null) {
    return null;
  }

  return <SessionReplayLimitBannerInner team={ownerTeam} />;
}

function SessionReplayLimitBannerInner({ team }: { team: { useItem: (itemId: string) => { quantity: number }, useProducts: () => Array<{ id: string | null, type?: string }> } }) {
  const replaysItem = team.useItem("session_replays");
  const products = team.useProducts();
  const planId = resolvePlanId(products);
  const totalAllocation = PLAN_LIMITS[planId].sessionReplays;
  const used = Math.max(0, totalAllocation - replaysItem.quantity);
  const usagePercent = totalAllocation > 0 ? Math.min(100, (used / totalAllocation) * 100) : 0;

  if (usagePercent < 80) {
    return null;
  }

  const isExhausted = replaysItem.quantity <= 0;

  return (
    <Alert
      variant={isExhausted ? "destructive" : "default"}
      className={isExhausted ? undefined : "border-amber-500/50 text-amber-700 dark:text-amber-400 bg-amber-500/5 [&>svg]:text-amber-500"}
    >
      <WarningCircleIcon className="h-4 w-4" />
      <AlertDescription>
        {isExhausted
          ? "You've reached your monthly session replay limit. New session replays are no longer being recorded. Your limit resets next month."
          : "You're approaching your monthly session replay limit."
        }
      </AlertDescription>
    </Alert>
  );
}

function AnalyticsEventLimitBannerInner({ team, projectId }: { team: { useItem: (itemId: string) => { quantity: number }, useProducts: () => Array<{ id: string | null, type?: string }>, createCheckoutUrl: (options: { productId: string, returnUrl: string }) => Promise<string> }, projectId: string }) {
  const eventsItem = team.useItem("analytics_events");
  const products = team.useProducts();
  const planId = resolvePlanId(products);
  const totalAllocation = PLAN_LIMITS[planId].analyticsEvents;
  const used = Math.max(0, totalAllocation - eventsItem.quantity);
  const usagePercent = totalAllocation > 0 ? Math.min(100, (used / totalAllocation) * 100) : 0;

  if (usagePercent < 80) {
    return null;
  }

  const isExhausted = eventsItem.quantity <= 0;
  const canUpgrade = planId !== "growth";

  const handleUpgrade = async () => {
    const targetProduct = planId === "free" ? "team" : "growth";
    const checkoutUrl = await team.createCheckoutUrl({
      productId: targetProduct,
      returnUrl: window.location.href,
    });
    window.location.assign(checkoutUrl);
  };

  return (
    <Alert
      variant={isExhausted ? "destructive" : "default"}
      className={isExhausted ? undefined : "border-amber-500/50 text-amber-700 dark:text-amber-400 bg-amber-500/5 [&>svg]:text-amber-500"}
    >
      <WarningCircleIcon className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>
          {isExhausted
            ? "You've reached your monthly analytics event limit. New events are no longer being tracked. Your limit resets next month."
            : "You're approaching your monthly analytics event limit."
          }
          {canUpgrade && !isExhausted && " Consider upgrading your plan."}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            asChild
          >
            <Link href={`/projects/${projectId}/project-settings/usage`}>
              View usage
            </Link>
          </Button>
          {canUpgrade && (
            <Button
              size="sm"
              variant={isExhausted ? "destructive" : "outline"}
              onClick={handleUpgrade}
            >
              Upgrade plan
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
