"use client";

import type { DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { hasMcpContextValue } from "../../../lib/mcp-context";
import { formatPacificTableTime, formatPacificTimestamp } from "../../../lib/pacific-time";
import type { McpCallLogRow } from "../../../types";
import { toDate } from "../../../utils";
import { formatAgo, formatDuration } from "../../lib/format";
import { isCallError, qaStatus, qaStatusLabel, qaStatusTone } from "../../lib/mcp";
import { Badge, StatusDot } from "../../ui/primitives";

export const MCP_DEFAULT_VISIBLE = new Set(["time", "question", "user", "tool", "qa", "reviewed", "duration"]);
export const MCP_COLUMN_ORDER = ["time", "question", "user", "tool", "qa", "reviewed", "duration", "status", "steps", "project", "model"];

/**
 * Columns of the MCP review table. `now` is a parameter so the QA column flips pending → failed as
 * the clock advances (see lib/mcp.ts); every column is unsortable because the list is ordered by
 * time and "Load older" appends history to the end of that order.
 */
export function buildMcpColumns(now: number): readonly DataGridColumnDef<McpCallLogRow>[] {
  return [
    {
      id: "time",
      header: "Time",
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
      id: "question",
      header: "Question",
      accessor: row => row.question,
      width: 380,
      minWidth: 220,
      flex: 1,
      sortable: false,
      renderCell: ({ row }) => (
        <div className="min-w-0 py-1">
          <p className="truncate text-[13px] text-foreground">{row.question}</p>
          {row.reason !== "" && <p className="truncate text-[11.5px] text-muted-foreground">{row.reason}</p>}
        </div>
      ),
    },
    {
      id: "user",
      header: "User",
      accessor: row => row.user,
      width: 180,
      minWidth: 120,
      sortable: false,
      renderCell: ({ row }) => hasMcpContextValue(row.user)
        ? <span className="truncate text-xs text-foreground">{row.user}</span>
        : <span className="text-xs text-muted-foreground/70">Unknown</span>,
    },
    {
      id: "tool",
      header: "Tool",
      accessor: row => row.toolName,
      width: 150,
      minWidth: 110,
      sortable: false,
      renderCell: ({ row }) => <Badge tone="violet" mono>{row.toolName}</Badge>,
    },
    {
      id: "qa",
      header: "QA",
      accessor: row => row.qaOverallScore ?? -1,
      width: 110,
      minWidth: 92,
      sortable: false,
      renderCell: ({ row }) => {
        const status = qaStatus(row, now);
        return (
          <span className="flex items-center gap-1.5">
            <Badge tone={qaStatusTone(status)} className="font-mono tabular-nums">{qaStatusLabel(status)}</Badge>
            {row.qaNeedsHumanReview === true && row.humanReviewedAt == null && (
              <span title="Flagged for human review"><StatusDot tone="amber" /></span>
            )}
          </span>
        );
      },
      formatValue: (_value, row) => qaStatusLabel(qaStatus(row, now)),
    },
    {
      id: "reviewed",
      header: "Reviewed",
      accessor: row => row.humanReviewedAt == null ? 0 : toDate(row.humanReviewedAt).getTime(),
      width: 130,
      minWidth: 100,
      sortable: false,
      renderCell: ({ row }) => row.humanReviewedAt == null
        ? <span className="text-xs text-muted-foreground/60">—</span>
        : (
          <span className="truncate text-xs text-emerald-700 dark:text-emerald-400" title={`${formatPacificTimestamp(toDate(row.humanReviewedAt))}${row.humanReviewedBy == null ? "" : ` by ${row.humanReviewedBy}`}`}>
            ✓ {formatAgo(toDate(row.humanReviewedAt))}
          </span>
        ),
      formatValue: (_value, row) => row.humanReviewedAt == null ? "" : formatPacificTimestamp(toDate(row.humanReviewedAt)),
    },
    {
      id: "duration",
      header: "Duration",
      accessor: row => Number(row.durationMs),
      width: 96,
      minWidth: 80,
      align: "right",
      type: "number",
      sortable: false,
      renderCell: ({ row }) => <span className="font-mono text-xs tabular-nums text-muted-foreground">{formatDuration(row.durationMs)}</span>,
      formatValue: value => `${Number(value)}ms`,
    },
    {
      id: "status",
      header: "Status",
      accessor: row => isCallError(row) ? "error" : "ok",
      width: 88,
      minWidth: 72,
      sortable: false,
      renderCell: ({ row }) => isCallError(row) ? <Badge tone="red" dot>Error</Badge> : <span className="text-xs text-muted-foreground">OK</span>,
    },
    { id: "steps", header: "Steps", accessor: row => row.stepCount, width: 72, minWidth: 60, align: "right", type: "number", sortable: false },
    {
      id: "project",
      header: "Project",
      accessor: row => row.project,
      width: 180,
      minWidth: 120,
      sortable: false,
      renderCell: ({ row }) => <span className="truncate text-xs">{hasMcpContextValue(row.project) ? row.project : "—"}</span>,
    },
    {
      id: "model",
      header: "Model",
      accessor: row => row.modelId,
      width: 200,
      minWidth: 120,
      sortable: false,
      renderCell: ({ row }) => <span className="truncate font-mono text-[11.5px]">{row.modelId}</span>,
    },
  ];
}

/** The toolbar search also covers the response and project, which aren't visible columns. */
export function matchesMcpSearch(row: McpCallLogRow, query: string): boolean {
  return [row.question, row.reason, row.response, row.toolName, row.user, row.project, row.correlationId]
    .some(value => value.toLowerCase().includes(query));
}
