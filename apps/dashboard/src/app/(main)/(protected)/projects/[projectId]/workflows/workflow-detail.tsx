"use client";

import { DesignAlert, DesignBadge, DesignButton, DesignCategoryTabs, DesignDialog, DesignInput, DesignSelectorDropdown } from "@/components/design-components";
import { useRouter } from "@/components/router";
import { Textarea } from "@/components/ui";
import type { AdminWorkflow, AdminWorkflowRun, AdminWorkflowRunDetails, AdminWorkflowTrigger, AdminWorkflowUpgradeResult } from "@hexclave/next";
import { WORKFLOW_ID_REGEX } from "@hexclave/shared/dist/interface/workflows";
import { fromNow } from "@hexclave/shared/dist/utils/dates";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { ArrowLeftIcon, BroadcastIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { useAdminApp } from "../use-admin-app";
import { getNewWorkflowSource } from "./example-source";
import { ALL_RUN_STATES, getRunStateBadgeColor, getRunStateLabel, getTriggerKind, type RunState } from "./run-states";
import {
  EditableCodePanel,
  NewWorkflowCodePanel,
  PausedWorkflowAlert,
  useAsyncLoad,
  WorkflowKpiRow,
  WorkflowPauseButton,
  WorkflowRunsGrid,
  WorkflowsTable,
  WorkflowTitleRow,
} from "./shared";

// The Workflows page: an infinite-scroll table of workflows (with a
// new-workflow dialog), and a drill-in detail with the workflow's KPIs and
// two tabs — the runs grid (with a per-run step timeline dialog) and the
// always-editable code panel (version selector defaults to latest; saving
// mints and deploys the next version).

export type WorkflowDetailProps = {
  selectedWorkflowId: string | null,
  onSelect: (workflowId: string) => void,
  onCreateDraft: (workflowId: string) => void,
  onClose: () => void,
};

export function WorkflowDetail({ selectedWorkflowId, onSelect, onCreateDraft, onClose }: WorkflowDetailProps) {
  if (selectedWorkflowId == null) {
    return <WorkflowsIndex onOpen={onSelect} onCreateDraft={onCreateDraft} />;
  }
  return <WorkflowDetailInner workflowId={selectedWorkflowId} onClose={onClose} />;
}

function WorkflowsIndex({ onOpen, onCreateDraft }: { onOpen: (workflowId: string) => void, onCreateDraft: (workflowId: string) => void }) {
  const adminApp = useAdminApp();
  const workflows = adminApp.useWorkflows();
  const [createOpen, setCreateOpen] = useState(false);
  const [newId, setNewId] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [deletingWorkflow, setDeletingWorkflow] = useState<AdminWorkflow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pauseError, setPauseError] = useState<string | null>(null);
  const requestDelete = useCallback((workflow: AdminWorkflow) => {
    setDeleteError(null);
    setDeletingWorkflow(workflow);
  }, []);
  const togglePause = useCallback((workflow: AdminWorkflow) => {
    setPauseError(null);
    runAsynchronously(async () => {
      try {
        await adminApp.setWorkflowPaused(workflow.id, !workflow.isPaused);
      } catch (error) {
        // Names the workflow: the row menu can act on any row, and the banner
        // that reports the failure sits at the top of the page.
        setPauseError(`${workflow.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }, [adminApp]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <DesignButton size="sm" onClick={() => {
          setNewId("");
          setCreateError(null);
          setCreateOpen(true);
        }}>
          <PlusIcon className="mr-1 h-3.5 w-3.5" />New workflow
        </DesignButton>
      </div>

      {pauseError != null && (
        <DesignAlert variant="error" title="Could not change pause state" description={pauseError} />
      )}

      {workflows.length === 0 ? (
        <DesignAlert
          variant="default"
          title="No workflows yet"
          description="Create your first workflow to react to platform events (user.created, team.deleted, ...), custom events, or schedules with durable multi-step automations."
        />
      ) : (
        <WorkflowsTable
          workflows={workflows}
          onOpen={onOpen}
          onRequestDelete={requestDelete}
          onTogglePause={togglePause}
        />
      )}

      <DesignDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        size="md"
        title="New workflow"
        description="The id is the workflow's stable business identity across versions (lowercase letters, digits, dashes)."
        footer={
          <div className="flex justify-end gap-2">
            <DesignButton variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</DesignButton>
            <DesignButton
              disabled={newId.trim().length === 0}
              onClick={() => {
                setCreateError(null);
                const workflowId = newId.trim();
                if (!WORKFLOW_ID_REGEX.test(workflowId)) {
                  setCreateError("Workflow ids must be 1–64 characters using lowercase letters, digits, and dashes.");
                  return;
                }
                if (workflows.some((workflow) => workflow.id === workflowId)) {
                  setCreateError(`A workflow with id "${workflowId}" already exists.`);
                  return;
                }
                setCreateOpen(false);
                onCreateDraft(workflowId);
              }}
            >
              Continue
            </DesignButton>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <DesignInput
            value={newId}
            onChange={(event) => setNewId(event.target.value)}
            placeholder="welcome-drip"
            autoFocus
          />
          {createError != null && (
            <DesignAlert variant="error" title="Could not create workflow" description={createError} />
          )}
        </div>
      </DesignDialog>

      <DesignDialog
        open={deletingWorkflow != null}
        onOpenChange={(open) => {
          if (!open) setDeletingWorkflow(null);
        }}
        size="md"
        icon={TrashIcon}
        title="Delete workflow?"
        description={deletingWorkflow == null ? undefined : `This permanently deletes ${deletingWorkflow.id}, all versions, and its run history. Active runs are stopped.`}
        footer={
          <div className="flex justify-end gap-2">
            <DesignButton variant="secondary" onClick={() => setDeletingWorkflow(null)}>Cancel</DesignButton>
            <DesignButton
              variant="destructive"
              onClick={async () => {
                if (deletingWorkflow == null) return;
                setDeleteError(null);
                try {
                  await adminApp.deleteWorkflow(deletingWorkflow.id);
                  setDeletingWorkflow(null);
                } catch (error) {
                  setDeleteError(error instanceof Error ? error.message : String(error));
                }
              }}
            >
              Delete workflow
            </DesignButton>
          </div>
        }
      >
        {deleteError != null && (
          <DesignAlert variant="error" title="Could not delete workflow" description={deleteError} />
        )}
      </DesignDialog>
    </div>
  );
}

type DetailTab = "runs" | "code";

function WorkflowDetailInner({ workflowId, onClose }: { workflowId: string, onClose: () => void }) {
  const adminApp = useAdminApp();
  const workflows = adminApp.useWorkflows();
  const workflow = workflows.find((candidate) => candidate.id === workflowId);
  const searchParams = useSearchParams();

  if (workflow == null && searchParams.get("new") === "1") {
    return <NewWorkflowDetail workflowId={workflowId} onClose={onClose} />;
  }
  if (workflow == null) {
    return <MissingWorkflow workflowId={workflowId} onClose={onClose} />;
  }
  // Keyed by id so navigating between two workflows (back/forward, a pasted
  // deep link) remounts rather than carrying the previous one's local state —
  // a pending toggle or a stale error — onto a different workflow.
  return <PersistedWorkflowDetail key={workflow.id} workflow={workflow} onClose={onClose} />;
}

function BackToWorkflows({ onClick }: { onClick: () => void }) {
  return (
    <DesignButton variant="ghost" size="sm" onClick={onClick}>
      <ArrowLeftIcon className="mr-1 h-3.5 w-3.5" />All workflows
    </DesignButton>
  );
}

function MissingWorkflow({ workflowId, onClose }: { workflowId: string, onClose: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <div><BackToWorkflows onClick={onClose} /></div>
      <DesignAlert variant="error" title="Workflow not found" description={`No workflow with id "${workflowId}" exists in this project.`} />
    </div>
  );
}

function NewWorkflowDetail({ workflowId, onClose }: { workflowId: string, onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <div className="flex flex-col gap-4">
      <div><BackToWorkflows onClick={onClose} /></div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-lg font-semibold">{workflowId}</span>
        <DesignBadge label="Draft" color="cyan" size="sm" />
      </div>
      <NewWorkflowCodePanel
        workflowId={workflowId}
        initialSource={getNewWorkflowSource(workflowId)}
        onCreated={() => router.replace(pathname + "?tab=code&version=1")}
      />
    </div>
  );
}

function replaceDetailQuery(options: {
  router: ReturnType<typeof useRouter>,
  pathname: string,
  searchParams: ReturnType<typeof useSearchParams>,
  values: Map<string, string | null>,
}) {
  const next = new URLSearchParams(options.searchParams.toString());
  for (const [key, value] of options.values) {
    if (value == null) next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  options.router.replace(options.pathname + (query.length === 0 ? "" : "?" + query));
}

function isRunState(value: string): value is RunState {
  return ALL_RUN_STATES.some((state) => state === value);
}

function PersistedWorkflowDetail({ workflow, onClose }: { workflow: AdminWorkflow, onClose: () => void }) {
  const workflowId = workflow.id;
  const adminApp = useAdminApp();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const versionsLoad = useAsyncLoad(async () => await adminApp.listWorkflowVersions(workflowId), [workflowId]);
  const tab: DetailTab = searchParams.get("tab") === "code" ? "code" : "runs";
  const requestedVersion = searchParams.get("version");
  const initialVersion = requestedVersion != null && /^\d+$/.test(requestedVersion) ? Number(requestedVersion) : undefined;
  const [runStateFilter, setRunStateFilter] = useState<RunState | "all">("all");
  const [runsReloadKey, setRunsReloadKey] = useState(0);
  const [openRun, setOpenRun] = useState<AdminWorkflowRun | null>(null);
  const [upgradeResult, setUpgradeResult] = useState<AdminWorkflowUpgradeResult | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <div><BackToWorkflows onClick={onClose} /></div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <WorkflowTitleRow workflow={workflow} />
        <div className="flex flex-wrap items-center gap-2">
          {workflow.triggers.some((trigger) => getTriggerKind(trigger) === "custom") && (
            <SendCustomEventDialog
              triggers={workflow.triggers}
              isPaused={workflow.isPaused}
              onSent={() => setRunsReloadKey((key) => key + 1)}
            />
          )}
          <WorkflowPauseButton workflow={workflow} />
        </div>
      </div>
      <PausedWorkflowAlert workflow={workflow} />
      <WorkflowKpiRow workflow={workflow} />

      <DesignCategoryTabs
        categories={[
          { id: "runs", label: "Runs", count: workflow.stats.totalRuns },
          { id: "code", label: "Code", count: versionsLoad.data?.length ?? 0 },
        ]}
        selectedCategory={tab}
        onSelect={(id) => {
          if (id !== "runs" && id !== "code") {
            throw new Error(`Unknown workflow detail tab "${id}"`);
          }
          replaceDetailQuery({
            router,
            pathname,
            searchParams,
            values: new Map([
              ["tab", id === "code" ? "code" : null],
              ["version", id === "code" ? (searchParams.get("version") ?? String(workflow.latestVersion)) : null],
            ]),
          });
        }}
        gradient="blue"
        size="sm"
      />

      {tab === "runs" && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-end gap-2">
            <label htmlFor="workflow-run-state-filter" className="text-xs text-muted-foreground">State</label>
            <DesignSelectorDropdown
              value={runStateFilter}
              onValueChange={(value) => {
                if (value === "all" || isRunState(value)) setRunStateFilter(value);
                else throw new Error(`Unknown workflow run state "${value}"`);
              }}
              options={[
                { value: "all", label: "All states" },
                ...ALL_RUN_STATES.map((state) => ({ value: state, label: getRunStateLabel(state) })),
              ]}
              size="sm"
              triggerId="workflow-run-state-filter"
            />
          </div>
          <WorkflowRunsGrid
            workflowId={workflowId}
            latestVersion={workflow.latestVersion}
            stateFilter={runStateFilter === "all" ? undefined : runStateFilter}
            reloadKey={runsReloadKey}
            onOpenRun={setOpenRun}
          />
        </div>
      )}
      {tab === "code" && (
        versionsLoad.error != null ? (
          <DesignAlert variant="error" title="Failed to load versions" description={versionsLoad.error.message} />
        ) : versionsLoad.loading || versionsLoad.data == null ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading versions…</div>
        ) : (
          <EditableCodePanel
            workflowId={workflowId}
            versions={versionsLoad.data}
            initialVersion={initialVersion}
            onVersionChange={(version) => replaceDetailQuery({
              router,
              pathname,
              searchParams,
              values: new Map([["version", String(version)]]),
            })}
            onSynced={() => versionsLoad.reload()}
            onUpgraded={(result) => {
              setUpgradeResult(result);
              versionsLoad.reload();
              setRunsReloadKey((key) => key + 1);
            }}
          />
        )
      )}

      {openRun != null && (
        <RunDetailsDialog
          run={openRun}
          latestVersion={workflow.latestVersion}
          onClose={() => setOpenRun(null)}
          onChanged={() => setRunsReloadKey((key) => key + 1)}
        />
      )}

      <DesignDialog
        open={upgradeResult != null}
        onOpenChange={(open) => {
          if (!open) setUpgradeResult(null);
        }}
        size="lg"
        title="Upgrade result"
      >
        {upgradeResult != null && (
          <div className="flex flex-col gap-3">
            <DesignAlert
              variant={upgradeResult.skipped.length === 0 ? "success" : "default"}
              title={`${upgradeResult.upgradedCount.toLocaleString()} run(s) upgraded, ${upgradeResult.skipped.length.toLocaleString()} skipped`}
              description="Upgraded runs resume on the target version at their next step boundary. Skipped runs keep executing their pinned version — leave them to drain, cancel them, or retry the upgrade later."
            />
            {upgradeResult.skipped.map((skip) => (
              <div key={skip.runId} className="rounded-lg border border-border/60 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{skip.runKey ?? skip.runId}</span>
                  <DesignBadge label={`v${skip.fromVersion} (pinned)`} color="orange" size="sm" />
                  <span className="font-mono text-muted-foreground">{skip.diagnostic.reason}</span>
                </div>
                <p className="mt-1 text-muted-foreground">{skip.diagnostic.details}</p>
              </div>
            ))}
          </div>
        )}
      </DesignDialog>
    </div>
  );
}

function getCustomEventName(trigger: AdminWorkflowTrigger): string | null {
  if (trigger.type !== "event" || !trigger.eventType.startsWith("custom.")) return null;
  return trigger.eventType.slice("custom.".length);
}

function SendCustomEventDialog({ triggers, isPaused, onSent }: { triggers: AdminWorkflowTrigger[], isPaused: boolean, onSent: () => void }) {
  const adminApp = useAdminApp();
  const customEventNames = [...new Set(triggers.map(getCustomEventName).filter((name): name is string => name != null))];
  const [open, setOpen] = useState(false);
  const [selectedName, setSelectedName] = useState(customEventNames[0] ?? "");
  const [payload, setPayload] = useState("{}\n");
  const [result, setResult] = useState<{ eventId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <DesignDialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setSelectedName(customEventNames[0] ?? "");
          setResult(null);
          setError(null);
        }
      }}
      size="lg"
      icon={BroadcastIcon}
      title="Send custom event"
      description="Emit an event into this development environment. Every matching workflow creates a run."
      trigger={<DesignButton size="sm" variant="outline"><BroadcastIcon className="mr-1 h-3.5 w-3.5" />Send custom event</DesignButton>}
      footer={
        <DesignButton
          size="sm"
          disabled={selectedName.length === 0}
          onClick={async () => {
            setError(null);
            setResult(null);
            try {
              const parsedPayload: unknown = JSON.parse(payload);
              const sendResult = await adminApp.sendWorkflowEvent(selectedName, parsedPayload);
              setResult(sendResult);
              onSent();
            } catch (sendError) {
              setError(sendError instanceof Error ? sendError.message : String(sendError));
            }
          }}
        >
          Send event
        </DesignButton>
      }
    >
      <div className="flex flex-col gap-3">
        {/* Sending is still allowed while paused — the event is project-wide
            and other workflows may consume it — but without this the operator
            gets a green "Event queued" and then waits for a run that the
            engine already decided to drop. */}
        {isPaused && (
          <DesignAlert
            variant="default"
            title="This workflow is paused"
            description="The event will be delivered to other workflows that subscribe to it, but this one will drop it — resuming later does not run it. Resume first if you want to test this workflow."
          />
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor="workflow-custom-event-name" className="text-xs font-medium">Event</label>
          <DesignSelectorDropdown
            value={selectedName}
            onValueChange={setSelectedName}
            options={customEventNames.map((name) => ({ value: name, label: `custom.${name}` }))}
            size="sm"
            triggerId="workflow-custom-event-name"
          />
        </div>
        <label htmlFor="workflow-custom-event-payload" className="text-xs font-medium">JSON payload</label>
        <Textarea
          id="workflow-custom-event-payload"
          value={payload}
          onChange={(event) => setPayload(event.target.value)}
          className="min-h-48 font-mono text-xs"
          aria-label="Custom event JSON payload"
          spellCheck={false}
        />
        {error != null && <DesignAlert variant="error" title="Could not send event" description={error} />}
        {result != null && (
          <DesignAlert
            variant="success"
            title="Event queued"
            description={`Event id: ${result.eventId}${isPaused ? " — this workflow is paused, so it dropped the event instead of starting a run." : ""}`}
          />
        )}
      </div>
    </DesignDialog>
  );
}

// ─── Run details (step timeline + memoized results + attempts) ─────────────

function RunDetailsDialog({ run, latestVersion, onClose, onChanged }: {
  run: AdminWorkflowRun,
  latestVersion: number,
  onClose: () => void,
  onChanged: () => void,
}) {
  const adminApp = useAdminApp();
  const detailsLoad = useAsyncLoad(async () => await adminApp.getWorkflowRun(run.id), [run.id]);
  const details = detailsLoad.data;
  const isActive = ["queued", "running", "sleeping"].includes(run.state);

  return (
    <DesignDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="xl"
      title={run.runKey ?? `${run.id.slice(0, 8)} · keyless`}
      description={`${run.workflowId} · started ${fromNow(new Date(run.createdAtMillis))} · triggered by ${run.triggerType}`}
      headerContent={
        <div className="flex flex-wrap items-center gap-2">
          <DesignBadge label={getRunStateLabel(run.state)} color={getRunStateBadgeColor(run.state)} size="sm" />
          <DesignBadge label={`v${run.version}${run.version === latestVersion ? "" : " (pinned)"}`} color="blue" size="sm" />
          {run.state === "failed" && (
            <DesignButton
              size="sm"
              variant="outline"
              onClick={async () => {
                await adminApp.retryWorkflowRun(run.id);
                onChanged();
                onClose();
              }}
            >
              Retry from failed step
            </DesignButton>
          )}
          {isActive && (
            <DesignButton
              size="sm"
              variant="destructive"
              onClick={async () => {
                await adminApp.cancelWorkflowRuns(run.workflowId, { runId: run.id });
                onChanged();
                onClose();
              }}
            >
              Cancel run
            </DesignButton>
          )}
        </div>
      }
    >
      {detailsLoad.error != null ? (
        <DesignAlert variant="error" title="Failed to load run" description={detailsLoad.error.message} />
      ) : details == null ? (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading run…</div>
      ) : (
        <RunDetailsBody details={details} />
      )}
    </DesignDialog>
  );
}

function RunDetailsBody({ details }: { details: AdminWorkflowRunDetails }) {
  return (
    <div className="flex flex-col gap-4">
      {details.errorSummary != null && (
        <DesignAlert
          variant="error"
          title={details.failureKind === "platform" ? "Platform error" : "Run failed"}
          description={details.errorSummary}
        />
      )}
      {details.lastUpgradeDivergence != null && (
        <DesignAlert
          variant="default"
          title={`Last upgrade attempt skipped this run (${details.lastUpgradeDivergence.reason})`}
          description={details.lastUpgradeDivergence.details}
        />
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Steps ({details.steps.length} recorded)</h3>
        {details.steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No steps recorded yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {details.steps.map((step) => (
              <div key={step.stepKey} className="rounded-lg border border-border/60 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-mono font-medium">{step.stepKey}</span>
                  <DesignBadge label={step.kind === "sleep" ? "sleep" : "step"} color={step.kind === "sleep" ? "purple" : "blue"} size="sm" />
                  <span className="text-muted-foreground">
                    v{step.executedAtVersion} · {step.attempts} attempt{step.attempts === 1 ? "" : "s"}
                    {step.elapsedMs != null ? ` · ${step.elapsedMs}ms` : ""} · {fromNow(new Date(step.createdAtMillis))}
                  </span>
                </div>
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-foreground/[0.03] p-2 font-mono text-[11px] text-foreground/80">
                  {JSON.stringify(step.result, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hidden for clean runs, where every attempt succeeded and the list would
          just restate STEPS. Retried runs always show it: some runs fail before
          any attempt row is written (e.g. the memo-size guards), so a recovering
          retry can leave a single succeeded, log-less attempt that the first two
          conditions would hide — exactly the run an operator came to inspect. */}
      {details.stepAttempts.some((attempt) => attempt.outcome === "failed" || attempt.logs != null || attempt.retryEpoch > 0) && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Attempts</h3>
          <div className="flex flex-col gap-2">
            {details.stepAttempts.map((attempt) => (
              <div key={`${attempt.stepKey}#${attempt.retryEpoch}#${attempt.attempt}`} className="rounded-lg border border-border/60 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Attempt numbering restarts at 1 on each manual retry, so the
                      epoch has to be shown or the list reads as duplicates. */}
                  <span className="font-mono">
                    {attempt.stepKey} · {attempt.retryEpoch > 0 ? `retry ${attempt.retryEpoch} · ` : ""}attempt {attempt.attempt}
                  </span>
                  <DesignBadge
                    label={attempt.outcome === "succeeded" ? "succeeded" : attempt.failureKind === "platform" ? "platform error" : "failed"}
                    color={attempt.outcome === "succeeded" ? "green" : "red"}
                    size="sm"
                  />
                  <span className="text-muted-foreground">{fromNow(new Date(attempt.startedAtMillis))}</span>
                </div>
                {attempt.error != null && (
                  <p className="mt-1 font-mono text-red-600 dark:text-red-400">{attempt.error.name}: {attempt.error.message}</p>
                )}
                {attempt.logs != null && (
                  <pre className="mt-2 max-h-32 overflow-auto rounded bg-foreground/[0.03] p-2 font-mono text-[11px] text-foreground/70">{attempt.logs}</pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trigger payload</h3>
        <pre className="max-h-48 overflow-auto rounded bg-foreground/[0.03] p-2 font-mono text-[11px] text-foreground/80">
          {JSON.stringify(details.triggerPayload, null, 2)}
        </pre>
      </div>
    </div>
  );
}
