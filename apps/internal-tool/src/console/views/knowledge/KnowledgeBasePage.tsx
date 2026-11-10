"use client";

import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../../components/design/cn";
import { markdownComponents } from "../../../components/markdown-components";
import type { QaEntriesRow } from "../../../types";
import { toDate } from "../../../utils";
import { useConsoleData } from "../../data/console-data";
import { formatAgo } from "../../lib/format";
import { consoleHref, useQueryParam } from "../../lib/url-state";
import { DetailPanel, PageHeader, SplitView, useListNavigation } from "../../shell/Page";
import { ConnectionGate } from "../../ui/blocks";
import { Icon } from "../../ui/icons";
import { ConfirmDialog, Dialog } from "../../ui/overlays";
import { Badge, Button, Callout, Card, EmptyState, FieldLabel, Input, SearchInput, Segmented, Textarea } from "../../ui/primitives";

type StatusFilter = "all" | "published" | "draft";

function entryTime(row: QaEntriesRow): number {
  return toDate(row.lastPublishedAt ?? row.lastEditedAt).getTime();
}

export function KnowledgeBasePage() {
  const { qa, mcp } = useConsoleData();
  const [selectedId, setSelectedId] = useQueryParam("id");
  const [newParam, setNewParam] = useQueryParam("new");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");

  const publishedCount = qa.rows.filter(row => row.published).length;
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return qa.rows
      .filter(row => status === "all" || (status === "published") === row.published)
      .filter(row => needle === "" || row.question.toLowerCase().includes(needle) || row.answer.toLowerCase().includes(needle))
      .slice()
      .sort((a, b) => entryTime(b) - entryTime(a));
  }, [qa.rows, status, search]);
  const selectedRow = selectedId == null ? null : qa.rows.find(row => String(row.id) === selectedId) ?? null;
  const navigation = useListNavigation(rows, selectedId, row => String(row.id), setSelectedId);

  return (
    <>
      <PageHeader
        pageId="knowledge"
        actions={(
          <>
            <a href="/questions" target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground hover:transition-none">
              <Icon name="external" size="sm" /> Public page
            </a>
            <Button size="md" variant="primary" icon="plus" onClick={() => setNewParam("1")}>Add Q&A</Button>
          </>
        )}
      />
      <SplitView
        detail={selectedId != null && (
          <DetailPanel label="Q&A entry" onClose={() => setSelectedId(null)} {...navigation}>
            {selectedRow == null
              ? <EmptyState icon="search" title="Entry not found" description="It may have been deleted." />
              : <EntryEditor key={selectedId} row={selectedRow} sourceCallId={mcp.rows.find(call => call.correlationId === selectedRow.sourceMcpCorrelationId)?.id ?? null} onDeleted={() => setSelectedId(null)} />}
          </DetailPanel>
        )}
      >
        <ConnectionGate state={qa.connectionState} errorMessage={qa.connectionErrorMessage} hasRows={qa.rows.length > 0} source="the knowledge base">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput label="Search Q&A" placeholder="Search questions and answers…" value={search} onChange={setSearch} className="w-full max-w-sm" />
            <Segmented
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: "All", count: qa.rows.length },
                { value: "published", label: "Published", count: publishedCount },
                { value: "draft", label: "Drafts", count: qa.rows.length - publishedCount },
              ]}
            />
          </div>
          <Card>
            {rows.length === 0 ? (
              <EmptyState
                icon="book"
                title={qa.rows.length === 0 ? "No Q&A entries yet" : "No entries match"}
                description={qa.rows.length === 0 ? "Entries are created from MCP call corrections or added by hand." : "Try a different search or status."}
                action={qa.rows.length === 0 ? <Button variant="primary" icon="plus" onClick={() => setNewParam("1")}>Add Q&A</Button> : undefined}
              />
            ) : (
              <ul className="divide-y divide-border">
                {rows.map(row => {
                  const active = String(row.id) === selectedId;
                  return (
                    <li key={String(row.id)}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(String(row.id))}
                        className={cn(
                          "flex w-full items-start gap-4 px-4 py-3 text-left transition-colors hover:transition-none",
                          active ? "bg-[hsl(var(--brand)/0.06)] shadow-[inset_2px_0_0_hsl(var(--brand))]" : "hover:bg-muted/60",
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-foreground">{row.question}</p>
                          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{row.answer}</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1.5">
                          <Badge tone={row.published ? "green" : "amber"} dot>{row.published ? "Published" : "Draft"}</Badge>
                          <span className="text-[11px] text-muted-foreground">
                            {row.sourceMcpCorrelationId == null ? "Manual" : "From MCP call"} · {formatAgo(toDate(row.lastEditedAt))}
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </ConnectionGate>
      </SplitView>
      {newParam != null && <AddEntryDialog onClose={() => setNewParam(null)} onCreated={() => setNewParam(null)} />}
    </>
  );
}

function EntryEditor({ row, sourceCallId, onDeleted }: { row: QaEntriesRow, sourceCallId: bigint | null, onDeleted: () => void }) {
  const { actions } = useConsoleData();
  const [question, setQuestion] = useState(row.question);
  const [answer, setAnswer] = useState(row.answer);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [confirm, setConfirm] = useState<"publish" | "unpublish" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const questionId = useId();
  const answerId = useId();
  const dirty = question !== row.question || answer !== row.answer;

  // When someone else edits this entry, take their version unless there are unsaved local edits.
  const lastSeen = useRef({ question: row.question, answer: row.answer });
  useEffect(() => {
    if (question === lastSeen.current.question && answer === lastSeen.current.answer) {
      setQuestion(row.question);
      setAnswer(row.answer);
    }
    lastSeen.current = { question: row.question, answer: row.answer };
    // Deliberately keyed on the row only: local typing must not re-run this sync.
  }, [row.question, row.answer]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={row.published ? "green" : "amber"} dot>{row.published ? "Published" : "Draft"}</Badge>
        <span className="text-xs text-muted-foreground">Edited by {row.lastEditedBy} {formatAgo(toDate(row.lastEditedAt))}</span>
        {sourceCallId != null && (
          <a href={consoleHref("/console/mcp", { id: String(sourceCallId) })} className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:transition-none">
            <Icon name="review" size="sm" /> Source call
          </a>
        )}
      </div>

      {error != null && <Callout title="Action failed">{error}</Callout>}

      <div>
        <FieldLabel htmlFor={questionId}>Question</FieldLabel>
        <Input id={questionId} size="md" value={question} onChange={event => setQuestion(event.target.value)} />
      </div>
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor={answerId} className="text-xs font-medium text-foreground">Answer</label>
          <Segmented size="xs" label="Answer view" value={mode} onChange={setMode} options={[{ value: "edit", label: "Write" }, { value: "preview", label: "Preview" }]} />
        </div>
        {mode === "edit" ? (
          <Textarea id={answerId} rows={14} className="resize-y font-mono" value={answer} onChange={event => setAnswer(event.target.value)} />
        ) : (
          <div className="min-h-40 rounded-md border border-border px-3 py-2">
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{answer}</Markdown>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button variant="danger-ghost" icon="close" disabled={busy} onClick={() => setConfirm("delete")}>Delete</Button>
        {dirty && <span className="text-[11px] text-amber-600 dark:text-amber-400">Unsaved changes</span>}
        <div className="ml-auto flex items-center gap-2">
          {dirty && <Button disabled={busy} onClick={() => run(() => actions.saveQaEntry(row.id, question, answer, row.published))}>{row.published ? "Save & keep published" : "Save draft"}</Button>}
          {row.published
            ? <Button disabled={busy} onClick={() => setConfirm("unpublish")}>Unpublish</Button>
            : <Button variant="primary" disabled={busy || question.trim() === "" || answer.trim() === ""} onClick={() => setConfirm("publish")}>Publish</Button>}
        </div>
      </div>

      {confirm === "publish" && (
        <ConfirmDialog
          title="Publish this Q&A?"
          description="It becomes visible to everyone on the public /questions page."
          confirmLabel="Publish"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            runAsynchronously(run(() => actions.saveQaEntry(row.id, question, answer, true)));
          }}
        />
      )}
      {confirm === "unpublish" && (
        <ConfirmDialog
          title="Unpublish this Q&A?"
          description="It will no longer appear on the public /questions page. It stays here as a draft."
          confirmLabel="Unpublish"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            runAsynchronously(run(() => actions.saveQaEntry(row.id, question, answer, false)));
          }}
        />
      )}
      {confirm === "delete" && (
        <ConfirmDialog
          title="Delete this Q&A?"
          description="This permanently removes the entry. Telemetry from the originating call (if any) is kept."
          confirmLabel="Delete"
          confirmVariant="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            runAsynchronously(run(async () => {
              await actions.deleteQaEntry(row.id);
              onDeleted();
            }));
          }}
        />
      )}
    </div>
  );
}

function AddEntryDialog({ onClose, onCreated }: { onClose: () => void, onCreated: () => void }) {
  const { actions } = useConsoleData();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const questionId = useId();
  const answerId = useId();
  // Reused across retries of the same draft so a retried save after a dropped connection can't
  // create a duplicate entry; reset only once a save succeeds.
  const requestIdRef = useRef<string | null>(null);
  const canSave = question.trim() !== "" && answer.trim() !== "";

  async function save(publish: boolean) {
    setError(null);
    requestIdRef.current ??= crypto.randomUUID();
    try {
      await actions.addManualQa(question.trim(), answer.trim(), publish, requestIdRef.current);
      requestIdRef.current = null;
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save");
      throw cause;
    }
  }

  return (
    <Dialog
      width="lg"
      title="Add Q&A entry"
      description="Manual entries aren't tied to an MCP call. Answers support Markdown."
      onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!canSave} onClick={() => save(false)}>Save draft</Button>
          <Button variant="primary" disabled={!canSave} onClick={() => save(true)}>Save & publish</Button>
        </>
      )}
    >
      <div className="space-y-4">
        {error != null && <Callout title="Couldn't save">{error}</Callout>}
        <div>
          <FieldLabel htmlFor={questionId}>Question</FieldLabel>
          <Input id={questionId} size="md" autoFocus value={question} onChange={event => setQuestion(event.target.value)} placeholder="How do I set up OAuth with Hexclave?" />
        </div>
        <div>
          <FieldLabel htmlFor={answerId} hint="Markdown">Answer</FieldLabel>
          <Textarea id={answerId} rows={10} className="resize-y font-mono" value={answer} onChange={event => setAnswer(event.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}
