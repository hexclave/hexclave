"use client";

import { Link } from "@/components/link";
import { DesignSelectorDropdown } from "@/components/design-components/select";
import { Button, Typography } from "@/components/ui";
import { cn } from "@/lib/utils";
import { ArrowClockwiseIcon, CodeIcon } from "@phosphor-icons/react";
import type { AppId } from "@hexclave/shared/dist/apps/apps-config";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { useCallback, useEffect, useState } from "react";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";
import { AnalyticsEventLimitBanner } from "../shared";
import { replaceLocationSearch } from "../../observability/filters";
import { TelemetryRowLinks } from "../../observability/telemetry-row-links";
import {
  QueryDataGrid,
  type QueryDataGridMode,
} from "./query-data-grid";
import { TableSearchBar } from "./table-search-bar";
import { useAiTableFilterChat } from "./use-ai-table-filter-chat";

// ─── Available tables ───────────────────────────────────────────────

type TableConfig = {
  displayName: string,
  baseQuery: string,
  defaultOrderBy: string,
  defaultOrderDir: "asc" | "desc",
};

export type TableId = string;

const AVAILABLE_TABLES = new Map<TableId, TableConfig>([
  [
    "events",
    {
      displayName: "Events",
      baseQuery: "SELECT * FROM default.events",
      defaultOrderBy: "event_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "spans",
    {
      displayName: "Spans",
      baseQuery: "SELECT * FROM default.spans",
      defaultOrderBy: "started_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "logs",
    {
      displayName: "Logs",
      baseQuery: "SELECT * FROM default.logs",
      defaultOrderBy: "event_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "errors",
    {
      displayName: "Errors",
      baseQuery: "SELECT * FROM default.errors",
      defaultOrderBy: "event_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "users",
    {
      displayName: "Users",
      baseQuery: "SELECT * FROM default.users",
      defaultOrderBy: "signed_up_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "contact_channels",
    {
      displayName: "Contact Channels",
      baseQuery: "SELECT * FROM default.contact_channels",
      defaultOrderBy: "created_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "teams",
    {
      displayName: "Teams",
      baseQuery: "SELECT * FROM default.teams",
      defaultOrderBy: "created_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "team_member_profiles",
    {
      displayName: "Team Member Profiles",
      baseQuery: "SELECT * FROM default.team_member_profiles",
      defaultOrderBy: "created_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "team_permissions",
    {
      displayName: "Team Permissions",
      baseQuery: "SELECT * FROM default.team_permissions",
      defaultOrderBy: "created_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "team_invitations",
    {
      displayName: "Team Invitations",
      baseQuery: "SELECT * FROM default.team_invitations",
      defaultOrderBy: "created_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "email_outboxes",
    {
      displayName: "Email Outboxes",
      baseQuery: "SELECT * FROM default.email_outboxes",
      defaultOrderBy: "created_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "project_permissions",
    {
      displayName: "Project Permissions",
      baseQuery: "SELECT * FROM default.project_permissions",
      defaultOrderBy: "created_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "notification_preferences",
    {
      displayName: "Notification Preferences",
      baseQuery: "SELECT * FROM default.notification_preferences",
      defaultOrderBy: "user_id",
      defaultOrderDir: "desc",
    },
  ],
  [
    "refresh_tokens",
    {
      displayName: "Refresh Tokens",
      baseQuery: "SELECT * FROM default.refresh_tokens",
      defaultOrderBy: "created_at",
      defaultOrderDir: "desc",
    },
  ],
  [
    "connected_accounts",
    {
      displayName: "Connected Accounts",
      baseQuery: "SELECT * FROM default.connected_accounts",
      defaultOrderBy: "created_at",
      defaultOrderDir: "desc",
    },
  ],
]);

const AVAILABLE_TABLE_OPTIONS = [...AVAILABLE_TABLES.entries()].map(
  ([value, config]) => ({ value, label: config.displayName }),
);

const TELEMETRY_TABLE_IDS = new Set(["events", "spans", "logs", "errors"]);

const TELEMETRY_DETAIL_TECHNICAL_COLUMNS = [
  "trace_id",
  "span_id",
  "parent_span_id",
  "page_view_span_id",
  "session_replay_id",
  "session_replay_segment_id",
  "refresh_token_id",
] as const;

function readInitialTableId(): TableId {
  if (typeof window === "undefined") return "events";
  const raw = new URLSearchParams(window.location.search).get("table");
  if (raw != null && AVAILABLE_TABLES.has(raw)) return raw;
  return "events";
}

// ─── Per-table content ──────────────────────────────────────────────

export function TableContent({ tableId }: { tableId: TableId }) {
  const adminApp = useAdminApp();
  const tableConfig = AVAILABLE_TABLES.get(tableId) ?? throwErr(`Unknown analytics table: ${tableId}`);

  // AI thread behind the search bar — constrained to row filters over this
  // table, so the grid's columns never change.
  const filterChat = useAiTableFilterChat(tableId);

  const filterQuery = filterChat.latestQuery;

  const effectiveQuery = filterQuery ?? tableConfig.baseQuery;
  const effectiveMode: QueryDataGridMode = filterQuery != null ? "one-shot" : "paginated";

  const renderToolbarExtra = useCallback(
    (ctx: { rowCount: number, hasMore: boolean }) => (
      <span className="hidden h-[22px] shrink-0 items-center rounded-full bg-foreground/[0.04] px-2 text-[10px] tabular-nums text-muted-foreground ring-1 ring-foreground/[0.06] sm:inline-flex">
        {ctx.hasMore
          ? `${ctx.rowCount.toLocaleString()}+ rows`
          : `${ctx.rowCount.toLocaleString()} rows`}
      </span>
    ),
    [],
  );

  const renderToolbarActions = useCallback(
    (ctx: { reload: () => void }) => (
      <Button
        variant="ghost"
        onClick={ctx.reload}
        className="h-7 gap-1.5 px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
        title="Refresh"
      >
        <ArrowClockwiseIcon className="h-3.5 w-3.5" />
        Refresh
      </Button>
    ),
    [],
  );

  return (
    // fillHeight grid owns its own scrollport below the page header, so rows never
    // paint under the sticky translucent header (the dark-mode seam bug).
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <QueryDataGrid
        query={effectiveQuery}
        mode={effectiveMode}
        defaultOrderBy={tableConfig.defaultOrderBy}
        defaultOrderDir={tableConfig.defaultOrderDir}
        searchBar={(ctx) => (
          <TableSearchBar
            ctx={ctx}
            queryKey={effectiveQuery}
            chat={filterChat}
            activeFilterQuery={filterQuery}
            filterRejected={filterChat.filterRejected}
            onAiSubmit={(text) => filterChat.sendMessage({ text })}
            onClearFilter={filterChat.clearMessages}
          />
        )}
        toolbarExtra={renderToolbarExtra}
        toolbarActions={renderToolbarActions}
        exportFilename={`${tableId}-export`}
        fillHeight
        stickyTop={0}
        horizontalScrollbarPosition="top"
        detailTitle={`${tableConfig.displayName} details`}
        detailTechnicalColumns={TELEMETRY_TABLE_IDS.has(tableId) ? TELEMETRY_DETAIL_TECHNICAL_COLUMNS : undefined}
        detailExtraContent={TELEMETRY_TABLE_IDS.has(tableId)
          ? (row) => <TelemetryRowLinks row={row} projectId={adminApp.projectId} />
          : undefined}
      />
    </div>
  );
}

export default function PageClient({ appId }: { appId: AppId }) {
  const [selectedTable, setSelectedTable] = useState<TableId | null>(readInitialTableId);

  useEffect(() => {
    if (selectedTable == null) return;
    const params = new URLSearchParams(typeof window === "undefined" ? "" : window.location.search);
    if (selectedTable === "events") params.delete("table");
    else params.set("table", selectedTable);
    replaceLocationSearch(params);
  }, [selectedTable]);

  return (
    <AppEnabledGuard appId={appId}>
      {/* containedHeight: page fills the shell under the header and scrolls internally,
          so table rows cannot travel behind the floating dark-mode header. */}
      <PageLayout fillWidth noPadding containedHeight>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0">
            <AnalyticsEventLimitBanner />
          </div>

          <div className="shrink-0 px-3 py-2 lg:hidden">
            <label htmlFor="analytics-table-selector" className="sr-only">
              Table
            </label>
            <DesignSelectorDropdown
              value={selectedTable ?? "events"}
              onValueChange={setSelectedTable}
              options={AVAILABLE_TABLE_OPTIONS}
              placeholder="Select a table"
              size="sm"
              triggerId="analytics-table-selector"
            />
          </div>

          {/* Dark: match the primary nav's rounded-2xl so the gap junction mirrors
              the same radius on both sides (nav top-right ↔ tables top-left).
              Light: only round the left edge — the shell card already owns the
              top-right radius, so an inner tr curve reads as a stray notch. */}
          <div className="flex min-h-0 flex-1 overflow-hidden rounded-l-2xl dark:rounded-tr-2xl lg:-ml-px">
            {/* Use the same surface treatment as the primary sidebar so equal radii render
                identically. Omit the right border to keep the sidebar/grid junction divider-free. */}
            <div className="hidden w-48 min-h-0 flex-shrink-0 flex-col overflow-hidden rounded-l-2xl bg-black/[0.03] dark:border dark:border-r-0 dark:border-foreground/5 dark:bg-foreground/5 dark:backdrop-blur-2xl dark:shadow-sm lg:flex">
              <div className="min-h-0 flex-1 overflow-y-auto pl-2">
                <div className="min-h-full px-4 py-4">
                  <Typography className="px-3 mb-3 text-xs font-semibold uppercase tracking-wide text-foreground/70">
                    Tables
                  </Typography>
                  <div className="space-y-1">
                    {[...AVAILABLE_TABLES.entries()].map(([id, config]) => (
                      <button
                        key={id}
                        onClick={() => setSelectedTable(id)}
                        className={cn(
                        "w-full text-left px-3 py-2 rounded-md text-sm transition-colors hover:transition-none",
                        selectedTable === id
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                      >
                        {config.displayName}
                      </button>
                    ))}
                  </div>

                  <Link
                    href="./queries"
                    className="mt-4 flex items-center gap-2 border-t border-border/50 px-3 pt-4 py-2 rounded-md text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors hover:transition-none w-full"
                  >
                    <CodeIcon className="h-4 w-4" />
                    Queries
                  </Link>
                </div>
              </div>
            </div>

            {/* Right content — grid fills remaining height and scrolls internally.
                Sticky chrome is its own composited layer and paints square over a
                parent's overflow:hidden radius, so dark mode clips the panel itself.
                Below lg the tables sidebar is hidden and the grid owns both top
                corners; at lg+ the sidebar owns the left radius. */}
            <div
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
                "[&_[role=grid]]:rounded-none",
                "[&_[role=grid]_.sticky]:rounded-none",
                // Toolbar row only (first child of sticky chrome) — analytics layout
                "[&_[role=grid]_.sticky>div:first-child>div]:pt-3",
                "[&_[role=grid]_.sticky>div:first-child>div]:pb-2.5",
                "[&_[role=grid]_.sticky>div:first-child>div]:pr-3",
                "[&_[role=grid]_.sticky>div:first-child>div]:pl-2.5",
                "max-lg:dark:rounded-t-2xl max-lg:dark:[clip-path:inset(0_round_1rem_1rem_0_0)]",
                "lg:dark:rounded-tr-2xl lg:dark:[clip-path:inset(0_round_0_1rem_0_0)]",
              )}
            >
              {selectedTable ? (
                <TableContent key={selectedTable} tableId={selectedTable} />
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <Typography variant="secondary">
                    Select a table to view its contents
                  </Typography>
                </div>
              )}
            </div>
          </div>
        </div>
      </PageLayout>
    </AppEnabledGuard>
  );
}
