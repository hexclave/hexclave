"use client";

// Workflows Status — the operator's view of the workflow engine across every
// project. Internal project only; the backend gates on platform-admin
// membership.
//
// The engine has two queues and "workflows are behind" can mean either, so the
// page is laid out as the diagnosis runs: a one-line verdict, then the event
// outbox (events waiting to become runs), then the run queue (runs waiting for
// a sandbox slot), each with the breakdown that says whose work is waiting.

import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Typography,
} from "@/components/ui";
import { sendInternalUserRequest } from "@/lib/hexclave-app-internals";
import { useStackApp } from "@hexclave/next";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { PageLayout } from "../page-layout";

const ENDPOINT = "/internal/workflows-status";

// A queue whose oldest ready item is older than this is "behind". The engine's
// documented precision is about a minute, so a few minutes is already abnormal.
const BEHIND_THRESHOLD_MS = 5 * 60 * 1000;
// Ticks start every minute and each one advances the heartbeat, so several
// minutes of silence means ticks are not running or not finishing.
const STALLED_THRESHOLD_MS = 5 * 60 * 1000;

type Status = {
  generated_at_millis: number,
  limits: {
    event_batch_size: number,
    event_tenancy_concurrency: number,
    event_claim_lease_seconds: number,
    run_claim_batch_size: number,
    per_workflow_concurrency: number,
    run_lease_seconds: number,
  },
  events: {
    pending: number,
    ready: number,
    claimed: number,
    backing_off: number,
    without_workflows: number,
    max_processing_attempts: number,
    oldest_pending_at_millis: number | null,
    oldest_ready_at_millis: number | null,
    enqueued_last_hour: number,
    processed_last_5_minutes: number,
    processed_last_hour: number,
    last_processed_at_millis: number | null,
    dispatch_delay_p50_seconds: number | null,
    dispatch_delay_p95_seconds: number | null,
    dispatch_delay_max_seconds: number | null,
    pending_by_type: { type: string, count: number, oldest_scheduled_at_millis: number }[],
    pending_by_tenancy: {
      tenancy_id: string,
      project_id: string,
      project_display_name: string,
      branch_id: string,
      workflow_count: number,
      count: number,
      oldest_scheduled_at_millis: number,
    }[],
  },
  runs: {
    queued_due: number,
    queued_backing_off: number,
    running: number,
    running_lease_expired: number,
    sleeping: number,
    sleeping_overdue: number,
    oldest_due_at_millis: number | null,
    completed_last_hour: number,
    failed_last_hour: number,
    canceled_last_hour: number,
    completed_last_day: number,
    failed_last_day: number,
    platform_failed_last_day: number,
    canceled_last_day: number,
    active_by_workflow: {
      tenancy_id: string,
      project_id: string,
      project_display_name: string,
      workflow_id: string,
      paused: boolean,
      due: number,
      running: number,
      waiting: number,
      oldest_due_at_millis: number | null,
    }[],
  },
  definitions: {
    total: number,
    paused: number,
    tenancies: number,
  },
  schedules: {
    cursors: number,
    stalest_materialized_at_millis: number | null,
  },
};

type LoadState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error", message: string }
  // `refreshError` is set when a later refresh failed: the numbers on screen
  // are then the last ones that loaded, not current ones.
  | { status: "ok", data: Status, refreshError: string | null };

type FetchResult =
  | { status: "ok", data: Status }
  | { status: "forbidden" }
  | { status: "error", message: string };

async function fetchStatus(app: object): Promise<FetchResult> {
  // The request helper THROWS on every non-2xx response rather than returning
  // it, so failures are read off the thrown error. For a 4xx its `cause` is
  // the Response.
  try {
    const response = await sendInternalUserRequest(app, ENDPOINT);
    return { status: "ok", data: await response.json() as Status };
  } catch (error) {
    const response = error instanceof Error && error.cause instanceof Response ? error.cause : null;
    // 403 is its own state rather than an error string: it means "you are not
    // a platform admin", which is a fact about the reader, not a failure.
    if (response?.status === 403) return { status: "forbidden" };
    if (response != null) return { status: "error", message: `The status request failed (${response.status}).` };
    return { status: "error", message: "The status request failed. The backend may be unreachable, or the status queries may have timed out." };
  }
}

const numberFormat = new Intl.NumberFormat();
function formatCount(value: number): string {
  return numberFormat.format(value);
}

/** "42s", "7m 5s", "3h 12m", "5d 2h" — two units at most, because the size is what matters. */
function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Age of a timestamp relative to when the numbers were read, not to the reader's clock. */
function ageMs(status: Status, millis: number | null): number | null {
  return millis == null ? null : Math.max(0, status.generated_at_millis - millis);
}

function formatAge(status: Status, millis: number | null, emptyText: string): string {
  const age = ageMs(status, millis);
  return age == null ? emptyText : `${formatDuration(age)} ago`;
}

function isOlderThan(status: Status, millis: number | null, thresholdMs: number): boolean {
  const age = ageMs(status, millis);
  return age != null && age > thresholdMs;
}

/** One headline number. `hint` is the second line — an age, a ceiling, a split. */
function StatTile(props: { label: string, value: string, hint?: string, danger?: boolean }) {
  return (
    <div className="rounded-lg border p-4">
      <Typography type="p" className="text-xs uppercase tracking-wide text-muted-foreground">{props.label}</Typography>
      <Typography type="p" className={`mt-1 text-2xl font-semibold tabular-nums ${props.danger ? "text-destructive" : ""}`}>
        {props.value}
      </Typography>
      {props.hint && <Typography type="p" className="mt-1 text-xs text-muted-foreground">{props.hint}</Typography>}
    </div>
  );
}

function Verdict(props: { status: Status }) {
  const { status } = props;
  const problems: string[] = [];
  const outboxLag = ageMs(status, status.events.oldest_ready_at_millis);
  if (outboxLag != null && outboxLag > BEHIND_THRESHOLD_MS) {
    problems.push(`The event outbox is ${formatDuration(outboxLag)} behind (${formatCount(status.events.ready)} events ready and waiting).`);
  }
  const runLag = ageMs(status, status.runs.oldest_due_at_millis);
  if (runLag != null && runLag > BEHIND_THRESHOLD_MS) {
    problems.push(`The run queue is ${formatDuration(runLag)} behind (${formatCount(status.runs.queued_due + status.runs.sleeping_overdue)} runs due and waiting).`);
  }
  if (isOlderThan(status, status.schedules.stalest_materialized_at_millis, STALLED_THRESHOLD_MS)) {
    problems.push(`The engine has not finished a schedule pass in ${formatDuration(ageMs(status, status.schedules.stalest_materialized_at_millis) ?? 0)} — ticks may not be running.`);
  }

  if (problems.length === 0) {
    return (
      <Alert>
        <AlertDescription>The engine is keeping up: nothing ready has been waiting longer than {formatDuration(BEHIND_THRESHOLD_MS)}.</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {problems.map((problem) => <div key={problem}>{problem}</div>)}
      </AlertDescription>
    </Alert>
  );
}

function EventOutboxTiles(props: { status: Status }) {
  const { status } = props;
  const { events } = status;
  const net = events.enqueued_last_hour - events.processed_last_hour;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Ready to dispatch"
        value={formatCount(events.ready)}
        hint={events.oldest_ready_at_millis == null ? "nothing waiting" : `oldest was due ${formatAge(status, events.oldest_ready_at_millis, "")}`}
        danger={isOlderThan(status, events.oldest_ready_at_millis, BEHIND_THRESHOLD_MS)}
      />
      <StatTile
        label="Being dispatched"
        value={formatCount(events.claimed)}
        hint={`claimed by a tick · lease ${formatDuration(status.limits.event_claim_lease_seconds * 1000)}`}
      />
      <StatTile
        label="Backing off"
        value={formatCount(events.backing_off)}
        hint={events.backing_off === 0 ? "no failed dispatches" : `failed dispatches retrying · up to ${events.max_processing_attempts} attempts`}
        danger={events.backing_off > 0}
      />
      <StatTile
        label="For projects without workflows"
        value={formatCount(events.without_workflows)}
        hint="swept every tick · should stay near zero"
        danger={events.without_workflows > 10_000}
      />
      <StatTile
        label="Last hour: in / out"
        value={`${formatCount(events.enqueued_last_hour)} / ${formatCount(events.processed_last_hour)}`}
        hint={net > 0 ? `backlog grew by ${formatCount(net)}` : net < 0 ? `backlog shrank by ${formatCount(-net)}` : "in balance"}
      />
      <StatTile
        label="Processed, last 5 min"
        value={formatCount(events.processed_last_5_minutes)}
        hint={`${formatCount(Math.round(events.processed_last_5_minutes / 5))} per minute`}
      />
      <StatTile
        label="Dispatch delay, last hour"
        value={events.dispatch_delay_p50_seconds == null ? "—" : formatDuration(events.dispatch_delay_p50_seconds * 1000)}
        hint={events.dispatch_delay_p95_seconds == null || events.dispatch_delay_max_seconds == null
          ? "nothing dispatched in this window"
          : `median · p95 ${formatDuration(events.dispatch_delay_p95_seconds * 1000)} · max ${formatDuration(events.dispatch_delay_max_seconds * 1000)}`}
        danger={events.dispatch_delay_p95_seconds != null && events.dispatch_delay_p95_seconds * 1000 > BEHIND_THRESHOLD_MS}
      />
      <StatTile
        label="Last event dispatched"
        value={formatAge(status, events.last_processed_at_millis, "—")}
        hint={events.last_processed_at_millis == null ? "none in the last hour" : `${formatCount(events.pending)} pending in total`}
      />
    </div>
  );
}

function PendingByTypeTable(props: { status: Status }) {
  const rows = props.status.events.pending_by_type;
  if (rows.length === 0) {
    return <Typography type="p" className="text-sm text-muted-foreground">No pending events.</Typography>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Event type</TableHead>
          <TableHead className="text-right">Pending</TableHead>
          <TableHead className="text-right">Oldest</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.type}>
            <TableCell className="font-mono text-xs">{row.type}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(row.count)}</TableCell>
            <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">{formatAge(props.status, row.oldest_scheduled_at_millis, "—")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function PendingByProjectTable(props: { status: Status }) {
  const rows = props.status.events.pending_by_tenancy;
  if (rows.length === 0) {
    return <Typography type="p" className="text-sm text-muted-foreground">No pending events.</Typography>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Project</TableHead>
          <TableHead className="text-right">Workflows</TableHead>
          <TableHead className="text-right">Pending</TableHead>
          <TableHead className="text-right">Oldest</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.tenancy_id}>
            <TableCell>
              <div className="font-medium">{row.project_display_name}</div>
              <div className="font-mono text-xs text-muted-foreground">{row.project_id} · {row.branch_id}</div>
            </TableCell>
            <TableCell className="text-right tabular-nums">{row.workflow_count}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(row.count)}</TableCell>
            <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">{formatAge(props.status, row.oldest_scheduled_at_millis, "—")}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RunQueueTiles(props: { status: Status }) {
  const { status } = props;
  const { runs } = status;
  const due = runs.queued_due + runs.sleeping_overdue;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Due and waiting"
        value={formatCount(due)}
        hint={runs.oldest_due_at_millis == null ? "nothing waiting" : `oldest was due ${formatAge(status, runs.oldest_due_at_millis, "")}`}
        danger={isOlderThan(status, runs.oldest_due_at_millis, BEHIND_THRESHOLD_MS)}
      />
      <StatTile
        label="Running"
        value={formatCount(runs.running)}
        hint={`each tick claims ${status.limits.run_claim_batch_size} at a time · ${status.limits.per_workflow_concurrency} per workflow`}
      />
      <StatTile
        label="Lease expired"
        value={formatCount(runs.running_lease_expired)}
        hint="worker died mid-run · re-claimed by the next tick"
        danger={runs.running_lease_expired > 0}
      />
      <StatTile
        label="Sleeping"
        value={formatCount(runs.sleeping)}
        hint={`${formatCount(runs.sleeping_overdue)} past their wake-up time · ${formatCount(runs.queued_backing_off)} retrying after a failure`}
      />
      <StatTile
        label="Completed"
        value={formatCount(runs.completed_last_hour)}
        hint={`last hour · ${formatCount(runs.completed_last_day)} in 24h`}
      />
      <StatTile
        label="Failed"
        value={formatCount(runs.failed_last_hour)}
        hint={`last hour · ${formatCount(runs.failed_last_day)} in 24h`}
      />
      <StatTile
        label="Platform failures, 24h"
        value={formatCount(runs.platform_failed_last_day)}
        hint="failed because of us, not the workflow's code"
        danger={runs.platform_failed_last_day > 0}
      />
      <StatTile
        label="Canceled"
        value={formatCount(runs.canceled_last_hour)}
        hint={`last hour · ${formatCount(runs.canceled_last_day)} in 24h`}
      />
    </div>
  );
}

function ActiveByWorkflowTable(props: { status: Status }) {
  const rows = props.status.runs.active_by_workflow;
  if (rows.length === 0) {
    return <Typography type="p" className="text-sm text-muted-foreground">No active runs.</Typography>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Workflow</TableHead>
            <TableHead className="text-right">Due</TableHead>
            <TableHead className="text-right">Running</TableHead>
            <TableHead className="text-right">Sleeping / retrying</TableHead>
            <TableHead className="text-right">Oldest due</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.tenancy_id}:${row.workflow_id}`}>
              <TableCell>
                <div className="font-medium">{row.project_display_name}</div>
                <div className="font-mono text-xs text-muted-foreground">{row.project_id}</div>
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">{row.workflow_id}</span>
                {row.paused && <Badge variant="secondary" className="ml-2">paused</Badge>}
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(row.due)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(row.running)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatCount(row.waiting)}</TableCell>
              <TableCell className="whitespace-nowrap text-right text-xs tabular-nums">{formatAge(props.status, row.oldest_due_at_millis, "—")}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function EngineTiles(props: { status: Status }) {
  const { status } = props;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Workflows"
        value={formatCount(status.definitions.total)}
        hint={`${formatCount(status.definitions.paused)} paused`}
      />
      <StatTile
        label="Projects with workflows"
        value={formatCount(status.definitions.tenancies)}
        hint="only their events are dispatched"
      />
      <StatTile
        label="Last schedule pass"
        value={formatAge(status, status.schedules.stalest_materialized_at_millis, "—")}
        hint={status.schedules.cursors === 0 ? "no active schedules to measure" : `stalest of ${formatCount(status.schedules.cursors)} active schedules`}
        danger={isOlderThan(status, status.schedules.stalest_materialized_at_millis, STALLED_THRESHOLD_MS)}
      />
      <StatTile
        label="Event batch"
        value={formatCount(status.limits.event_batch_size)}
        hint={`per tick · ${status.limits.event_tenancy_concurrency} projects dispatched at once`}
      />
    </div>
  );
}

export default function PageClient() {
  const app = useStackApp();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await fetchStatus(app);
      setState((previous) => {
        if (result.status === "ok") return { status: "ok", data: result.data, refreshError: null };
        // A failed refresh keeps the last numbers on screen, flagged as stale:
        // during an incident, old numbers with a warning beat a blank page.
        if (result.status === "error" && previous.status === "ok") return { ...previous, refreshError: result.message };
        return result;
      });
    } finally {
      setRefreshing(false);
    }
  }, [app]);

  useEffect(() => {
    runAsynchronously(load);
  }, [load]);

  return (
    <PageLayout
      title="Workflows Status"
      description="How far behind the workflow engine is, in which queue, and on whose account. Covers every project. Internal only."
      actions={
        <Button variant="secondary" onClick={() => runAsynchronously(load)} loading={refreshing}>
          <ArrowClockwiseIcon className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      }
    >
      {state.status === "loading" && (
        <div className="space-y-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      )}

      {state.status === "forbidden" && (
        <Alert>
          <AlertDescription>
            This page is only available to Hexclave platform admins.
          </AlertDescription>
        </Alert>
      )}

      {state.status === "error" && (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.status === "ok" && (
        <div className="space-y-6">
          {state.refreshError != null && (
            <Alert variant="destructive">
              <AlertDescription>
                {state.refreshError} Showing the numbers from {new Date(state.data.generated_at_millis).toLocaleTimeString()}.
              </AlertDescription>
            </Alert>
          )}

          <Verdict status={state.data} />

          <Card>
            <CardHeader>
              <CardTitle>Event outbox</CardTitle>
              <CardDescription>
                Events waiting to be turned into runs. Every project&apos;s user, team and permission changes land here; only projects with workflows are dispatched.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <EventOutboxTiles status={state.data} />
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="space-y-2">
                  <Typography type="p" className="text-sm font-medium">Pending by project</Typography>
                  <PendingByProjectTable status={state.data} />
                </div>
                <div className="space-y-2">
                  <Typography type="p" className="text-sm font-medium">Pending by event type</Typography>
                  <PendingByTypeTable status={state.data} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Run queue</CardTitle>
              <CardDescription>Runs waiting for, or holding, a sandbox slot. Finished counts read the last hour and the last 24 hours.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <RunQueueTiles status={state.data} />
              <div className="space-y-2">
                <Typography type="p" className="text-sm font-medium">Active runs by workflow</Typography>
                <ActiveByWorkflowTable status={state.data} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Engine</CardTitle>
              <CardDescription>
                Read {new Date(state.data.generated_at_millis).toLocaleTimeString()}. Ages on this page are relative to that moment.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EngineTiles status={state.data} />
            </CardContent>
          </Card>
        </div>
      )}
    </PageLayout>
  );
}
