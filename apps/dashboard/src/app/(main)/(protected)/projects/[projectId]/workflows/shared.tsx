"use client";

import { codePanelHeaderClasses, codePanelShellClasses } from "@/components/code-block";
import { BUNDLED_TYPE_DEFINITIONS } from "@/generated/bundled-type-definitions";
import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignMenu,
  DesignMetricCard,
  DesignSelectorDropdown,
} from "@/components/design-components";
import { cn, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";
import { useTheme } from "@/lib/theme";
import Editor, { DiffEditor, type Monaco } from "@monaco-editor/react";
import type { AdminWorkflow, AdminWorkflowRun, AdminWorkflowSyncResult, AdminWorkflowTrigger, AdminWorkflowUpgradeResult, AdminWorkflowVersion } from "@hexclave/next";
import {
  BroadcastIcon,
  CalendarBlankIcon,
  ChartLineIcon,
  LightningIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  applyQuickSearch,
  buildRowComparator,
  createDefaultDataGridState,
  DataGrid,
  defaultMatchRow,
  useDataSource,
  type DataGridColumnDef,
  type DataGridDataSource,
  type DataGridSortModel,
} from "@hexclave/dashboard-ui-components";
import { fromNow } from "@hexclave/shared/dist/utils/dates";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAdminApp } from "../use-admin-app";
import { WORKFLOWS_EDITOR_AMBIENT_DTS, WORKFLOWS_EDITOR_DTS } from "./editor-types";
import { getRunStateBadgeColor, getRunStateLabel, getTriggerKind, getTriggerLabel, getWorkflowFileName, type RunState } from "./run-states";

// Building blocks for the Workflows page: the two infinite-scroll grids
// (same pattern as the Users page), the workflow header pieces, and the
// always-editable code panel where saving mints a new version (the v1
// dashboard-authored model — every save of changed source is a deploy).

// ─── Async load helper (explicit loading/error states, repo rule) ──────────

export type AsyncLoad<T> = {
  data: T | null,
  error: Error | null,
  loading: boolean,
  reload: () => void,
};

export function useAsyncLoad<T>(load: () => Promise<T>, deps: unknown[]): AsyncLoad<T> {
  const [state, setState] = useState<{ data: T | null, error: Error | null, loading: boolean }>({ data: null, error: null, loading: true });
  const [reloadCounter, setReloadCounter] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    runAsynchronously(async () => {
      try {
        const data = await load();
        if (alive) setState({ data, error: null, loading: false });
      } catch (error) {
        if (alive) setState({ data: null, error: error instanceof Error ? error : new Error(String(error)), loading: false });
      }
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadCounter]);
  return {
    ...state,
    reload: useCallback(() => setReloadCounter((count) => count + 1), []),
  };
}

// ─── Trigger chips / header pieces ─────────────────────────────────────────

const TRIGGER_ICONS = new Map<"platform" | "custom" | "schedule", React.ElementType>([
  ["platform", LightningIcon],
  ["custom", BroadcastIcon],
  ["schedule", CalendarBlankIcon],
]);

export function TriggerChip({ trigger }: { trigger: AdminWorkflowTrigger }) {
  const TriggerIcon = TRIGGER_ICONS.get(getTriggerKind(trigger)) ?? LightningIcon;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-foreground/[0.05] px-2 py-0.5 font-mono text-[11px] text-foreground/80">
      <TriggerIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
      {getTriggerLabel(trigger)}
    </span>
  );
}

/**
 * One trigger stays readable inline. Multiple triggers collapse to one
 * compact summary while the tooltip preserves the complete, scan-friendly
 * list. Only unique trigger kinds contribute icons to the summary.
 */
export function WorkflowTriggers({ triggers }: { triggers: AdminWorkflowTrigger[] }) {
  if (triggers.length < 2) {
    return triggers.map((trigger) => <TriggerChip key={getTriggerLabel(trigger)} trigger={trigger} />);
  }

  const kinds = [...new Set(triggers.map(getTriggerKind))];
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-foreground/[0.05] px-2 py-0.5 text-[11px] text-foreground/80">
          <span className="inline-flex items-center gap-0.5 text-muted-foreground">
            {kinds.map((kind) => {
              const TriggerIcon = TRIGGER_ICONS.get(kind) ?? LightningIcon;
              return <TriggerIcon key={kind} className="h-3 w-3" />;
            })}
          </span>
          {triggers.length} triggers
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="max-w-[420px] border-border bg-popover text-popover-foreground opacity-100 shadow-xl dark:bg-popover dark:text-popover-foreground"
      >
        <div className="flex max-h-64 flex-col gap-1 overflow-auto py-0.5">
          {triggers.map((trigger, index) => (
            <TriggerChip key={`${getTriggerLabel(trigger)}:${index}`} trigger={trigger} />
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** The "no new runs" marker, shown wherever a workflow is identified. */
export function PausedBadge({ workflow }: { workflow: AdminWorkflow }) {
  if (!workflow.isPaused) return null;
  return <DesignBadge label="Paused" color="orange" size="sm" />;
}

/** The slug + version + trigger chips row atop the workflow detail. */
export function WorkflowTitleRow({ workflow }: { workflow: AdminWorkflow }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-lg font-semibold">{workflow.id}</span>
      <DesignBadge label={`v${workflow.latestVersion}`} color="blue" size="sm" />
      <PausedBadge workflow={workflow} />
      <WorkflowTriggers triggers={workflow.triggers} />
    </div>
  );
}

/**
 * Pause/resume toggle. Pausing only closes the intake, so the banner copy is
 * explicit that in-flight runs keep going and that events arriving while
 * paused are dropped rather than queued — the two things an operator would
 * otherwise have to guess at.
 */
export function WorkflowPauseButton({ workflow }: { workflow: AdminWorkflow }) {
  const adminApp = useAdminApp();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex max-w-xs flex-col items-end gap-1">
      {/* DesignButton wraps an async onClick in its own loading state, so there
          is deliberately no `pending` here to fall out of sync with it. */}
      <DesignButton
        size="sm"
        variant={workflow.isPaused ? "default" : "outline"}
        onClick={async () => {
          setError(null);
          try {
            await adminApp.setWorkflowPaused(workflow.id, !workflow.isPaused);
          } catch (toggleError) {
            setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
          }
        }}
      >
        {workflow.isPaused
          ? <><PlayIcon className="mr-1 h-3.5 w-3.5" />Resume workflow</>
          : <><PauseIcon className="mr-1 h-3.5 w-3.5" />Pause workflow</>}
      </DesignButton>
      {error != null && <span role="alert" className="text-right text-[11px] text-red-600 dark:text-red-400">{error}</span>}
    </div>
  );
}

/** The banner on a paused workflow's detail page. */
export function PausedWorkflowAlert({ workflow }: { workflow: AdminWorkflow }) {
  if (!workflow.isPaused) return null;
  return (
    <DesignAlert
      variant="default"
      title={workflow.pausedAtMillis == null ? "This workflow is paused" : `This workflow was paused ${fromNow(new Date(workflow.pausedAtMillis))}`}
      description="No new runs are created while it is paused: matching events (and schedule ticks) are dropped rather than queued up for later. Runs already in flight keep executing."
    />
  );
}

export function getRuns7d(workflow: AdminWorkflow): number {
  return workflow.stats.runVolume14d.slice(-7).reduce((sum, value) => sum + value, 0);
}

/** Workflow-scoped KPI cards. */
export function WorkflowKpiRow({ workflow }: { workflow: AdminWorkflow }) {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <DesignMetricCard label="Active runs" value={workflow.stats.activeRuns} icon={PlayIcon} gradient="blue" />
      <DesignMetricCard label="Sleeping runs" value={workflow.stats.sleepingRuns.toLocaleString()} icon={MoonIcon} gradient="purple" />
      <DesignMetricCard label="Runs · 7d" value={getRuns7d(workflow).toLocaleString()} icon={ChartLineIcon} gradient="cyan" />
      <DesignMetricCard label="Failed · 7d" value={workflow.stats.failed7d} icon={WarningCircleIcon} gradient="orange" />
    </div>
  );
}

// ─── Workflows table (level 1) ─────────────────────────────────────────────

const INFINITE_PAGE_SIZE = 25;
const DEFAULT_WORKFLOW_SORT: DataGridSortModel = [{ columnId: "lastDeploy", direction: "desc" }];

/**
 * Wraps the (small, fully loaded) workflows array in the async-generator
 * data-source contract so the grid keeps real infinite scrolling behavior.
 */
function createInMemoryDataSource<TRow>(
  rows: TRow[],
  columns: readonly DataGridColumnDef<TRow>[],
): DataGridDataSource<TRow> {
  return async function* (params) {
    const offset = typeof params.cursor === "string" ? Number(params.cursor) : 0;
    let filtered = rows;
    const query = typeof params.quickSearch === "string" ? params.quickSearch.trim() : "";
    if (query.length > 0) {
      filtered = [...applyQuickSearch(filtered, query, columns, defaultMatchRow)];
    }
    const comparator = buildRowComparator(params.sorting, columns);
    if (comparator != null) {
      filtered = [...filtered].sort(comparator);
    }
    const nextOffset = offset + INFINITE_PAGE_SIZE;
    yield {
      rows: filtered.slice(offset, nextOffset),
      hasMore: nextOffset < filtered.length,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : undefined,
    };
  };
}

export function getInFlightRunCount(workflow: AdminWorkflow): number {
  return workflow.stats.activeRuns + workflow.stats.sleepingRuns;
}

// TODO(workflows-pause): pause state is invisible to the grid's quick search
// and sorting — `accessor: "id"` feeds both, and the badge lives only in
// renderCell — so on a long list the only way to find paused workflows is to
// spot the badges. A dedicated (hidden-by-default) status column would fix it.
function createWorkflowColumns(actions: {
  onRequestDelete: (workflow: AdminWorkflow) => void,
  onTogglePause: (workflow: AdminWorkflow) => void,
}): DataGridColumnDef<AdminWorkflow>[] {
  return [
    {
      id: "id",
      header: "Workflow",
      accessor: "id",
      width: 250,
      type: "string",
      renderCell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate font-mono text-xs font-medium", row.isPaused && "text-muted-foreground")}>{row.id}</span>
          <PausedBadge workflow={row} />
        </div>
      ),
    },
    {
      id: "triggers",
      header: "Triggers",
      accessor: (workflow) => workflow.triggers.map(getTriggerLabel).join(", "),
      width: 230,
      type: "string",
      renderCell: ({ row }) => (
        <div className="flex max-w-full items-center gap-1 overflow-x-auto whitespace-nowrap py-1">
          <WorkflowTriggers triggers={row.triggers} />
        </div>
      ),
    },
    {
      id: "latestVersion",
      header: "Version",
      accessor: "latestVersion",
      width: 85,
      type: "number",
      align: "left",
      renderCell: ({ row }) => <span className="font-mono text-xs">v{row.latestVersion}</span>,
    },
    {
      id: "inFlight",
      header: "In-flight runs",
      accessor: (workflow) => getInFlightRunCount(workflow),
      width: 115,
      type: "number",
      align: "right",
      renderCell: ({ row }) => (
        <span className="text-xs tabular-nums">{getInFlightRunCount(row).toLocaleString()}</span>
      ),
    },
    {
      id: "runs7d",
      header: "Runs (7d)",
      accessor: (workflow) => getRuns7d(workflow),
      width: 100,
      type: "number",
      align: "right",
      renderCell: ({ row }) => <span className="text-xs tabular-nums">{getRuns7d(row).toLocaleString()}</span>,
    },
    {
      id: "failed7d",
      header: "Failed (7d)",
      accessor: (workflow) => workflow.stats.failed7d,
      width: 100,
      type: "number",
      align: "right",
      renderCell: ({ row }) => (
        <span className={cn("text-xs tabular-nums", row.stats.failed7d > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>
          {row.stats.failed7d}
        </span>
      ),
    },
    {
      id: "lastDeploy",
      header: "Last deploy",
      accessor: (workflow) => workflow.lastDeployedAtMillis,
      width: 110,
      type: "number",
      renderCell: ({ row }) => (
        <span className="text-[11px] text-muted-foreground">{fromNow(new Date(row.lastDeployedAtMillis))}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: 52,
      minWidth: 52,
      maxWidth: 52,
      sortable: false,
      hideable: false,
      resizable: false,
      align: "right",
      renderCell: ({ row }) => (
        <div onClick={(event) => event.stopPropagation()}>
          <DesignMenu
            variant="actions"
            trigger="icon"
            triggerLabel={`Actions for ${row.id}`}
            align="end"
            withIcons
            items={[
              {
                id: "pause",
                label: row.isPaused ? "Resume workflow" : "Pause workflow",
                icon: row.isPaused ? <PlayIcon className="h-4 w-4" /> : <PauseIcon className="h-4 w-4" />,
                onClick: () => actions.onTogglePause(row),
              },
              {
                id: "delete",
                label: "Delete workflow",
                icon: <TrashIcon className="h-4 w-4" />,
                itemVariant: "destructive",
                onClick: () => actions.onRequestDelete(row),
              },
            ]}
          />
        </div>
      ),
    },
  ];
}

function getWorkflowRowId(workflow: AdminWorkflow): string {
  return workflow.id;
}

/** The level-1 workflows table — infinite-scroll grid, same as the Users page. */
export function WorkflowsTable({ workflows, onOpen, onRequestDelete, onTogglePause }: {
  workflows: AdminWorkflow[],
  onOpen: (workflowId: string) => void,
  onRequestDelete: (workflow: AdminWorkflow) => void,
  onTogglePause: (workflow: AdminWorkflow) => void,
}) {
  const workflowColumns = useMemo(() => createWorkflowColumns({ onRequestDelete, onTogglePause }), [onRequestDelete, onTogglePause]);
  const [gridState, setGridState] = useState(() => ({
    ...createDefaultDataGridState(workflowColumns),
    sorting: DEFAULT_WORKFLOW_SORT,
  }));
  const dataSource = useMemo(() => createInMemoryDataSource(workflows, workflowColumns), [workflows, workflowColumns]);
  const gridData = useDataSource({
    dataSource,
    columns: workflowColumns,
    getRowId: getWorkflowRowId,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "infinite",
  });

  return (
    <DataGrid
      columns={workflowColumns}
      rows={gridData.rows}
      getRowId={getWorkflowRowId}
      isLoading={gridData.isLoading}
      isRefetching={gridData.isRefetching}
      state={gridState}
      onChange={setGridState}
      onRowClick={(workflow) => onOpen(workflow.id)}
      paginationMode="infinite"
      hasMore={gridData.hasMore}
      isLoadingMore={gridData.isLoadingMore}
      onLoadMore={gridData.loadMore}
      footer={false}
      rowHeight={44}
      maxHeight={620}
    />
  );
}

// ─── Runs grid ─────────────────────────────────────────────────────────────

const runColumns = (latestVersion: number): DataGridColumnDef<AdminWorkflowRun>[] => [
  {
    id: "runKey",
    header: "Run key",
    accessor: (run) => run.runKey ?? run.id,
    width: 200,
    type: "string",
    renderCell: ({ row }) => (
      <span className="font-mono text-xs">
        {row.runKey ?? <span className="text-muted-foreground">{row.id.slice(0, 8)} · keyless</span>}
      </span>
    ),
  },
  {
    id: "state",
    header: "State",
    accessor: "state",
    width: 115,
    type: "string",
    renderCell: ({ row }) => (
      <DesignBadge label={getRunStateLabel(row.state)} color={getRunStateBadgeColor(row.state)} size="sm" />
    ),
  },
  {
    id: "version",
    header: "Version",
    accessor: "version",
    width: 100,
    type: "number",
    align: "left",
    renderCell: ({ row }) => (
      <span className={cn("font-mono text-xs", row.version === latestVersion ? "" : "text-muted-foreground")}>
        v{row.version}{row.version === latestVersion ? "" : " (pinned)"}
      </span>
    ),
  },
  {
    id: "trigger",
    header: "Trigger",
    accessor: (run) => `${run.triggerType} ${run.triggerSummary}`,
    width: 220,
    type: "string",
    renderCell: ({ row }) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-[11px]">{row.triggerType}</span>
        <span className="truncate text-[11px] text-muted-foreground">{row.triggerSummary}</span>
      </div>
    ),
  },
  {
    id: "currentStep",
    header: "Current step",
    accessor: (run) => run.currentStepId ?? "",
    width: 170,
    type: "string",
    renderCell: ({ row }) => (
      row.currentStepId == null
        ? <span className="text-xs text-muted-foreground">—</span>
        : <span className="font-mono text-xs">{row.currentStepId}</span>
    ),
  },
  {
    id: "startedAt",
    header: "Started",
    accessor: (run) => run.createdAtMillis,
    width: 100,
    type: "number",
    renderCell: ({ row }) => <span className="text-xs">{fromNow(new Date(row.createdAtMillis))}</span>,
  },
  {
    id: "nextWakeAt",
    header: "Next wake",
    accessor: (run) => run.nextWakeAtMillis ?? 0,
    width: 100,
    type: "number",
    renderCell: ({ row }) => (
      row.nextWakeAtMillis == null
        ? <span className="text-xs text-muted-foreground">—</span>
        : <span className="text-xs">{fromNow(new Date(row.nextWakeAtMillis))}</span>
    ),
  },
];

function getRunRowId(run: AdminWorkflowRun): string {
  return run.id;
}

/**
 * This workflow's runs — infinite-scroll DataGrid backed by the server's
 * cursor pagination. Quick search filters within loaded pages only (there is
 * no server-side free-text search in v1).
 */
export function WorkflowRunsGrid({ workflowId, latestVersion, stateFilter, reloadKey, onOpenRun, maxHeight = 520 }: {
  workflowId: string,
  latestVersion: number,
  stateFilter?: RunState,
  reloadKey?: number,
  onOpenRun: (run: AdminWorkflowRun) => void,
  maxHeight?: number,
}) {
  const adminApp = useAdminApp();
  const columns = useMemo(() => runColumns(latestVersion), [latestVersion]);
  const [gridState, setGridState] = useState(() => createDefaultDataGridState(columns));
  const dataSource = useMemo<DataGridDataSource<AdminWorkflowRun>>(
    () => async function* (params) {
      const result = await adminApp.listWorkflowRuns(workflowId, {
        cursor: typeof params.cursor === "string" ? params.cursor : undefined,
        limit: INFINITE_PAGE_SIZE,
        state: stateFilter,
      });
      let rows = result.runs;
      const query = typeof params.quickSearch === "string" ? params.quickSearch.trim() : "";
      if (query.length > 0) {
        rows = [...applyQuickSearch(rows, query, columns, defaultMatchRow)];
      }
      yield {
        rows,
        hasMore: result.nextCursor != null,
        nextCursor: result.nextCursor ?? undefined,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloadKey is deliberately extra: bumping it forces a refetch after retry/cancel actions
    [adminApp, workflowId, stateFilter, columns, reloadKey],
  );
  const gridData = useDataSource({
    dataSource,
    columns,
    getRowId: getRunRowId,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "infinite",
  });

  return (
    <DataGrid
      columns={columns}
      rows={gridData.rows}
      getRowId={getRunRowId}
      isLoading={gridData.isLoading}
      isRefetching={gridData.isRefetching}
      state={gridState}
      onChange={setGridState}
      onRowClick={onOpenRun}
      paginationMode="infinite"
      hasMore={gridData.hasMore}
      isLoadingMore={gridData.isLoadingMore}
      onLoadMore={gridData.loadMore}
      footer={false}
      rowHeight="auto"
      estimatedRowHeight={44}
      maxHeight={maxHeight}
    />
  );
}

// ─── Code: always-editable panel with version selector ────────────────────

function versionSelectorOptions(versions: AdminWorkflowVersion[]) {
  return versions.map((version) => ({
    value: String(version.version),
    label: `v${version.version}${version.isLatest ? " (latest)" : ""} · deployed ${fromNow(new Date(version.createdAtMillis))}`,
  }));
}

const configuredMonacoInstances = new WeakSet<Monaco>();

export function configureWorkflowsMonaco(monaco: Monaco) {
  if (configuredMonacoInstances.has(monaco)) return;
  configuredMonacoInstances.add(monaco);
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ESNext,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    strict: true,
    noEmit: true,
    allowNonTsExtensions: true,
  });
  // Real validation is the sync-time compile on the backend; Monaco
  // diagnostics are editor UX on top of the injected contract typedefs.
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  monaco.languages.typescript.typescriptDefaults.addExtraLib(WORKFLOWS_EDITOR_DTS, "file:///node_modules/@hexclave/workflows/index.d.ts");
  monaco.languages.typescript.typescriptDefaults.addExtraLib(WORKFLOWS_EDITOR_AMBIENT_DTS, "file:///ambient-workflows-stdlib.d.ts");
  // Use the same generated SDK source bundle as the dashboard's AI editor,
  // so hexclaveApp exposes the complete HexclaveServerApp surface rather than
  // another hand-maintained subset that will drift.
  for (const file of BUNDLED_TYPE_DEFINITIONS) {
    monaco.languages.typescript.typescriptDefaults.addExtraLib(
      file.content,
      `file:///node_modules/@hexclave/js/${file.path}`,
    );
  }
}

type SaveAlert =
  | { variant: "success", title: string, description: string }
  | { variant: "error", title: string, description: string };

/**
 * The code tab's panel. The latest version is editable in Monaco with a
 * Save button that mints the next version through the sync API (compile +
 * manifest validation happen server-side; errors surface in the alert
 * below). Older versions render read-only with an upgrade-runs action in the
 * Save button's place. The deploy label opens a side-by-side diff viewer.
 */
export function EditableCodePanel({ workflowId, versions, initialVersion, onVersionChange, onSynced, onUpgraded, height = 460 }: {
  workflowId: string,
  versions: AdminWorkflowVersion[],
  initialVersion?: number,
  onVersionChange: (version: number) => void,
  onSynced: (result: AdminWorkflowSyncResult) => void,
  onUpgraded: (result: AdminWorkflowUpgradeResult) => void,
  height?: number,
}) {
  const adminApp = useAdminApp();
  const { resolvedTheme } = useTheme();
  const latest = versions.find((version) => version.isLatest) ?? versions[0];
  const [selectedVersion, setSelectedVersion] = useState(() => (
    initialVersion != null && versions.some((version) => version.version === initialVersion)
      ? initialVersion
      : latest.version
  ));
  const selected = versions.find((version) => version.version === selectedVersion) ?? latest;
  const [draft, setDraft] = useState(selected.source);
  const [saveAlert, setSaveAlert] = useState<SaveAlert | null>(null);
  const [diff, setDiff] = useState<{ baseVersion: number, targetVersion: number } | null>(null);

  // Reset the draft whenever the shown version changes (including right
  // after a save, when the selection jumps to the freshly minted version).
  const draftKey = `${workflowId}:${selected.version}`;
  const [lastDraftKey, setLastDraftKey] = useState(draftKey);
  if (lastDraftKey !== draftKey) {
    setLastDraftKey(draftKey);
    setDraft(selected.source);
    return null;
  }

  const isLatest = selected.version === latest.version;
  const isDirty = isLatest && draft !== selected.source;
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

  const getVersionOrThrow = (versionNumber: number): AdminWorkflowVersion => {
    const version = versions.find((v) => v.version === versionNumber);
    if (version == null) {
      throw new Error(`Version v${versionNumber} not found — diff selectors only offer existing versions`);
    }
    return version;
  };

  const openDiff = () => {
    // Default comparison: the shown version against the one deployed right
    // before it (or against the next newer one when the oldest is shown).
    const index = versions.findIndex((version) => version.version === selectedVersion);
    const older = index + 1 < versions.length ? versions[index + 1] : null;
    if (older != null) {
      setDiff({ baseVersion: older.version, targetVersion: selectedVersion });
    } else {
      setDiff({ baseVersion: selectedVersion, targetVersion: versions[index - 1].version });
    }
  };

  if (diff != null) {
    const baseVersion = getVersionOrThrow(diff.baseVersion);
    const targetVersion = getVersionOrThrow(diff.targetVersion);
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <DesignSelectorDropdown
              value={String(diff.baseVersion)}
              onValueChange={(value) => setDiff({ baseVersion: Number(value), targetVersion: diff.targetVersion })}
              options={versionSelectorOptions(versions)}
              size="sm"
            />
            <span className="text-xs text-muted-foreground">→</span>
            <DesignSelectorDropdown
              value={String(diff.targetVersion)}
              onValueChange={(value) => setDiff({ baseVersion: diff.baseVersion, targetVersion: Number(value) })}
              options={versionSelectorOptions(versions)}
              size="sm"
            />
          </div>
          <DesignButton size="sm" variant="secondary" onClick={() => setDiff(null)}>
            Close diff
          </DesignButton>
        </div>

        <div className={codePanelShellClasses}>
          <div className={codePanelHeaderClasses}>
            <span className="font-mono text-xs">{getWorkflowFileName(workflowId)}</span>
            <span className="text-[11px] text-muted-foreground">v{baseVersion.version} → v{targetVersion.version}</span>
          </div>
          <DiffEditor
            height={height}
            language="typescript"
            original={baseVersion.source}
            modified={targetVersion.source}
            theme={monacoTheme}
            beforeMount={configureWorkflowsMonaco}
            options={{
              readOnly: true,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 12, bottom: 12 },
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DesignSelectorDropdown
          value={String(selectedVersion)}
          onValueChange={(value) => {
            const version = Number(value);
            setSelectedVersion(version);
            onVersionChange(version);
          }}
          options={versionSelectorOptions(versions)}
          size="sm"
        />
        {isLatest ? (
          <DesignButton
            size="sm"
            disabled={!isDirty}
            onClick={async () => {
              setSaveAlert(null);
              try {
                const result = await adminApp.updateWorkflowSource(workflowId, draft);
                if (result.created) {
                  setSaveAlert({
                    variant: "success",
                    title: `v${result.version} deployed`,
                    description: result.inFlightRunsOnOlderVersions > 0
                      ? `New runs start on v${result.version}. ${result.inFlightRunsOnOlderVersions.toLocaleString()} in-flight run(s) stay pinned to older versions until you explicitly upgrade them.`
                      : `New runs start on v${result.version}. In-flight runs stay pinned to the version they started on until you explicitly upgrade them.`,
                  });
                } else {
                  setSaveAlert({
                    variant: "success",
                    title: "No changes",
                    description: `The source is identical to v${result.version}; no new version was minted.`,
                  });
                }
                setSelectedVersion(result.version);
                onVersionChange(result.version);
                onSynced(result);
              } catch (error) {
                setSaveAlert({
                  variant: "error",
                  title: "Deploy failed",
                  description: error instanceof Error ? error.message : String(error),
                });
              }
            }}
          >
            Save as v{latest.version + 1}
          </DesignButton>
        ) : selected.inFlightRuns > 0 ? (
          <DesignButton
            size="sm"
            variant="outline"
            onClick={async () => {
              setSaveAlert(null);
              try {
                const result = await adminApp.upgradeWorkflowRuns(workflowId, { toVersion: latest.version, fromVersion: selected.version });
                onUpgraded(result);
              } catch (error) {
                setSaveAlert({
                  variant: "error",
                  title: "Upgrade failed",
                  description: error instanceof Error ? error.message : String(error),
                });
              }
            }}
          >
            Upgrade {selected.inFlightRuns.toLocaleString()} run{selected.inFlightRuns === 1 ? "" : "s"} to v{latest.version}
          </DesignButton>
        ) : null}
      </div>

      {saveAlert != null && (
        <DesignAlert
          variant={saveAlert.variant}
          title={saveAlert.title}
          description={saveAlert.description}
        />
      )}

      <div className={codePanelShellClasses}>
        <div className={codePanelHeaderClasses}>
          <span className="font-mono text-xs">{getWorkflowFileName(workflowId)}</span>
          {versions.length > 1 ? (
            <button
              type="button"
              onClick={openDiff}
              className="text-[11px] text-blue-600 transition-colors duration-150 hover:underline hover:transition-none dark:text-blue-400"
            >
              {isLatest ? "latest" : `v${selectedVersion}`} · deployed {fromNow(new Date(selected.createdAtMillis))}
            </button>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {isLatest ? "latest" : `v${selectedVersion}`} · deployed {fromNow(new Date(selected.createdAtMillis))}
            </span>
          )}
        </div>
        <Editor
          height={height}
          language="typescript"
          path={`file:///workflows/${workflowId}.ts`}
          value={isLatest ? draft : selected.source}
          onChange={(value) => {
            if (isLatest) setDraft(value ?? "");
          }}
          theme={monacoTheme}
          beforeMount={configureWorkflowsMonaco}
          options={{
            readOnly: !isLatest,
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            padding: { top: 12, bottom: 12 },
          }}
        />
      </div>
    </div>
  );
}

/** A frontend-only v1 draft. Saving is the first API mutation. */
export function NewWorkflowCodePanel({ workflowId, initialSource, onCreated, height = 460 }: {
  workflowId: string,
  initialSource: string,
  onCreated: (result: AdminWorkflowSyncResult) => void,
  height?: number,
}) {
  const adminApp = useAdminApp();
  const { resolvedTheme } = useTheme();
  const [draft, setDraft] = useState(initialSource);
  const [saveAlert, setSaveAlert] = useState<SaveAlert | null>(null);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <DesignButton
          size="sm"
          onClick={async () => {
            setSaveAlert(null);
            try {
              const result = await adminApp.createWorkflow({ id: workflowId, source: draft });
              setSaveAlert({
                variant: "success",
                title: "v1 deployed",
                description: "The workflow now exists and new matching events can start runs.",
              });
              onCreated(result);
            } catch (error) {
              setSaveAlert({
                variant: "error",
                title: "Deploy failed",
                description: error instanceof Error ? error.message : String(error),
              });
            }
          }}
        >
          Save as v1
        </DesignButton>
      </div>

      {saveAlert != null && (
        <DesignAlert variant={saveAlert.variant} title={saveAlert.title} description={saveAlert.description} />
      )}

      <div className={codePanelShellClasses}>
        <div className={codePanelHeaderClasses}>
          <span className="font-mono text-xs">{getWorkflowFileName(workflowId)}</span>
          <span className="text-[11px] text-muted-foreground">not deployed</span>
        </div>
        <Editor
          height={height}
          language="typescript"
          path={`file:///workflows/${workflowId}.ts`}
          value={draft}
          onChange={(value) => setDraft(value ?? "")}
          theme={resolvedTheme === "dark" ? "vs-dark" : "light"}
          beforeMount={configureWorkflowsMonaco}
          options={{
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            padding: { top: 12, bottom: 12 },
          }}
        />
      </div>
    </div>
  );
}
