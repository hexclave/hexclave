"use client";

import type { DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { formatSignedUsd, formatUsd } from "../../../lib/format-usd";
import { formatPacificTableTime, formatPacificTimestamp } from "../../../lib/pacific-time";
import type { AiQueryLogRow } from "../../../types";
import { toDate } from "../../../utils";
import { formatDuration } from "../../lib/format";
import { isCallError } from "../../lib/mcp";
import { latestUserMessage } from "../../lib/transcripts";
import { Badge } from "../../ui/primitives";

export const AI_DEFAULT_VISIBLE = new Set(["createdAt", "inputMessage", "systemPromptId", "modelId", "tokens", "costUsd", "durationMs"]);

const MISSING = "—";

/**
 * Nullable numeric columns sort/export through a sentinel accessor; `formatValue` maps the
 * sentinel back to the same placeholder the cell shows, so a CSV never contains `-1`.
 */
function optionalCount(value: unknown): string {
  return Number(value) < 0 ? MISSING : Number(value).toLocaleString();
}

export const AI_COLUMNS: readonly DataGridColumnDef<AiQueryLogRow>[] = [
  {
    id: "createdAt",
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
    id: "inputMessage",
    header: "Input message",
    accessor: row => latestUserMessage(row),
    width: 360,
    minWidth: 220,
    flex: 1,
    sortable: false,
    renderCell: ({ row }) => {
      const message = latestUserMessage(row);
      return (
        <span className="flex min-w-0 items-center gap-2">
          {isCallError(row) && <Badge tone="red" dot>Error</Badge>}
          {message === ""
            ? <span className="text-xs text-muted-foreground/70">No input message</span>
            : <span className="truncate text-[13px] text-foreground">{message}</span>}
        </span>
      );
    },
  },
  {
    id: "systemPromptId",
    header: "Flow",
    accessor: row => row.systemPromptId,
    width: 220,
    minWidth: 150,
    sortable: false,
    renderCell: ({ row }) => (
      <span className="flex min-w-0 items-center gap-1">
        <Badge tone="violet" mono>{row.systemPromptId}</Badge>
        {row.conversationId != null && <Badge tone="amber">MCP</Badge>}
        {!row.isAuthenticated && <Badge>anon</Badge>}
      </span>
    ),
  },
  {
    id: "modelId",
    header: "Model",
    accessor: row => row.modelId,
    width: 200,
    minWidth: 120,
    sortable: false,
    renderCell: ({ row }) => <span className="truncate font-mono text-[11.5px] text-muted-foreground">{row.modelId}</span>,
  },
  {
    id: "tokens",
    header: "Tokens in / out",
    accessor: row => (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
    width: 140,
    minWidth: 112,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => (
      <span className="font-mono text-xs tabular-nums">
        <span className="text-foreground">{row.inputTokens?.toLocaleString() ?? MISSING}</span>
        <span className="text-muted-foreground"> / {row.outputTokens?.toLocaleString() ?? MISSING}</span>
      </span>
    ),
    formatValue: (_value, row) => `${row.inputTokens ?? MISSING} / ${row.outputTokens ?? MISSING}`,
  },
  {
    id: "cachedInputTokens",
    header: "Cache read",
    accessor: row => row.cachedInputTokens ?? -1,
    width: 104,
    minWidth: 88,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => row.cachedInputTokens != null && row.cachedInputTokens > 0
      ? <span className="font-mono text-xs tabular-nums text-emerald-600 dark:text-emerald-400">{row.cachedInputTokens.toLocaleString()}</span>
      : <span className="text-xs text-muted-foreground/60">{MISSING}</span>,
    formatValue: optionalCount,
  },
  {
    id: "cacheCreationTokens",
    header: "Cache write",
    accessor: row => row.cacheCreationTokens ?? -1,
    width: 104,
    minWidth: 88,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => row.cacheCreationTokens != null && row.cacheCreationTokens > 0
      ? <span className="font-mono text-xs tabular-nums text-orange-600 dark:text-orange-400">{row.cacheCreationTokens.toLocaleString()}</span>
      : <span className="text-xs text-muted-foreground/60">{MISSING}</span>,
    formatValue: optionalCount,
  },
  {
    id: "cacheSavingsUsd",
    header: "Cache $",
    accessor: row => row.cacheDiscountUsd ?? Number.NEGATIVE_INFINITY,
    width: 100,
    minWidth: 84,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => row.cacheDiscountUsd == null
      ? <span className="text-xs text-muted-foreground/60">{MISSING}</span>
      : <span className={`font-mono text-xs tabular-nums ${row.cacheDiscountUsd >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>{formatSignedUsd(row.cacheDiscountUsd)}</span>,
    formatValue: value => Number.isFinite(Number(value)) ? formatSignedUsd(Number(value)) : MISSING,
  },
  {
    id: "costUsd",
    header: "Cost",
    accessor: row => row.costUsd ?? Number.NEGATIVE_INFINITY,
    width: 96,
    minWidth: 80,
    align: "right",
    type: "number",
    sortable: false,
    renderCell: ({ row }) => <span className="font-mono text-xs tabular-nums">{row.costUsd == null ? MISSING : formatUsd(row.costUsd)}</span>,
    formatValue: value => Number.isFinite(Number(value)) ? formatUsd(Number(value)) : MISSING,
  },
  {
    id: "durationMs",
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
  { id: "mode", header: "Mode", accessor: row => row.mode, width: 92, minWidth: 76, sortable: false },
];
