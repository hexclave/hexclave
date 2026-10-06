"use client";

import { Link } from "@/components/link";
import { DesignBadge, DesignButton, DesignMenu } from "@/components/design-components";
import { SimpleTooltip } from "@/components/ui/simple-tooltip";
import { cn } from "@/lib/utils";
import type { DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { EventSparkline, type EventSparklineBucket } from "../event-sparkline";
import { formatAbsoluteTimeFromMillis, formatRelativeTimeFromMillis } from "../format";
import { formatIssueCount, issueCulprit, issueShortIdLabel, issueSubtitle, issueTitle } from "./issue-format";
import { issueDetailHref } from "./issue-links";
import {
  issueStatusBadge,
  nextStatusForAction,
  primaryIssueStatusAction,
  resolveIssueRowStatus,
  type IssueStatusOverrides,
} from "./issue-status";
import type { ObservabilityTimeRangeHours } from "../filters";
import type { IssueListItem, IssueStatus } from "./issues-data";


export type IssueCellContext = {
  projectId: string,
  rangeHours: ObservabilityTimeRangeHours,
  nowMs: number,
  overrides: IssueStatusOverrides,
  sparklinesByHash: ReadonlyMap<string, readonly EventSparklineBucket[]>,
  bucketLabel: string,
  onChangeStatus: (issue: IssueListItem, status: IssueStatus) => Promise<void>,
};

function HeaderWithTooltip({ label, tooltip }: { label: string, tooltip: string }) {
  return (
    <SimpleTooltip tooltip={tooltip}>
      <span className="cursor-help">{label}</span>
    </SimpleTooltip>
  );
}

function IssueCell({ issue, context }: { issue: IssueListItem, context: IssueCellContext }) {
  const title = issueTitle(issue);
  const subtitle = issueSubtitle(issue);
  const culprit = issueCulprit({ culprit: issue.culprit });
  const { status, isOptimistic } = resolveIssueRowStatus(issue, context.overrides);
  const badge = issueStatusBadge({ status, substatus: issue.substatus });

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col justify-center gap-0.5 py-1",
        issue.substatus === "regressed" && "border-l-2 border-amber-500 pl-2 -ml-2",
        isOptimistic && status !== "unresolved" && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-baseline gap-1.5">
        <Link
          href={issueDetailHref(context.projectId, issue.id, { rangeHours: context.rangeHours })}
          className="truncate text-[13px] font-semibold text-foreground hover:underline"
          title={title}
        >
          {title}
        </Link>
        {subtitle !== "" && (
          <span className="truncate text-xs text-muted-foreground" title={subtitle}>{subtitle}</span>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-[11px] text-muted-foreground/80" title={culprit}>
          {culprit}
        </span>
        {badge != null && <DesignBadge label={badge.label} color={badge.color} size="sm" />}
        {!issue.handled && <DesignBadge label="Unhandled" color="red" size="sm" />}
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/60">
          {issueShortIdLabel(issue.short_id)}
        </span>
      </div>
    </div>
  );
}

function GraphCell({ issue, context }: { issue: IssueListItem, context: IssueCellContext }) {
  const series = issue.issue_hashes.map((hash) => context.sparklinesByHash.get(hash));
  const pending = series.some((entry) => entry == null);
  const merged = new Map<string | number, number>();
  if (!pending) {
    for (const buckets of series) {
      for (const bucket of buckets ?? []) {
        merged.set(bucket.key, (merged.get(bucket.key) ?? 0) + bucket.value);
      }
    }
  }
  const buckets = [...merged.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([key, value]) => ({ key, value }));

  return (
    <EventSparkline
      buckets={buckets}
      pending={pending}
      tone="error"
      ariaLabel={`${issue.window_occurrences.toLocaleString()} occurrences, ${context.bucketLabel}`}
      className="w-full"
    />
  );
}

function TimeCell({ millis, nowMs }: { millis: number, nowMs: number }) {
  return (
    <span className="text-xs tabular-nums text-muted-foreground" title={formatAbsoluteTimeFromMillis(millis)}>
      {formatRelativeTimeFromMillis(millis, nowMs)}
    </span>
  );
}

function ActionsCell({ issue, context }: { issue: IssueListItem, context: IssueCellContext }) {
  const { status } = resolveIssueRowStatus(issue, context.overrides);
  const primary = primaryIssueStatusAction(status);
  return (
    <div className="flex items-center justify-end gap-1">
      <DesignButton
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[11px]"
        onClick={() => context.onChangeStatus(issue, nextStatusForAction(primary))}
      >
        {primary === "resolve" ? "Resolve" : "Undo"}
      </DesignButton>
      <DesignMenu
        variant="actions"
        align="end"
        items={[
          {
            id: "ignore",
            label: status === "ignored" ? "Unignore" : "Ignore",
            onClick: () => context.onChangeStatus(issue, status === "ignored" ? "unresolved" : "ignored"),
          },
        ]}
      />
    </div>
  );
}

export function buildIssueColumns(context: IssueCellContext): DataGridColumnDef<IssueListItem>[] {
  return [
    {
      id: "issue",
      header: "Issue",
      accessor: (row) => issueTitle(row),
      width: 460,
      minWidth: 280,
      flex: 1,
      sortable: false,
      hideable: false,
      renderCell: ({ row }) => <IssueCell issue={row} context={context} />,
    },
    {
      id: "graph",
      header: () => <HeaderWithTooltip label="Graph" tooltip={`Occurrences ${context.bucketLabel} in the selected range`} />,
      accessor: () => null,
      width: 130,
      minWidth: 80,
      sortable: false,
      renderCell: ({ row }) => <GraphCell issue={row} context={context} />,
    },
    {
      id: "events",
      header: () => (
        <HeaderWithTooltip
          label="Events"
          tooltip="Occurrences inside the selected time range (ClickHouse). Not the same as the all-time count under First seen."
        />
      ),
      accessor: (row) => row.window_occurrences,
      width: 92,
      minWidth: 70,
      align: "right",
      sortable: true,
      type: "number",
      renderCell: ({ row }) => (
        <span className="text-xs tabular-nums">{formatIssueCount(row.window_occurrences)}</span>
      ),
    },
    {
      id: "users",
      header: () => (
        <HeaderWithTooltip
          label="Users"
          tooltip="Distinct users affected inside the selected time range (ClickHouse)."
        />
      ),
      accessor: (row) => row.window_users,
      width: 84,
      minWidth: 64,
      align: "right",
      sortable: true,
      type: "number",
      renderCell: ({ row }) => (
        <span className="text-xs tabular-nums">{formatIssueCount(row.window_users)}</span>
      ),
    },
    {
      id: "lastSeen",
      header: () => <HeaderWithTooltip label="Last seen" tooltip="Most recent occurrence, all time." />,
      accessor: (row) => row.last_seen_at_millis,
      width: 110,
      minWidth: 90,
      sortable: true,
      renderCell: ({ row }) => <TimeCell millis={row.last_seen_at_millis} nowMs={context.nowMs} />,
    },
    {
      id: "firstSeen",
      header: () => (
        <HeaderWithTooltip
          label="First seen"
          tooltip="First occurrence ever (Postgres, lifetime) — independent of the selected time range."
        />
      ),
      accessor: (row) => row.first_seen_at_millis,
      width: 128,
      minWidth: 90,
      sortable: true,
      renderCell: ({ row }) => (
        <div className="flex flex-col leading-tight">
          <TimeCell millis={row.first_seen_at_millis} nowMs={context.nowMs} />
          <SimpleTooltip
            tooltip={
              row.counters_truncated_at_millis == null
                ? "All-time occurrence count (Postgres)."
                : `Counted since ${formatAbsoluteTimeFromMillis(row.counters_truncated_at_millis)} — this issue was split off another one, so earlier occurrences are not included.`
            }
          >
            <span className="cursor-help text-[10px] tabular-nums text-muted-foreground/60">
              {formatIssueCount(row.times_seen)} all time
              {row.counters_truncated_at_millis == null ? "" : "*"}
            </span>
          </SimpleTooltip>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: (row) => resolveIssueRowStatus(row, context.overrides).status,
      width: 104,
      minWidth: 80,
      sortable: false,
      renderCell: ({ row }) => {
        const { status } = resolveIssueRowStatus(row, context.overrides);
        const badge = issueStatusBadge({ status, substatus: row.substatus });
        if (badge == null) return <span className="text-xs text-muted-foreground/50">—</span>;
        return <DesignBadge label={badge.label} color={badge.color} size="sm" />;
      },
    },
    {
      id: "environment",
      header: "Environment",
      accessor: (row) => row.environment,
      width: 130,
      sortable: false,
      renderCell: ({ row }) => (
        row.environment == null
          ? <span className="text-xs text-muted-foreground/50">—</span>
          : <DesignBadge label={row.environment} color="zinc" size="sm" />
      ),
    },
    {
      id: "release",
      header: "Release",
      accessor: (row) => row.release,
      width: 140,
      sortable: false,
      renderCell: ({ row }) => (
        row.release == null
          ? <span className="text-xs text-muted-foreground/50">—</span>
          : <span className="block truncate font-mono text-[11px]" title={row.release}>{row.release}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      accessor: () => null,
      width: 116,
      minWidth: 116,
      sortable: false,
      hideable: false,
      pin: "right",
      align: "right",
      renderCell: ({ row }) => <ActionsCell issue={row} context={context} />,
    },
  ];
}

export const ISSUE_COLUMN_IDS: readonly string[] = [
  "issue", "graph", "events", "users", "lastSeen", "firstSeen", "status", "environment", "release", "actions",
];

export const ISSUE_COLUMNS_HIDDEN_BY_DEFAULT: readonly string[] = ["environment", "release"];
