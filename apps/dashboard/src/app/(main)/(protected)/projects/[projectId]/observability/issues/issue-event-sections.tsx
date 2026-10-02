"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignCategoryTabs,
  DesignDialog,
  DesignMenu,
  DesignSelectorDropdown,
} from "@/components/design-components";
import { Textarea } from "@/components/ui/textarea";
import { RowDetailField } from "../../analytics/shared";
import { ArrowsSplitIcon, BracketsCurlyIcon, CaretDownIcon, ChatCircleTextIcon, ClockCounterClockwiseIcon, GitBranchIcon, ListDashesIcon, PaperclipIcon, ShieldCheckIcon, TagIcon, TreeStructureIcon, UsersThreeIcon, WarningCircleIcon } from "@phosphor-icons/react";
import {
  breadcrumbTimestampMillis,
  formatIssueEventValue,
  getIssueEventPayload,
  type IssueEventField,
  type IssueExceptionValue,
} from "./issue-event";
import { formatAbsoluteTimeFromMillis, formatRelativeTimeFromMillis, getErrorMessage } from "../format";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import type { IssueDetailResponse, IssueListItem, IssueOccurrence, IssuePriority } from "./issues-data";
import { LogLevelChip } from "../log-level";
import { StackFrameList } from "./stack-frame-list";
import type { StackFrameOrder, StackFrameView } from "./stack-frames";
import { IssueReleaseContextSection } from "./issue-release-context";
import { useMemo, useState } from "react";

type IssueTeamOption = { id: string, displayName: string };
type IssueSelectOption = { id: string, label: string };

const OWNER_SOURCE_LABELS = new Map([
  ["manual", "Manual"],
  ["ownership_rule", "Ownership rule"],
  ["codeowners", "CODEOWNERS"],
  ["suspect_commit", "Suspect commit"],
  ["seer_suggested", "Suggested"],
]);

function ownerSourceLabel(source: string): string {
  return OWNER_SOURCE_LABELS.get(source) ?? source;
}

function stackFrameView(frame: IssueExceptionValue["frames"][number]): StackFrameView {
  const view: StackFrameView = {
    filename: frame.filename,
    function: frame.function,
    module: frame.module,
    abs_path: frame.abs_path,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
    symbolication: frame.symbolication,
  };
  if (frame.debug_id !== undefined) view.debug_id = frame.debug_id;
  if (frame.context !== undefined) view.context = frame.context;
  return view;
}

function startTriageAction(action: () => Promise<void>): void {
  runAsynchronously(action);
}

function EventFieldGrid({ fields }: { fields: readonly IssueEventField[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {fields.map((field) => (
        <div key={field.key} className="min-w-0 rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-foreground/[0.06]">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{field.key}</div>
          <div className="mt-1 break-words font-mono text-xs text-foreground">{formatIssueEventValue(field.value)}</div>
        </div>
      ))}
    </div>
  );
}

function ExceptionValue({ value, frameOrder }: { value: IssueExceptionValue, frameOrder: StackFrameOrder }) {
  return (
    <li className="space-y-3 rounded-xl bg-foreground/[0.02] p-3 ring-1 ring-foreground/[0.07]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DesignBadge label={`Cause ${value.index}`} color="orange" size="sm" />
            <span className="font-mono text-sm font-medium text-foreground">{value.type ?? "Unknown exception"}</span>
          </div>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            {value.value ?? "Exception message unavailable"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {value.mechanism != null && <DesignBadge label={value.mechanism} color="zinc" size="sm" />}
          {value.handled != null && (
            <DesignBadge label={value.handled ? "Handled" : "Unhandled"} color={value.handled ? "zinc" : "red"} size="sm" />
          )}
        </div>
      </div>
      {(value.frames.length > 0 || value.rawStack != null) && (
        <StackFrameList frames={value.frames.map(stackFrameView)} rawStack={value.rawStack} order={frameOrder} />
      )}
      {value.frames.length === 0 && value.rawStack == null && (
        <div className="text-xs text-muted-foreground/70">No stack trace retained for this exception link.</div>
      )}
    </li>
  );
}

export function IssueExceptionCauses({
  occurrence,
  frameOrder,
}: {
  occurrence: IssueOccurrence,
  frameOrder: StackFrameOrder,
}) {
  const payload = getIssueEventPayload(occurrence);
  const causes = payload.exceptionChain.slice(0, -1).reverse();
  if (causes.length === 0) return null;

  return (
    <div className="mt-4 border-t border-foreground/[0.06] pt-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Additional causes
      </div>
      <ol className="space-y-3">
        {causes.map((value) => <ExceptionValue key={value.index} value={value} frameOrder={frameOrder} />)}
      </ol>
    </div>
  );
}

function RequestContextSection({ occurrence }: { occurrence: IssueOccurrence }) {
  const request = getIssueEventPayload(occurrence).safeRequest;
  if (request == null || request.fields.length === 0) return null;

  return (
    <DesignCard title="Request context" subtitle="Allowlisted fields only" icon={ShieldCheckIcon}>
      <div className="space-y-3">
        <EventFieldGrid fields={request.fields} />
        <p className="text-[11px] text-muted-foreground/70">Only URL, method, and status are rendered from request data.</p>
      </div>
    </DesignCard>
  );
}

function TagsSection({ occurrence }: { occurrence: IssueOccurrence }) {
  const tags = getIssueEventPayload(occurrence).tags;
  if (tags.length === 0) return null;

  return (
    <DesignCard title="Tags" subtitle="Occurrence-scoped labels" icon={TagIcon}>
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <div key={tag.key} className="flex min-w-0 items-center gap-1.5 rounded-lg bg-foreground/[0.03] px-2 py-1 ring-1 ring-foreground/[0.06]">
            <span className="max-w-48 truncate font-mono text-[11px] text-muted-foreground" title={tag.key}>{tag.key}</span>
            <DesignBadge label={formatIssueEventValue(tag.value)} color="zinc" size="sm" />
          </div>
        ))}
      </div>
    </DesignCard>
  );
}

function ContextsSection({ occurrence }: { occurrence: IssueOccurrence }) {
  const contexts = getIssueEventPayload(occurrence).contexts;
  if (contexts.length === 0) return null;

  return (
    <DesignCard title="Contexts" subtitle="Structured occurrence context" icon={BracketsCurlyIcon}>
      <div className="space-y-4">
        {contexts.map((context) => <RowDetailField key={context.key} column={context.key} value={context.value} />)}
      </div>
    </DesignCard>
  );
}

function BreadcrumbsSection({ occurrence, nowMs }: { occurrence: IssueOccurrence, nowMs: number }) {
  const breadcrumbs = getIssueEventPayload(occurrence).breadcrumbs;
  if (breadcrumbs.length === 0) return null;

  return (
    <DesignCard title="Breadcrumbs" subtitle="Events leading up to this occurrence" icon={ListDashesIcon}>
      <ol className="space-y-2">
        {breadcrumbs.map((breadcrumb) => {
          const timestamp = breadcrumb.timestamp == null ? null : breadcrumbTimestampMillis(breadcrumb.timestamp);
          return (
            <li key={breadcrumb.index} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-l border-foreground/[0.12] pl-3">
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground/70" title={timestamp == null ? undefined : formatAbsoluteTimeFromMillis(timestamp)}>
                {timestamp == null ? "No time" : formatRelativeTimeFromMillis(timestamp, nowMs)}
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {breadcrumb.level != null && <LogLevelChip level={breadcrumb.level} />}
                  {breadcrumb.category != null && <DesignBadge label={breadcrumb.category} color="zinc" size="sm" />}
                </div>
                <p className="mt-1 break-words text-xs text-foreground">{breadcrumb.message ?? "Breadcrumb message unavailable"}</p>
                {breadcrumb.data != null && Object.keys(breadcrumb.data).length > 0 && (
                  <div className="mt-2">
                    <RowDetailField column="data" value={breadcrumb.data} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </DesignCard>
  );
}

function GroupingSection({
  issue,
  occurrence,
  actionLoading,
  onUnmerge,
}: {
  issue: IssueListItem,
  occurrence: IssueOccurrence | null,
  actionLoading: boolean,
  onUnmerge: (hashes: string[]) => Promise<void>,
}) {
  const payload = occurrence == null ? null : getIssueEventPayload(occurrence);
  const provenance = occurrence?.grouping_provenance ?? [];
  const [selectedHashes, setSelectedHashes] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unmergeError, setUnmergeError] = useState<string | null>(null);
  const [unmergeBusy, setUnmergeBusy] = useState(false);
  const canUnmerge = issue.issue_hashes.length >= 2;
  const selectedSet = new Set(selectedHashes);
  const evidence: IssueEventField[] = [
    ...payload?.fingerprint.length ? [{ key: "Event fingerprint", value: payload.fingerprint }] : [],
    ...payload?.fingerprintOverride.length ? [{ key: "Fingerprint override", value: payload.fingerprintOverride }] : [],
  ];

  const confirmUnmerge = async () => {
    if (selectedHashes.length === 0 || selectedHashes.length >= issue.issue_hashes.length || unmergeBusy) return;
    setUnmergeError(null);
    setUnmergeBusy(true);
    try {
      await onUnmerge(selectedHashes);
      setConfirmOpen(false);
      setSelectedHashes([]);
    } catch (error) {
      setUnmergeError(getErrorMessage(error));
    } finally {
      setUnmergeBusy(false);
    }
  };

  return (
    <DesignCard title="Grouping explanation" subtitle="Why these events share an issue" icon={TreeStructureIcon}>
      {evidence.length > 0 && (
        <div className="space-y-3">
          {evidence.map((field) => <RowDetailField key={field.key} column={field.key} value={field.value} />)}
        </div>
      )}
      {provenance.length > 0 ? (
        <ol className={`space-y-2 ${evidence.length > 0 ? "mt-3" : ""}`}>
          {provenance.map((entry) => (
            <li key={`${entry.role}-${entry.hash}`} className="rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-foreground/[0.06]">
              <div className="flex flex-wrap items-center gap-1.5">
                <DesignBadge label={entry.role} color={entry.role === "primary" ? "blue" : "zinc"} size="sm" />
                <DesignBadge label={entry.variant} color="zinc" size="sm" />
                <span className="font-mono text-[11px] text-muted-foreground">{entry.config_id}</span>
              </div>
              <div className="mt-1 break-all font-mono text-xs text-foreground">{entry.hash}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                {entry.fingerprint.type} · {entry.fingerprint.source}
                {entry.fingerprint.resolved_tokens.length > 0 ? ` · ${entry.fingerprint.resolved_tokens.join(" · ")}` : ""}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className={`text-xs text-muted-foreground ${evidence.length > 0 ? "mt-3" : ""}`}>
          No grouping provenance was retained for this occurrence. The issue hashes below are still the live mapping.
        </p>
      )}
      <div className="mt-3 border-t border-foreground/[0.06] pt-3">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Owned hashes</div>
        <ul className="space-y-1.5">
          {issue.issue_hashes.map((hash) => (
            <li key={hash}>
              <button
                type="button"
                disabled={!canUnmerge || actionLoading || unmergeBusy}
                onClick={() => setSelectedHashes((current) => current.includes(hash) ? current.filter((value) => value !== hash) : [...current, hash])}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:transition-none hover:bg-foreground/[0.04] disabled:opacity-50"
              >
                <span className={`h-3.5 w-3.5 shrink-0 rounded border ${selectedSet.has(hash) ? "border-primary bg-primary" : "border-foreground/30"}`} />
                <span className="min-w-0 break-all font-mono text-xs">{hash}</span>
              </button>
            </li>
          ))}
        </ul>
        {canUnmerge && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground/70">Select a strict subset to split into a new issue. Historical occurrences follow the moved hashes.</span>
            <DesignButton
              size="sm"
              variant="secondary"
              disabled={actionLoading || selectedHashes.length === 0 || selectedHashes.length >= issue.issue_hashes.length}
              onClick={() => {
                setUnmergeError(null);
                setConfirmOpen(true);
              }}
              className="gap-1.5"
            >
              <ArrowsSplitIcon className="h-3.5 w-3.5" />
              Unmerge
            </DesignButton>
          </div>
        )}
      </div>
      <DesignDialog
        open={confirmOpen}
        onOpenChange={(nextOpen) => {
          if (unmergeBusy) return;
          setConfirmOpen(nextOpen);
          if (!nextOpen) setUnmergeError(null);
        }}
        size="sm"
        variant="plain"
        icon={ArrowsSplitIcon}
        title={`Split ${selectedHashes.length} hash${selectedHashes.length === 1 ? "" : "es"} into a new issue?`}
        description="The split is retroactive. Lifetime counters on the new issue are seeded from the retained window and marked as truncated."
        footer={(
          <div className="flex w-full justify-end gap-2">
            <DesignButton variant="secondary" disabled={unmergeBusy} onClick={() => setConfirmOpen(false)}>Cancel</DesignButton>
            <DesignButton variant="default" loading={unmergeBusy} disabled={unmergeBusy} onClick={confirmUnmerge}>Unmerge</DesignButton>
          </div>
        )}
      >
        {unmergeError != null && <DesignAlert variant="error" title="Couldn't unmerge" description={unmergeError} />}
      </DesignDialog>
    </DesignCard>
  );
}

function SymbolicationDiagnosticsSection({ occurrence }: { occurrence: IssueOccurrence }) {
  const payload = getIssueEventPayload(occurrence);
  const diagnostics = [
    ...occurrence.symbolication_diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      debugId: diagnostic.debug_id ?? null,
      codeFile: diagnostic.code_file ?? null,
      line: diagnostic.line ?? null,
      column: diagnostic.column ?? null,
    })),
    ...payload.symbolicationDiagnostics,
  ].filter((diagnostic, index, all) => all.findIndex((candidate) => candidate.code === diagnostic.code && candidate.message === diagnostic.message) === index);
  if (diagnostics.length === 0) return null;
  return (
    <DesignCard title="Symbolication" subtitle="Source-map lookup results for this occurrence" icon={WarningCircleIcon}>
      <ul className="space-y-2">
        {diagnostics.map((diagnostic, index) => (
          <li key={`${diagnostic.code}-${index}`} className="rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-foreground/[0.06]">
            <div className="flex flex-wrap items-center gap-1.5">
              <DesignBadge label={diagnostic.code} color="orange" size="sm" />
              {diagnostic.debugId != null && <span className="font-mono text-[11px] text-muted-foreground">{diagnostic.debugId}</span>}
            </div>
            <p className="mt-1 break-words text-xs text-foreground">{diagnostic.message}</p>
            {(diagnostic.codeFile != null || diagnostic.line != null) && (
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                {diagnostic.codeFile ?? "unknown file"}
                {diagnostic.line != null ? `:${diagnostic.line}` : ""}
                {diagnostic.column != null ? `:${diagnostic.column}` : ""}
              </div>
            )}
          </li>
        ))}
      </ul>
    </DesignCard>
  );
}

function AdditionalEventDataSection({ occurrence }: { occurrence: IssueOccurrence }) {
  const payload = getIssueEventPayload(occurrence);
  const fields = [
    ...payload.extra.map((field) => ({ ...field, key: `extra.${field.key}` })),
    ...payload.additionalData,
  ];
  if (fields.length === 0) return null;

  return (
    <DesignCard title="Additional event data" subtitle="Safe fields not rendered in a dedicated section" icon={BracketsCurlyIcon}>
      <div className="space-y-4">
        {fields.map((field) => <RowDetailField key={field.key} column={field.key} value={field.value} />)}
      </div>
    </DesignCard>
  );
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function AttachmentsSection({ occurrence }: { occurrence: IssueOccurrence }) {
  if (occurrence.attachments.length === 0) return null;

  return (
    <DesignCard title="Attachments" subtitle="Private event files" icon={PaperclipIcon}>
      <ul className="space-y-2">
        {occurrence.attachments.map((attachment) => (
          <li key={attachment.id} className="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-foreground/[0.06]">
            <div className="min-w-0">
              <a className="truncate text-sm font-medium text-foreground underline-offset-2 hover:underline" href={attachment.download_path} download={attachment.filename}>
                {attachment.filename}
              </a>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                <span>{attachment.content_type}</span>
                <span>{formatAttachmentBytes(attachment.byte_length)}</span>
                <span>{attachment.attachment_type}</span>
              </div>
            </div>
            <DesignBadge label={attachment.sha256.slice(0, 12)} color="zinc" size="sm" />
          </li>
        ))}
      </ul>
    </DesignCard>
  );
}

export function IssueProductSection({
  detail,
  onPriorityChange,
  onAddComment,
  currentUserId,
  ownerTeam,
  assigneeOptions,
  actionLoading,
  onAssignmentChange,
  onTeamChange,
  onOwnerChange,
  onBookmarkChange,
  onSubscriptionChange,
  onTeamSubscriptionChange,
}: {
  detail: IssueDetailResponse,
  onPriorityChange: (priority: IssuePriority | null) => Promise<void>,
  onAddComment: (body: string) => Promise<void>,
  currentUserId: string,
  ownerTeam: IssueTeamOption,
  assigneeOptions: readonly IssueSelectOption[],
  actionLoading: boolean,
  onAssignmentChange: (userId: string | null) => Promise<void>,
  onTeamChange: () => Promise<void>,
  onOwnerChange: (type: "user" | "team" | "none", id: string | null) => Promise<void>,
  onBookmarkChange: (bookmarked: boolean) => Promise<void>,
  onSubscriptionChange: (subscribed: boolean) => Promise<void>,
  onTeamSubscriptionChange: (subscribed: boolean) => Promise<void>,
}) {
  const product = detail.product;
  const priorityColor = product.priority === "high" ? "red" : product.priority === "medium" ? "orange" : "zinc";
  const recentActivities = product.activities.slice(0, 5);
  const recentComments = product.comments.slice(0, 5);
  const [commentDraft, setCommentDraft] = useState("");
  const [commentError, setCommentError] = useState<string | null>(null);
  const [commentSaving, setCommentSaving] = useState(false);
  const [triageOpen, setTriageOpen] = useState(true);
  const isBookmarked = product.bookmarked_user_ids.includes(currentUserId);
  const isSubscribed = product.subscriptions.some((subscription) => subscription.type === "user" && subscription.id === currentUserId && subscription.is_active);
  const isTeamSubscribed = product.subscriptions.some((subscription) => subscription.type === "team" && subscription.id === ownerTeam.id && subscription.is_active);
  const assignedTeamLabel = product.team_id == null
    ? null
    : product.team_id === ownerTeam.id
      ? ownerTeam.displayName
      : product.team_id;
  const assignedUser = assigneeOptions.find((user) => user.id === product.assignee_user_id);
  const manualOwner = product.owners.find((owner) => owner.source === "manual");
  const ownerValue = manualOwner?.type === "user" && manualOwner.user_id === currentUserId
    ? "user:self"
    : manualOwner?.type === "team" && manualOwner.team_id === ownerTeam.id
      ? `team:${ownerTeam.id}`
      : "none";
  const ownerOptions = useMemo(() => [
    { value: "none", label: "No manual owner" },
    { value: "user:self", label: "You" },
    { value: `team:${ownerTeam.id}`, label: `Team · ${ownerTeam.displayName}` },
  ], [ownerTeam]);

  const submitComment = async () => {
    const body = commentDraft.trim();
    if (body === "") {
      setCommentError("Write a comment before saving it.");
      return;
    }
    setCommentError(null);
    setCommentSaving(true);
    try {
      await onAddComment(body);
      setCommentDraft("");
    } catch (error) {
      setCommentError(getErrorMessage(error));
    } finally {
      setCommentSaving(false);
    }
  };

  return (
    <DesignCard
      title="Triage"
      icon={UsersThreeIcon}
      actions={
        <div className="flex items-center gap-1">
          <DesignButton
            type="button"
            variant="ghost"
            size="icon"
            aria-controls={triageOpen ? "issue-triage-content" : undefined}
            aria-expanded={triageOpen}
            aria-label={triageOpen ? "Collapse triage panel" : "Expand triage panel"}
            onClick={() => setTriageOpen((open) => !open)}
          >
            <CaretDownIcon className={`h-3.5 w-3.5 transition-transform duration-150 ${triageOpen ? "rotate-180" : ""}`} aria-hidden="true" />
          </DesignButton>
          <DesignMenu
            variant="actions"
            align="end"
            items={[
              { id: "priority-none", label: "Clear priority", onClick: async () => await onPriorityChange(null) },
              { id: "priority-low", label: "Set low priority", onClick: async () => await onPriorityChange("low") },
              { id: "priority-medium", label: "Set medium priority", onClick: async () => await onPriorityChange("medium") },
              { id: "priority-high", label: "Set high priority", onClick: async () => await onPriorityChange("high") },
            ]}
          />
        </div>
      }
    >
      {triageOpen ? <div id="issue-triage-content" className="space-y-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Priority</span>
            {product.priority == null
              ? <span className="text-xs text-muted-foreground">Unset</span>
              : <DesignBadge label={product.priority} color={priorityColor} size="sm" />}
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="issue-assignee">Assignee</label>
              <span className="min-w-0 truncate text-xs text-foreground" title={assignedUser?.label ?? product.assignee_user_id ?? undefined}>
                {product.assignee_user_id === currentUserId ? "You" : assignedUser?.label ?? (product.assignee_user_id == null ? "Unassigned" : product.assignee_user_id)}
              </span>
            </div>
            <DesignSelectorDropdown
              value={product.assignee_user_id ?? "none"}
              options={[
                { value: "none", label: "Unassigned" },
                ...assigneeOptions.map((user) => ({ value: user.id, label: user.label })),
              ]}
              disabled={actionLoading}
              triggerId="issue-assignee"
              triggerClassName="w-full"
              onValueChange={(value) => startTriageAction(async () => await onAssignmentChange(value === "none" ? null : value))}
            />
            <div className="flex flex-wrap gap-2">
              <DesignButton size="sm" variant="secondary" loading={actionLoading} onClick={() => onAssignmentChange(currentUserId)}>
                Assign to me
              </DesignButton>
              <DesignButton size="sm" variant="ghost" disabled={actionLoading || product.assignee_user_id == null} onClick={() => onAssignmentChange(null)}>
                Unassign
              </DesignButton>
            </div>
          </div>
          <div className="space-y-1.5 border-t border-foreground/[0.06] pt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Team</span>
              <span className="min-w-0 truncate text-xs text-foreground" title={assignedTeamLabel ?? undefined}>
                {assignedTeamLabel ?? "Unassigned"}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">Issues can only belong to the project owner team.</p>
            {product.team_id !== ownerTeam.id && (
              <DesignButton size="sm" variant="secondary" loading={actionLoading} onClick={() => onTeamChange()}>
                Assign to {ownerTeam.displayName}
              </DesignButton>
            )}
          </div>
          <div className="space-y-1.5 border-t border-foreground/[0.06] pt-3">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground" htmlFor="issue-owner">Manual owner</label>
            <DesignSelectorDropdown
              value={ownerValue}
              options={ownerOptions}
              disabled={actionLoading}
              triggerId="issue-owner"
              triggerClassName="w-full"
              onValueChange={(value) => {
                if (value === "none") startTriageAction(async () => await onOwnerChange("none", null));
                else if (value === "user:self") startTriageAction(async () => await onOwnerChange("user", currentUserId));
                else if (value === `team:${ownerTeam.id}`) startTriageAction(async () => await onOwnerChange("team", ownerTeam.id));
              }}
            />
            <p className="text-[11px] text-muted-foreground">Rule and code-owner records remain visible below.</p>
          </div>
        </div>

        <div className="border-t border-foreground/[0.06] pt-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Watching</div>
          <div className="flex flex-wrap gap-2">
            <DesignButton size="sm" variant={isBookmarked ? "secondary" : "ghost"} loading={actionLoading} onClick={() => onBookmarkChange(!isBookmarked)}>
              {isBookmarked ? "Bookmarked" : "Bookmark"}
            </DesignButton>
            <DesignButton size="sm" variant={isSubscribed ? "secondary" : "ghost"} loading={actionLoading} onClick={() => onSubscriptionChange(!isSubscribed)}>
              {isSubscribed ? "Subscribed" : "Subscribe"}
            </DesignButton>
            <DesignButton size="sm" variant={isTeamSubscribed ? "secondary" : "ghost"} loading={actionLoading} onClick={() => onTeamSubscriptionChange(!isTeamSubscribed)}>
              {isTeamSubscribed ? "Team subscribed" : "Subscribe team"}
            </DesignButton>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">Team subscribe notifies {ownerTeam.displayName}.</p>
        </div>

        {product.owners.length > 0 && (
          <div className="border-t border-foreground/[0.06] pt-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Owners</div>
            <ul className="space-y-1.5">
              {product.owners.map((owner) => (
                <li key={owner.id} className="flex flex-wrap items-center gap-1.5 text-xs">
                  <DesignBadge label={ownerSourceLabel(owner.source)} color={owner.source === "manual" ? "blue" : "zinc"} size="sm" />
                  <span className="truncate">
                    {owner.type === "user"
                      ? (owner.user_id === currentUserId ? "You" : assigneeOptions.find((user) => user.id === owner.user_id)?.label ?? owner.user_id)
                      : owner.team_id === ownerTeam.id ? ownerTeam.displayName : owner.team_id}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(recentActivities.length > 0 || recentComments.length > 0) && (
          <div className="space-y-4 border-t border-foreground/[0.06] pt-3">
            {recentActivities.length > 0 && (
              <div className="min-w-0">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recent activity</div>
                <ol className="space-y-2">
                  {recentActivities.map((activity) => (
                    <li key={activity.id} className="border-l border-foreground/[0.12] pl-2 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <DesignBadge label={activity.type} color="zinc" size="sm" />
                        <span className="font-mono text-[10px] text-muted-foreground">{activity.occurred_at}</span>
                      </div>
                      {activity.actor_user_id != null && <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">actor {activity.actor_user_id}</div>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {recentComments.length > 0 && (
              <div className="min-w-0">
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recent comments</div>
                <ol className="space-y-2">
                  {recentComments.map((comment) => (
                    <li key={comment.id} className="border-l border-foreground/[0.12] pl-2 text-xs">
                      <p className="line-clamp-3 break-words text-foreground">{comment.body}</p>
                      <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{comment.author_user_id} · {comment.created_at}</div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        <div className="border-t border-foreground/[0.06] pt-3">
          <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <ChatCircleTextIcon className="h-3.5 w-3.5" />
            Add comment
          </div>
          <Textarea
            value={commentDraft}
            onChange={(event) => setCommentDraft(event.target.value)}
            placeholder="Record the next triage step…"
            maxLength={10_000}
            rows={3}
            className="resize-y text-xs"
            aria-label="Issue comment"
          />
          {commentError != null && (
            <DesignAlert className="mt-2" variant="error" title="Couldn't add comment" description={commentError} />
          )}
          <div className="mt-2 flex justify-end">
            <DesignButton size="sm" variant="secondary" loading={commentSaving} onClick={submitComment}>Comment</DesignButton>
          </div>
        </div>
      </div> : null}
    </DesignCard>
  );
}

function OccurrenceMetadataSection({
  occurrence,
  nowMs,
}: {
  occurrence: IssueOccurrence,
  nowMs: number,
}) {
  const eventId = getIssueEventPayload(occurrence).eventId;
  return (
    <DesignCard title="Occurrence" subtitle="Identifiers for the selected retained event" icon={ClockCounterClockwiseIcon}>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{eventId == null ? "Occurrence ID" : "Event ID"}</div>
          <div className="mt-1 truncate font-mono text-xs text-foreground" title={eventId ?? occurrence.occurrence_id}>{eventId ?? occurrence.occurrence_id}</div>
        </div>
        {eventId != null && (
          <div className="min-w-0">
            <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Occurrence ID</div>
            <div className="mt-1 truncate font-mono text-xs text-foreground" title={occurrence.occurrence_id}>{occurrence.occurrence_id}</div>
          </div>
        )}
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Captured</div>
          <div className="mt-1 text-xs text-foreground" title={formatAbsoluteTimeFromMillis(occurrence.event_at_millis)}>
            {formatRelativeTimeFromMillis(occurrence.event_at_millis, nowMs)}
          </div>
        </div>
      </div>
    </DesignCard>
  );
}

type IssueDetailTab = "event" | "grouping" | "releases";

function parseIssueDetailTab(id: string): IssueDetailTab {
  if (id === "event" || id === "grouping" || id === "releases") return id;
  throw new Error(`Unknown issue detail tab: ${id}`);
}

function eventSectionCount(occurrence: IssueOccurrence | null): number {
  if (occurrence == null) return 0;
  const payload = getIssueEventPayload(occurrence);
  const diagnostics = occurrence.symbolication_diagnostics.length + payload.symbolicationDiagnostics.length;
  return 1
    + (payload.safeRequest != null && payload.safeRequest.fields.length > 0 ? 1 : 0)
    + (payload.tags.length > 0 ? 1 : 0)
    + (payload.contexts.length > 0 ? 1 : 0)
    + (payload.breadcrumbs.length > 0 ? 1 : 0)
    + (occurrence.attachments.length > 0 ? 1 : 0)
    + (payload.extra.length + payload.additionalData.length > 0 ? 1 : 0)
    + (diagnostics > 0 ? 1 : 0);
}

function releaseSectionCount(context: IssueDetailResponse["release_context"]): number {
  return (context.first_release == null ? 0 : 1)
    + (context.last_release == null || context.last_release.id === context.first_release?.id ? 0 : 1)
    + context.release_commits.length
    + context.suspect_commits.length;
}

export function IssueEventSections({
  issue,
  occurrence,
  detail,
  nowMs,
  actionLoading,
  onUnmerge,
}: {
  issue: IssueListItem,
  occurrence: IssueOccurrence | null,
  detail: IssueDetailResponse,
  nowMs: number,
  actionLoading: boolean,
  onUnmerge: (hashes: string[]) => Promise<void>,
}) {
  const [selectedTab, setSelectedTab] = useState<IssueDetailTab>("event");
  const categories = useMemo(() => [
    {
      id: "event",
      label: "Event",
      icon: BracketsCurlyIcon,
      count: eventSectionCount(occurrence),
    },
    {
      id: "grouping",
      label: "Grouping",
      icon: TreeStructureIcon,
      count: issue.issue_hashes.length,
    },
    {
      id: "releases",
      label: "Releases",
      icon: GitBranchIcon,
      count: releaseSectionCount(detail.release_context),
    },
  ], [detail.release_context, issue.issue_hashes.length, occurrence]);
  const optionalEventSectionCount = Math.max(0, eventSectionCount(occurrence) - 1);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <DesignCategoryTabs
        categories={categories}
        selectedCategory={selectedTab}
        onSelect={(id) => setSelectedTab(parseIssueDetailTab(id))}
        gradient="default"
        glassmorphic
      />
      {selectedTab === "event" && (
        <div className="flex min-w-0 flex-col gap-3">
          {occurrence == null ? (
            <p className="px-1 py-3 text-sm text-muted-foreground">
              No retained occurrence is available; event context has aged out of the retention window.
            </p>
          ) : (
            <>
              <OccurrenceMetadataSection occurrence={occurrence} nowMs={nowMs} />
              <RequestContextSection occurrence={occurrence} />
              <TagsSection occurrence={occurrence} />
              <ContextsSection occurrence={occurrence} />
              <BreadcrumbsSection occurrence={occurrence} nowMs={nowMs} />
              <AttachmentsSection occurrence={occurrence} />
              <AdditionalEventDataSection occurrence={occurrence} />
              <SymbolicationDiagnosticsSection occurrence={occurrence} />
              {optionalEventSectionCount === 0 && (
                <p className="px-1 text-xs text-muted-foreground">No additional request, tag, breadcrumb, attachment, or diagnostic context was retained.</p>
              )}
            </>
          )}
        </div>
      )}
      {selectedTab === "grouping" && (
        <GroupingSection issue={issue} occurrence={occurrence} actionLoading={actionLoading} onUnmerge={onUnmerge} />
      )}
      {selectedTab === "releases" && (
        <IssueReleaseContextSection context={detail.release_context} />
      )}
    </div>
  );
}
