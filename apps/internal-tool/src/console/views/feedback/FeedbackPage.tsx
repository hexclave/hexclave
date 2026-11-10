"use client";

import type { DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import Link from "next/link";
import { useMemo, useState } from "react";
import { formatPacificTableTime, formatPacificTimestamp } from "../../../lib/pacific-time";
import type { FeedbackLogRow, McpCallLogRow } from "../../../types";
import { toDate } from "../../../utils";
import { useConsoleData } from "../../data/console-data";
import { feedbackTone } from "../../lib/feedback";
import { formatAgo } from "../../lib/format";
import { consoleHref, useQueryParam } from "../../lib/url-state";
import { DetailPanel, PageHeader, SplitView, useListNavigation } from "../../shell/Page";
import { ConnectionGate, FilterBar } from "../../ui/blocks";
import { Icon } from "../../ui/icons";
import { FilterMenu } from "../../ui/overlays";
import { Badge, Button, Card, EmptyState, PropertyList } from "../../ui/primitives";
import { ConsoleTable, rowIdOf, useConsoleTableState } from "../../ui/table";
import { CopyButton } from "../shared/detail";

const COLUMNS: readonly DataGridColumnDef<FeedbackLogRow>[] = [
  {
    id: "time",
    header: "Received",
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
    id: "category",
    header: "Category",
    accessor: row => row.category,
    width: 120,
    minWidth: 96,
    sortable: false,
    renderCell: ({ row }) => <Badge tone={feedbackTone(row.category)}>{row.category}</Badge>,
  },
  {
    id: "message",
    header: "Message",
    accessor: row => row.message,
    width: 520,
    minWidth: 240,
    flex: 1,
    sortable: false,
    renderCell: ({ row }) => <span className="truncate text-[13px] text-foreground">{row.message}</span>,
  },
  {
    id: "conversation",
    header: "Conversation",
    accessor: row => row.conversationId ?? "",
    width: 120,
    minWidth: 96,
    sortable: false,
    renderCell: ({ row }) => row.conversationId == null
      ? <span className="text-xs text-muted-foreground/60">—</span>
      : <span className="text-xs text-muted-foreground">Linked</span>,
  },
  { id: "transport", header: "Transport", accessor: row => row.transport, width: 110, minWidth: 90, sortable: false },
];

const DEFAULT_VISIBLE = new Set(["time", "category", "message", "conversation"]);

export function FeedbackPage() {
  const { feedback, mcp } = useConsoleData();
  const [selectedId, setSelectedId] = useQueryParam("id");
  const [categories, setCategories] = useState<ReadonlySet<string>>(new Set());

  // Categories come from the data: the vocabulary lives in the MCP tool, so the filter never offers
  // one that was never used and never misses one that exists. Rows are newest first by id (a
  // monotonic autoInc, stable for rows written in the same microsecond).
  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of feedback.rows) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => stringCompare(a, b)).map(([value, count]) => ({ value, label: value, count }));
  }, [feedback.rows]);
  const rows = useMemo(() => feedback.rows
    .filter(row => categories.size === 0 || categories.has(row.category))
    .slice()
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)), [feedback.rows, categories]);

  const [tableState, setTableState] = useConsoleTableState(COLUMNS, { visible: DEFAULT_VISIBLE, resetKey: [...categories].sort().join("\u0000") });
  const selectedRow = selectedId == null ? null : feedback.rows.find(row => rowIdOf(row) === selectedId) ?? null;
  const navigation = useListNavigation(rows, selectedId, rowIdOf, setSelectedId);

  return (
    <>
      <PageHeader pageId="feedback" />
      <SplitView
        detail={selectedId != null && (
          <DetailPanel label="Feedback" onClose={() => setSelectedId(null)} {...navigation}>
            {selectedRow == null
              ? <EmptyState icon="search" title="This feedback isn't loaded" description="It may be older than the history loaded in this browser." />
              : <FeedbackDetail key={selectedId} row={selectedRow} mcpRows={mcp.rows} />}
          </DetailPanel>
        )}
      >
        <ConnectionGate state={feedback.connectionState} errorMessage={feedback.connectionErrorMessage} hasRows={feedback.rows.length > 0} source="feedback">
          <FilterBar summary={`${rows.length.toLocaleString()} of ${feedback.rows.length.toLocaleString()}`}>
            <FilterMenu label="Category" options={categoryOptions} selected={categories} onChange={setCategories} />
            {categories.size > 0 && <Button size="xs" variant="ghost" onClick={() => setCategories(new Set())}>Clear</Button>}
          </FilterBar>
          <Card>
            <ConsoleTable
              columns={COLUMNS}
              rows={rows}
              getRowId={rowIdOf}
              state={tableState}
              onStateChange={setTableState}
              onRowClick={row => setSelectedId(rowIdOf(row))}
              activeRowId={selectedId}
              matchRow={(row, query) => row.message.toLowerCase().includes(query) || row.category.toLowerCase().includes(query)}
              searchPlaceholder="Search feedback…"
              history={{ hasMoreHistory: feedback.hasMoreHistory, isLoadingOlder: feedback.isLoadingOlder, onLoadOlder: feedback.loadOlder }}
              exportFilename="mcp-feedback"
              emptyState={<EmptyState icon="feedback" title={feedback.rows.length === 0 ? "No feedback yet" : "No matching feedback"} description="Reports arrive here when agents call give_feedback." />}
            />
          </Card>
        </ConnectionGate>
      </SplitView>
    </>
  );
}

function FeedbackDetail({ row, mcpRows }: { row: FeedbackLogRow, mcpRows: readonly McpCallLogRow[] }) {
  const relatedCall = row.conversationId == null ? undefined : mcpRows.find(call => call.conversationId === row.conversationId);
  return (
    <div className="space-y-5 px-5 py-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Badge tone={feedbackTone(row.category)} dot>{row.category}</Badge>
          <span className="text-xs text-muted-foreground" title={formatPacificTimestamp(toDate(row.createdAt))}>{formatAgo(toDate(row.createdAt))}</span>
        </div>
        <div className="whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-[13px] leading-6 text-foreground">{row.message}</div>
        <CopyButton getText={() => row.message} label="Copy message" />
      </div>

      {row.conversationId != null && (
        <section>
          <p className="mb-2 text-xs font-medium text-foreground">Conversation</p>
          {relatedCall != null ? (
            <Link
              href={consoleHref("/console/mcp", { id: String(relatedCall.id) })}
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-muted hover:transition-none"
            >
              <Icon name="review" className="text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground">{relatedCall.question}</span>
                <span className="block font-mono text-[11px] text-muted-foreground">{relatedCall.toolName}</span>
              </span>
              <Icon name="arrowRight" size="sm" className="text-muted-foreground" />
            </Link>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
              The MCP call for <span className="font-mono">{row.conversationId}</span> isn&apos;t in the loaded history.
            </p>
          )}
        </section>
      )}

      <section>
        <p className="mb-1 text-xs font-medium text-foreground">Request metadata</p>
        <PropertyList items={[
          { label: "Correlation ID", value: row.correlationId, mono: true },
          { label: "Conversation ID", value: row.conversationId ?? "", mono: true, hidden: row.conversationId == null },
          { label: "Transport", value: row.transport },
          { label: "Request IP", value: row.requestIp ?? "", mono: true, hidden: row.requestIp == null },
          { label: "IP source", value: row.requestIpSource ?? "", hidden: row.requestIpSource == null },
          { label: "Request host", value: row.requestHost ?? "", mono: true, hidden: row.requestHost == null },
          { label: "MCP version", value: row.mcpProtocolVersion ?? "", mono: true, hidden: row.mcpProtocolVersion == null },
          { label: "User agent", value: row.userAgent ?? "", mono: true, hidden: row.userAgent == null },
        ]} />
      </section>
    </div>
  );
}
