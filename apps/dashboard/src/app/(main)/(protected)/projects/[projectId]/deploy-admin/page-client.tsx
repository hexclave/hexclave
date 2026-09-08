"use client";

// Deploy Admin — the operator's view of the deployments alpha, across every
// project. Internal project only; the backend gates on platform-admin
// membership, and this page is only reachable from the internal project's
// sidebar.
//
// Two jobs, in the order an operator needs them: the FUSEBOX that pauses new
// deployments instance-wide, then the numbers that say whether it needs
// pausing. The deployment list is last because it answers "which one", which is
// the question you have after the first two.

import {
  ActionDialog,
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
  Switch,
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

const ENDPOINT = "/internal/deployments-admin";

type DeploymentServiceRow = {
  service_id: string,
  status: string,
  url: string | null,
};

type DeploymentRow = {
  id: string,
  number: number,
  project_id: string,
  project_display_name: string,
  runtime: string,
  deployment_source_id: string,
  status: string,
  created_at_millis: number,
  finished_at_millis: number | null,
  services: DeploymentServiceRow[],
};

type Stats = {
  projects_with_provisioned_services: number,
  provisioned_services: number,
  max_deployed_services: number,
  deployments_total: number,
  deployments_recent: number,
  builds_total: number,
  builds_recent: number,
  deployments_in_flight: number,
  deployments_succeeded_recent: number,
  deployments_failed_recent: number,
  sources_by_runtime: { runtime: string, count: number }[],
  recent_window_days: number,
};

type Overview = {
  fusebox: { deployments_enabled: boolean },
  stats: Stats,
  deployments: DeploymentRow[],
  deployments_limit: number,
};

type LoadState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error", message: string }
  | { status: "ok", data: Overview };

async function fetchOverview(app: object): Promise<LoadState> {
  const response = await sendInternalUserRequest(app, ENDPOINT);
  // 403 is its own state rather than an error string: it means "you are not a
  // platform admin", which is a fact about the reader, not a failure.
  if (response.status === 403) return { status: "forbidden" };
  if (!response.ok) return { status: "error", message: `Request failed (${response.status})` };
  return { status: "ok", data: await response.json() as Overview };
}

function formatTime(millis: number): string {
  return new Date(millis).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(row: DeploymentRow): string {
  if (row.finished_at_millis == null) return "—";
  const seconds = Math.max(0, Math.round((row.finished_at_millis - row.created_at_millis) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusVariant(status: string): "success" | "destructive" | "info" | "secondary" {
  switch (status) {
    case "deployed": { return "success"; }
    case "failed": { return "destructive"; }
    case "queued":
    case "building":
    case "deploying": { return "info"; }
    default: { return "secondary"; }
  }
}

/** One headline number. `hint` is the second line — a window, a ceiling, a split. */
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

function StatTiles(props: { stats: Stats }) {
  const { stats } = props;
  const days = stats.recent_window_days;
  // Only meaningful once something finished in the window; 0/0 would otherwise
  // render as a confident "0%" for an instance nobody deployed to.
  const terminalRecent = stats.deployments_succeeded_recent + stats.deployments_failed_recent;
  const successRate = terminalRecent === 0 ? null : Math.round((stats.deployments_succeeded_recent / terminalRecent) * 100);
  const capacityPercent = stats.max_deployed_services === 0
    ? null
    : Math.round((stats.provisioned_services / stats.max_deployed_services) * 100);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <StatTile
        label="Projects deploying"
        value={String(stats.projects_with_provisioned_services)}
        hint="with at least one provisioned service"
      />
      <StatTile
        label="Provisioned services"
        value={`${stats.provisioned_services} / ${stats.max_deployed_services}`}
        hint={capacityPercent === null ? "platform capacity" : `${capacityPercent}% of platform capacity`}
        danger={capacityPercent !== null && capacityPercent >= 80}
      />
      <StatTile
        label="Deployments"
        value={String(stats.deployments_total)}
        hint={`${stats.deployments_recent} in the last ${days}d`}
      />
      <StatTile
        label="Builds"
        value={String(stats.builds_total)}
        hint={`${stats.builds_recent} in the last ${days}d · excludes prebuilt-image deploys`}
      />
      <StatTile
        label="In flight"
        value={String(stats.deployments_in_flight)}
        hint="queued, building, or deploying right now"
      />
      <StatTile
        label={`Failed (${days}d)`}
        value={String(stats.deployments_failed_recent)}
        hint={successRate === null ? "nothing finished in this window" : `${successRate}% of finished deploys succeeded`}
        danger={successRate !== null && successRate < 80}
      />
    </div>
  );
}

function FuseboxCard(props: { enabled: boolean, onChange: (enabled: boolean) => Promise<void> }) {
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [saving, setSaving] = useState(false);

  const apply = useCallback(async (enabled: boolean) => {
    setSaving(true);
    try {
      await props.onChange(enabled);
    } finally {
      setSaving(false);
    }
  }, [props]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          New deployments
          <Badge variant={props.enabled ? "success" : "destructive"}>{props.enabled ? "Enabled" : "Paused"}</Badge>
        </CardTitle>
        <CardDescription>
          The emergency fusebox. While it is off, no new deployment can be created on this instance —
          deploys already in flight finish, logs stay readable, and tearing services down keeps working.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-6">
          <div>
            <Typography type="p" className="text-sm font-medium">Allow new deployments</Typography>
            <Typography type="p" className="text-xs text-muted-foreground">
              Applies to `hexclave deploy` and to source uploads, for every project.
            </Typography>
          </div>
          <Switch
            checked={props.enabled}
            disabled={saving}
            onCheckedChange={(checked) => {
              // Turning it back ON is safe and immediate; turning it OFF stops
              // every customer's deploys, so that direction is confirmed.
              if (!checked) {
                setConfirmingDisable(true);
              } else {
                runAsynchronously(apply(true));
              }
            }}
          />
        </div>
        {!props.enabled && (
          <Alert variant="destructive">
            <AlertDescription>
              Deployments are paused platform-wide. Every project&apos;s `hexclave deploy` is failing with a 503.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
      <ActionDialog
        open={confirmingDisable}
        onClose={() => setConfirmingDisable(false)}
        danger
        title="Pause all new deployments?"
        description="Every project on this instance will be unable to deploy until you turn this back on. Deployments already in flight will finish."
        confirmText="I understand that no project will be able to deploy"
        okButton={{
          label: "Pause deployments",
          onClick: async () => {
            await apply(false);
            setConfirmingDisable(false);
          },
        }}
        cancelButton
      />
    </Card>
  );
}

function DeploymentsTable(props: { rows: DeploymentRow[], limit: number }) {
  if (props.rows.length === 0) {
    return <Typography type="p" className="text-sm text-muted-foreground">No deployments yet.</Typography>;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>#</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Runtime</TableHead>
            <TableHead>Services &amp; URLs</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <div className="font-medium">{row.project_display_name}</div>
                <div className="font-mono text-xs text-muted-foreground">{row.project_id}</div>
              </TableCell>
              <TableCell className="font-mono text-xs">{row.deployment_source_id}</TableCell>
              <TableCell className="tabular-nums">{row.number}</TableCell>
              <TableCell><Badge variant={statusVariant(row.status)}>{row.status}</Badge></TableCell>
              <TableCell><Badge variant="outline">{row.runtime}</Badge></TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  {row.services.map((service) => (
                    <div key={service.service_id} className="flex items-center gap-2 text-xs">
                      <span className="font-mono">{service.service_id}</span>
                      {service.url
                        ? <a href={service.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">{service.url}</a>
                        : <span className="text-muted-foreground">{service.status}</span>}
                    </div>
                  ))}
                </div>
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs">{formatTime(row.created_at_millis)}</TableCell>
              <TableCell className="tabular-nums text-xs">{formatDuration(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {props.rows.length >= props.limit && (
        <Typography type="p" className="mt-3 text-xs text-muted-foreground">
          Showing the newest {props.limit} deployments.
        </Typography>
      )}
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
      setState(await fetchOverview(app));
    } finally {
      setRefreshing(false);
    }
  }, [app]);

  useEffect(() => {
    runAsynchronously(load);
  }, [load]);

  const setFusebox = useCallback(async (enabled: boolean) => {
    const response = await sendInternalUserRequest(app, ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deployments_enabled: enabled }),
    });
    if (!response.ok) {
      setState({ status: "error", message: `Failed to update the fusebox (${response.status})` });
      return;
    }
    // Re-read rather than patching local state: the write is the moment the
    // rest of the numbers are most worth refreshing anyway.
    await load();
  }, [app, load]);

  return (
    <PageLayout
      title="Deploy Admin"
      description="Platform-wide view of the Deployments alpha. Counts cover projects on the shared database. Internal only."
      actions={
        <Button variant="secondary" onClick={() => runAsynchronously(load)} loading={refreshing}>
          <ArrowClockwiseIcon className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      }
    >
      {state.status === "loading" && (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
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
          <FuseboxCard enabled={state.data.fusebox.deployments_enabled} onChange={setFusebox} />

          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <StatTiles stats={state.data.stats} />
              <div className="flex flex-wrap items-center gap-2">
                <Typography type="p" className="text-xs text-muted-foreground">Deployment sources by runtime:</Typography>
                {state.data.stats.sources_by_runtime.length === 0
                  ? <Typography type="p" className="text-xs text-muted-foreground">none</Typography>
                  : state.data.stats.sources_by_runtime.map((entry) => (
                    <Badge key={entry.runtime} variant="outline">{entry.runtime}: {entry.count}</Badge>
                  ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent deployments</CardTitle>
              <CardDescription>Newest deployments across every project, with the URLs each one shipped.</CardDescription>
            </CardHeader>
            <CardContent>
              <DeploymentsTable rows={state.data.deployments} limit={state.data.deployments_limit} />
            </CardContent>
          </Card>
        </div>
      )}
    </PageLayout>
  );
}
