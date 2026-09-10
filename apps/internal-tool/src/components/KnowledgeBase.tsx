import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useState, useMemo, useId } from "react";
import { createPortal } from "react-dom";
import { format } from "date-fns";
import { clsx } from "clsx";
import type { QaEntriesRow } from "../types";
import { toDate } from "../utils";
import { Alert, Badge, Button, cn, EmptyState, FieldLabel, Input, Pill, Textarea } from "./design";

type KbFilter = "all" | "published" | "draft";

export function KnowledgeBase({ rows, connectionState, connectionErrorMessage, onSave, onDelete }: {
  rows: QaEntriesRow[];
  connectionState: "connecting" | "connected" | "error";
  connectionErrorMessage: string | null;
  onSave: (qaId: bigint, question: string, answer: string, publish: boolean) => Promise<void> | void;
  onDelete: (qaId: bigint) => Promise<void> | void;
}) {
  const [filter, setFilter] = useState<KbFilter>("all");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<bigint | null>(null);

  const kbRows = useMemo(() => {
    let result = rows;

    if (filter === "published") {
      result = result.filter(r => r.published);
    } else if (filter === "draft") {
      result = result.filter(r => !r.published);
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
  }, [rows, filter, search]);

  const publishedCount = rows.filter(r => r.published).length;
  const draftCount = rows.filter(r => !r.published).length;

  return (
    <div>
      {/* Filters */}
      <div className="mb-4 space-y-2">
        <Input
          type="text"
          placeholder="Search questions and answers..."
          className="h-9 px-3 text-sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-2 items-center">
          <Pill active={filter === "all"} onClick={() => setFilter("all")}>
            All ({publishedCount + draftCount})
          </Pill>
          <Pill active={filter === "published"} onClick={() => setFilter("published")}>
            Published ({publishedCount})
          </Pill>
          <Pill active={filter === "draft"} onClick={() => setFilter("draft")}>
            Drafts ({draftCount})
          </Pill>
        </div>
      </div>

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
        <div className="space-y-3">
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
        </div>
      )}
    </div>
  );
}

type PendingAction = "publish" | "unpublish" | "delete" | null;

function ConfirmDialog({ title, message, confirmLabel, confirmClassName, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmClassName?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const messageId = useId();
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4 sm:p-8"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onCancel();
      }}
      onKeyDown={event => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="w-full max-w-md rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-lg"
      >
        <h2 id={titleId} className="text-base font-semibold text-foreground text-balance">{title}</h2>
        <p id={messageId} className="mt-2 max-w-[65ch] text-sm leading-5 text-muted-foreground text-pretty">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button autoFocus onClick={onCancel}>Cancel</Button>
          <Button
            variant="default"
            onClick={onConfirm}
            className={cn(confirmClassName)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
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

  const cardTint = row.published
    ? "border-emerald-500/25 bg-emerald-500/[0.06]"
    : "border-amber-500/25 bg-amber-500/[0.06]";

  const hasUnsavedChanges = editQuestion !== row.question || editAnswer !== row.answer;
  const saveAction = hasUnsavedChanges
    ? { label: "Save Draft", publish: false, isDraft: true }
    : { label: row.published ? "Update" : "Publish", publish: true, isDraft: false };

  const errorBanner = actionError && (
    <Alert className="px-3 py-2 text-xs">{actionError}</Alert>
  );

  if (isEditing) {
    return (
      <div className={clsx("space-y-3 rounded-xl border p-4 backdrop-blur-xl", cardTint)}>
        <div>
          <FieldLabel className="mb-1 block">Question</FieldLabel>
          <Input
            type="text"
            className="h-9 px-3 text-sm"
            value={editQuestion}
            onChange={(e) => setEditQuestion(e.target.value)}
          />
        </div>
        <div>
          <FieldLabel className="mb-1 block">Answer</FieldLabel>
          <Textarea
            className="h-32 resize-y px-3 py-2 font-mono text-sm"
            value={editAnswer}
            onChange={(e) => setEditAnswer(e.target.value)}
          />
        </div>
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
    <div className={clsx("overflow-hidden rounded-xl border backdrop-blur-xl", cardTint)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-inherit px-4 py-2">
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
        <div className="flex items-center gap-1">
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
      </div>

      {/* Content */}
      <div className="space-y-1 px-4 py-3">
        {errorBanner}
        <p className="text-sm font-medium text-foreground">{row.question}</p>
        <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{row.answer}</p>
      </div>

      {pending === "publish" && (
        <ConfirmDialog
          title="Publish this Q&A?"
          message="Publishing makes this Q&A visible on the public knowledge base."
          confirmLabel="Publish"
          confirmClassName="bg-emerald-600 hover:bg-emerald-700"
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
          confirmClassName="bg-amber-600 hover:bg-amber-700"
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
          confirmClassName="bg-red-600 hover:bg-red-700"
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
