"use client";

import type { DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { useRouter } from "next/navigation";
import { useFilteredLogPages } from "../../../hooks/useFilteredLogPages";
import type { McpReviewTableFilters } from "../../../hooks/useSpacetimeDB";
import { featureRequestFromFlagsJson } from "../../../lib/feature-request-flag";
import { hasMcpContextValue } from "../../../lib/mcp-context";
import { formatPacificTableTime, formatPacificTimestamp } from "../../../lib/pacific-time";
import type { McpCallLogRow } from "../../../types";
import { toDate } from "../../../utils";
import { useConsoleData } from "../../data/console-data";
import { consoleHref } from "../../lib/url-state";
import { PageHeader, PageBody } from "../../shell/Page";
import { ConnectionGate } from "../../ui/blocks";
import { Badge, Button, Callout, Card, CardHeader, EmptyState } from "../../ui/primitives";
import { ConsoleTable, rowIdOf, useConsoleTableState } from "../../ui/table";

const FEATURE_REQUEST_FILTERS: McpReviewTableFilters = {
  createdAtOrAfterMicros: undefined,
  toolNames: [],
  hasError: undefined,
  qaStates: ["feature-request"],
  humanReviewStates: [],
};

const COLUMNS: readonly DataGridColumnDef<McpCallLogRow>[] = [
  {
    id: "time",
    header: "Detected",
    accessor: row => toDate(row.createdAt).getTime(),
    width: 150,
    minWidth: 128,
    sortable: false,
    renderCell: ({ row }) => (
      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground" title={formatPacificTimestamp(toDate(row.createdAt))}>
        {formatPacificTableTime(toDate(row.createdAt))}
      </span>
    ),
    formatValue: value => formatPacificTimestamp(new Date(Number(value))),
  },
  {
    id: "featureRequest",
    header: "Capability gap",
    accessor: row => featureRequestFromFlagsJson(row.qaFlagsJson)?.summary ?? row.question,
    width: 380,
    minWidth: 240,
    flex: 1,
    sortable: false,
    renderCell: ({ row }) => {
      const flag = featureRequestFromFlagsJson(row.qaFlagsJson);
      return (
        <div className="min-w-0 py-1">
          <p className="truncate text-[13px] font-medium text-foreground">{flag?.summary ?? row.question}</p>
          {flag != null && <p className="truncate text-[11.5px] text-muted-foreground">{flag.explanation}</p>}
        </div>
      );
    },
  },
  {
    id: "question",
    header: "What the user asked",
    accessor: row => row.question,
    width: 320,
    minWidth: 200,
    flex: 1,
    sortable: false,
    renderCell: ({ row }) => <span className="truncate text-xs text-muted-foreground">{row.question}</span>,
  },
  {
    id: "user",
    header: "User",
    accessor: row => row.user,
    width: 170,
    minWidth: 120,
    sortable: false,
    renderCell: ({ row }) => hasMcpContextValue(row.user)
      ? <span className="truncate text-xs">{row.user}</span>
      : <span className="text-xs text-muted-foreground/70">Unknown</span>,
  },
  {
    id: "tool",
    header: "Tool",
    accessor: row => row.toolName,
    width: 140,
    minWidth: 110,
    sortable: false,
    renderCell: ({ row }) => <Badge tone="violet" mono>{row.toolName}</Badge>,
  },
];

export function FeatureRequestsPage() {
  const { mcp } = useConsoleData();
  const router = useRouter();
  // A snapshot, not a stream: a review that flags a new request while this page is open won't
  // appear until Refresh. Reconnecting re-runs it (connectionState is part of the key).
  const pages = useFilteredLogPages({
    enabled: mcp.connectionState === "connected",
    queryKey: mcp.connectionState,
    filters: FEATURE_REQUEST_FILTERS,
    fetchPage: mcp.queryFilteredPage,
    getRowId: rowIdOf,
  });
  const [tableState, setTableState] = useConsoleTableState(COLUMNS, { resetKey: "feature-requests" });

  return (
    <>
      <PageHeader
        pageId="feature-requests"
        actions={<Button icon="refresh" loading={pages.isLoading} disabled={mcp.connectionState !== "connected"} onClick={pages.refresh}>Refresh</Button>}
      />
      <PageBody>
        <ConnectionGate state={mcp.connectionState} errorMessage={mcp.connectionErrorMessage} hasRows={pages.rows.length > 0} source="feature requests">
          {pages.error != null && <Callout title="Couldn't load feature requests" actions={<Button size="xs" onClick={pages.refresh}>Retry</Button>}>{pages.error}</Callout>}
          <Card>
            <CardHeader
              title="Detected capability gaps"
              description="MCP QA flags a call as a feature request when the user asked for something Hexclave can't do yet. Click a row to open the conversation."
              actions={<Badge>{`${pages.rows.length.toLocaleString()}${pages.hasMore ? "+" : ""} found`}</Badge>}
            />
            <ConsoleTable
              columns={COLUMNS}
              rows={pages.rows}
              getRowId={rowIdOf}
              state={tableState}
              onStateChange={setTableState}
              onRowClick={row => router.push(consoleHref("/console/mcp", { id: rowIdOf(row) }))}
              matchRow={(row, query) => [row.question, row.user, row.toolName, featureRequestFromFlagsJson(row.qaFlagsJson)?.summary ?? ""].some(value => value.toLowerCase().includes(query))}
              searchPlaceholder="Search feature requests…"
              isLoading={pages.isLoading}
              history={{ hasMoreHistory: pages.hasMore, isLoadingOlder: pages.isLoadingMore, onLoadOlder: pages.loadMore }}
              rowHeight={52}
              exportFilename="feature-requests"
              emptyState={<EmptyState icon="lightbulb" title="No feature requests detected" description="Requests appear here after MCP QA verifies an unsupported capability." />}
            />
          </Card>
        </ConnectionGate>
      </PageBody>
    </>
  );
}
