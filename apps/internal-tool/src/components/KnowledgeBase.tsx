import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useState, useMemo, useId } from "react";
import { format } from "date-fns";
import { clsx } from "clsx";
import type { QaEntriesRow } from "../types";
import { toDate } from "../utils";
import { Alert, Badge, Button, type ButtonVariant, EmptyState, FieldLabel, Input, ModalDialog, Panel, PanelRow, Textarea } from "./design";
import { MultiFilter } from "./FilterFields";

const KB_STATUS_OPTIONS = [
  { value: "published", label: "Published" },
  { value: "draft", label: "Draft" },
] as const;
type KbStatus = typeof KB_STATUS_OPTIONS[number]["value"];

export function KnowledgeBase({ rows, connectionState, connectionErrorMessage, onSave, onDelete }: {
  rows: QaEntriesRow[];
  connectionState: "connecting" | "connected" | "error";
  connectionErrorMessage: string | null;
  onSave: (qaId: bigint, question: string, answer: string, publish: boolean) => Promise<void> | void;
  onDelete: (qaId: bigint) => Promise<void> | void;
}) {
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<KbStatus>>(new Set());
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<bigint | null>(null);

  const kbRows = useMemo(() => {
    let result = rows;

    if (statusFilter.size > 0) {
      result = result.filter(r => statusFilter.has(r.published ? "published" : "draft"));
    }

    if (search) {
      const lower = search.toLowerCase();
      result = result.filter(r =>
        r.question.toLowerCase().includes(lower) ||
        r.answer.toLowerCase().includes(lower)
      );
    }

    return result.slice().sort((a, b) => {
      const aTime = a.lastPublishedAt ? Number(toDate(a.lastPublishedAt)) : Number(toDate(a.createdAt));
      const bTime = b.lastPublishedAt ? Number(toDate(b.lastPublishedAt)) : Number(toDate(b.createdAt));
      return bTime - aTime;
    });
  }, [rows, statusFilter, search]);

  const publishedCount = rows.filter(r => r.published).length;
  const draftCount = rows.filter(r => !r.published).length;

  return (
    <div>
      <Panel className="mb-4">
        <PanelRow className="gap-x-2">
          <Input
            type="search"
            aria-label="Search Q&A entries"
            placeholder="Search questions and answers…"
            className="min-w-64 flex-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <MultiFilter
            label="Status"
            controlClassName="w-32"
            options={KB_STATUS_OPTIONS.map(option => ({
              ...option,
              label: `${option.label} · ${option.value === "published" ? publishedCount : draftCount}`,
            }))}
            selected={statusFilter}
            onChange={setStatusFilter}
          />
        </PanelRow>
      </Panel>

      {/* List */}
      {connectionState === "error" ? (
        <Alert>{connectionErrorMessage ?? "Unable to load Q&A entries."}</Alert>
      ) : connectionState === "connecting" ? (
        <EmptyState className="py-12">
          <p className="text-sm">Loading Q&A entries...</p>
        </EmptyState>
      ) : kbRows.length === 0 ? (
        <EmptyState className="py-12">
          <p className="text-sm">No Q&A entries yet</p>
          <p className="mt-1 text-xs">Add one with the "+ Add Q&A" button above</p>
        </EmptyState>
      ) : (
        <Panel>
          {kbRows.map(row => (
            <KbCard
              key={String(row.id)}
              row={row}
              isEditing={editingId === row.id}
              onStartEdit={() => setEditingId(row.id)}
              onCancelEdit={() => setEditingId(null)}
              onSave={async (question, answer, publish) => {
                await onSave(row.id, question, answer, publish);
                setEditingId(prev => (prev === row.id ? null : prev));
              }}
              onDelete={async () => {
                await onDelete(row.id);
              }}
            />
          ))}
        </Panel>
      )}
    </div>
  );
}

type PendingAction = "publish" | "unpublish" | "delete" | null;

/**
 * `confirmVariant` picks a Button variant rather than taking a colour class: the design `cn` does
 * not merge Tailwind classes, so an extra `bg-*` on top of the variant's own background would
 * leave two competing declarations and let stylesheet order decide which wins.
 */
function ConfirmDialog({ title, message, confirmLabel, confirmVariant = "default", onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const messageId = useId();

  return (
    <ModalDialog labelledBy={titleId} describedBy={messageId} onClose={onCancel} className="max-w-md">
      <div className="p-5">
        <h2 id={titleId} className="text-base font-semibold text-foreground text-balance">{title}</h2>
        <p id={messageId} className="mt-2 max-w-[65ch] text-sm leading-5 text-muted-foreground text-pretty">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button autoFocus onClick={onCancel}>Cancel</Button>
          <Button variant={confirmVariant} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </ModalDialog>
  );
}

type BusyAction = "save-draft" | "save-publish" | "publish" | "unpublish" | "delete";

const BUSY_ACTION_LABELS: ReadonlyMap<BusyAction, string> = new Map([
  ["save-draft", "save draft"],
  ["save-publish", "publish"],
  ["publish", "publish"],
  ["unpublish", "unpublish"],
  ["delete", "delete"],
]);

function KbCard({ row, isEditing, onStartEdit, onCancelEdit, onSave, onDelete }: {
  row: QaEntriesRow;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (question: string, answer: string, publish: boolean) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const isManual = row.sourceMcpCorrelationId == null;

  const [editQuestion, setEditQuestion] = useState(row.question);
  const [editAnswer, setEditAnswer] = useState(row.answer);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const runAction = async (action: BusyAction, fn: () => Promise<void>) => {
    if (busy != null) return;
    setBusy(action);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      captureError(`knowledge-base-${action}`, err);
      const label = BUSY_ACTION_LABELS.get(action) ?? action;
      setActionError(`Failed to ${label}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const hasUnsavedChanges = editQuestion !== row.question || editAnswer !== row.answer;
  const saveAction = hasUnsavedChanges
    ? { label: "Save Draft", publish: false, isDraft: true }
    : { label: row.published ? "Update" : "Publish", publish: true, isDraft: false };

  const errorBanner = actionError != null && (
    <Alert size="sm">{actionError}</Alert>
  );

  if (isEditing) {
    return (
      <div className="space-y-3 bg-foreground/[0.02] p-4">
        <label className="block">
          <FieldLabel className="mb-1 block">Question</FieldLabel>
          <Input
            type="text"
            className="h-9 px-3 text-sm"
            value={editQuestion}
            onChange={(e) => setEditQuestion(e.target.value)}
          />
        </label>
        <label className="block">
          <FieldLabel className="mb-1 block">Answer</FieldLabel>
          <Textarea
            className="h-32 resize-y px-3 py-2 font-mono text-sm"
            value={editAnswer}
            onChange={(e) => setEditAnswer(e.target.value)}
          />
        </label>
        {errorBanner}
        <div className="flex items-center gap-2 justify-end">
          <Button variant="ghost" onClick={onCancelEdit} disabled={busy != null}>Cancel</Button>
          <Button
            variant={saveAction.isDraft ? "outline" : "default"}
            onClick={() => runAsynchronously(runAction(
              saveAction.publish ? "save-publish" : "save-draft",
              () => onSave(editQuestion, editAnswer, saveAction.publish),
            ))}
            disabled={busy != null}
          >
            {busy != null ? "Saving…" : saveAction.label}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          {row.published
            ? <Badge color="green" size="xs">&#10003; Published</Badge>
            : <Badge color="orange" size="xs">Draft</Badge>}
          {isManual && (
            <span className="text-[10px] text-muted-foreground">manual</span>
          )}
          {row.lastPublishedAt && (
            <span className="text-[10px] text-muted-foreground">
              {format(toDate(row.lastPublishedAt), "MMM d, yyyy")}
            </span>
          )}
          {row.lastEditedBy && (
            <span className="text-[10px] text-muted-foreground">by {row.lastEditedBy}</span>
          )}
        </div>
        {errorBanner}
        <p className="text-sm font-medium text-foreground">{row.question}</p>
        <p className="line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">{row.answer}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="xs" variant="ghost" onClick={onStartEdit} disabled={busy != null}>
            Edit
        </Button>
        {row.published ? (
          <Button size="xs" variant="ghost" onClick={() => setPending("unpublish")} disabled={busy != null}>
            {busy === "unpublish" ? "Unpublishing…" : "Unpublish"}
          </Button>
        ) : (
          <Button size="xs" variant="ghost" onClick={() => setPending("publish")} disabled={busy != null}>
            {busy === "publish" ? "Publishing…" : "Publish"}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
          onClick={() => setPending("delete")}
          disabled={busy != null}
        >
          {busy === "delete" ? "Deleting…" : "Delete"}
        </Button>
      </div>

      {pending === "publish" && (
        <ConfirmDialog
          title="Publish this Q&A?"
          message="Publishing makes this Q&A visible on the public knowledge base."
          confirmLabel="Publish"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            runAsynchronously(runAction("publish", () => onSave(row.question, row.answer, true)));
          }}
        />
      )}
      {pending === "unpublish" && (
        <ConfirmDialog
          title="Unpublish this Q&A?"
          message="This Q&A will no longer appear on the public knowledge base."
          confirmLabel="Unpublish"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            runAsynchronously(runAction("unpublish", () => onSave(row.question, row.answer, false)));
          }}
        />
      )}
      {pending === "delete" && (
        <ConfirmDialog
          title="Delete this Q&A?"
          message="This permanently removes the entry. Telemetry from the originating call (if any) is preserved."
          confirmLabel="Delete"
          confirmVariant="destructive"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            runAsynchronously(runAction("delete", () => onDelete()));
          }}
        />
      )}
    </div>
  );
}
