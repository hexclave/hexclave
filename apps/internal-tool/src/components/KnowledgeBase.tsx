import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useState, useMemo } from "react";
import { format } from "date-fns";
import { clsx } from "clsx";
import type { QaEntriesRow } from "../types";
import { toDate } from "../utils";

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
        <input
          type="text"
          placeholder="Search questions and answers..."
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-2 items-center">
          <button
            onClick={() => setFilter("all")}
            className={clsx(
              "px-2 py-1 text-xs rounded",
              filter === "all" ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            )}
          >
            All ({publishedCount + draftCount})
          </button>
          <button
            onClick={() => setFilter("published")}
            className={clsx(
              "px-2 py-1 text-xs rounded",
              filter === "published" ? "bg-green-700 text-white" : "bg-green-50 text-green-700 hover:bg-green-100"
            )}
          >
            Published ({publishedCount})
          </button>
          <button
            onClick={() => setFilter("draft")}
            className={clsx(
              "px-2 py-1 text-xs rounded",
              filter === "draft" ? "bg-amber-700 text-white" : "bg-amber-50 text-amber-700 hover:bg-amber-100"
            )}
          >
            Drafts ({draftCount})
          </button>
        </div>
      </div>

      {/* List */}
      {connectionState === "error" ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {connectionErrorMessage ?? "Unable to load Q&A entries."}
        </div>
      ) : connectionState === "connecting" ? (
        <div className="text-center text-gray-400 py-12">
          <p className="text-sm">Loading Q&A entries...</p>
        </div>
      ) : kbRows.length === 0 ? (
        <div className="text-center text-gray-400 py-12">
          <p className="text-sm">No Q&A entries yet</p>
          <p className="text-xs mt-1">Add one with the "+ Add Q&A" button above</p>
        </div>
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

type PendingAction = "edit" | "publish" | "unpublish" | "delete" | null;

function ConfirmDialog({ title, message, confirmLabel, confirmClassName, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmClassName?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-8" onClick={onCancel}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-gray-900 mb-2">{title}</h2>
        <p className="text-sm text-gray-600 mb-5">{message}</p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={clsx("px-3 py-1.5 text-xs font-medium text-white rounded-md", confirmClassName ?? "bg-blue-600 hover:bg-blue-700")}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
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

  const cardBorder = row.published ? "border-green-200" : "border-amber-200";
  const cardBg = row.published ? "bg-green-50/30" : "bg-amber-50/30";

  const hasUnsavedChanges = editQuestion !== row.question || editAnswer !== row.answer;
  const saveAction = hasUnsavedChanges
    ? { label: "Save Draft", publish: false, isDraft: true }
    : { label: row.published ? "Update" : "Publish", publish: true, isDraft: false };

  const errorBanner = actionError && (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      {actionError}
    </div>
  );

  if (isEditing) {
    return (
      <div className={`border ${cardBorder} ${cardBg} rounded-lg p-4 space-y-3`}>
        <div>
          <label className="text-[10px] uppercase text-gray-400 font-medium mb-1 block tracking-wider">Question</label>
          <input
            type="text"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            value={editQuestion}
            onChange={(e) => setEditQuestion(e.target.value)}
          />
        </div>
        <div>
          <label className="text-[10px] uppercase text-gray-400 font-medium mb-1 block tracking-wider">Answer</label>
          <textarea
            className="w-full h-32 px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y bg-white"
            value={editAnswer}
            onChange={(e) => setEditAnswer(e.target.value)}
          />
        </div>
        {errorBanner}
        <div className="flex items-center gap-2 justify-end">
          <button
            onClick={onCancelEdit}
            disabled={busy != null}
            className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 disabled:text-gray-300"
          >
            Cancel
          </button>
          <button
            onClick={() => runAsynchronously(runAction(
              saveAction.publish ? "save-publish" : "save-draft",
              () => onSave(editQuestion, editAnswer, saveAction.publish),
            ))}
            disabled={busy != null}
            className={clsx(
              "px-3 py-1.5 text-xs font-medium rounded-md transition-colors hover:transition-none",
              saveAction.isDraft
                ? "text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:text-gray-400 disabled:bg-gray-50"
                : "text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300",
            )}
          >
            {busy != null ? "Saving…" : saveAction.label}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`border ${cardBorder} ${cardBg} rounded-lg overflow-hidden`}>
      {/* Header */}
      <div className="px-4 py-2 border-b border-inherit flex items-center justify-between">
        <div className="flex items-center gap-2">
          {row.published ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800">
              &#10003; Published
            </span>
          ) : (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-800">
              Draft
            </span>
          )}
          {isManual && (
            <span className="text-[10px] text-gray-400">manual</span>
          )}
          {row.lastPublishedAt && (
            <span className="text-[10px] text-gray-400">
              {format(toDate(row.lastPublishedAt), "MMM d, yyyy")}
            </span>
          )}
          {row.lastEditedBy && (
            <span className="text-[10px] text-gray-400">by {row.lastEditedBy}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPending("edit")}
            disabled={busy != null}
            className="px-2 py-0.5 text-[10px] text-blue-600 hover:text-blue-800 disabled:text-gray-300"
          >
            Edit
          </button>
          {row.published ? (
            <button
              onClick={() => setPending("unpublish")}
              disabled={busy != null}
              className="px-2 py-0.5 text-[10px] text-amber-600 hover:text-amber-800 disabled:text-gray-300"
            >
              {busy === "unpublish" ? "Unpublishing…" : "Unpublish"}
            </button>
          ) : (
            <button
              onClick={() => setPending("publish")}
              disabled={busy != null}
              className="px-2 py-0.5 text-[10px] text-green-600 hover:text-green-800 disabled:text-gray-300"
            >
              {busy === "publish" ? "Publishing…" : "Publish"}
            </button>
          )}
          <button
            onClick={() => setPending("delete")}
            disabled={busy != null}
            className="px-2 py-0.5 text-[10px] text-red-500 hover:text-red-700 disabled:text-gray-300"
          >
            {busy === "delete" ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 py-3 space-y-1">
        {errorBanner}
        <p className="text-sm font-medium text-gray-900">{row.question}</p>
        <p className="text-xs text-gray-600 line-clamp-3 whitespace-pre-wrap">{row.answer}</p>
      </div>

      {pending === "edit" && (
        <ConfirmDialog
          title="Edit this Q&A?"
          message="You'll open the inline editor. You can cancel from there without saving."
          confirmLabel="Edit"
          onCancel={() => setPending(null)}
          onConfirm={() => {
            setPending(null);
            onStartEdit();
          }}
        />
      )}
      {pending === "publish" && (
        <ConfirmDialog
          title="Publish this Q&A?"
          message="Publishing makes this Q&A visible on the public knowledge base."
          confirmLabel="Publish"
          confirmClassName="bg-green-600 hover:bg-green-700"
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
