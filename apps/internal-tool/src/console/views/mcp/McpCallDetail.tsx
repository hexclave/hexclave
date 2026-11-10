"use client";

import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import { cn } from "../../../components/design/cn";
import { useClockTick } from "../../../hooks/useClockTick";
import { useScheduledTimeout } from "../../../hooks/useScheduledTimeout";
import { formatMcpCallContext } from "../../../lib/copy-log-context";
import { FEATURE_REQUEST_FLAG_TYPE, featureRequestFromFlagsJson } from "../../../lib/feature-request-flag";
import { hasMcpContextValue } from "../../../lib/mcp-context";
import { formatPacificTimestamp } from "../../../lib/pacific-time";
import type { FeedbackLogRow, McpCallLogRow, QaEntriesRow } from "../../../types";
import { qaReviewStartedAt, toDate } from "../../../utils";
import { useConsoleData } from "../../data/console-data";
import { fetchDeepWikiAnswer } from "../../lib/deepwiki";
import { formatAgo, formatDuration } from "../../lib/format";
import { isCallError, parseQaFlags, qaStatus, qaStatusLabel, qaStatusTone, scoreTextClass, SEVERITY_TONE } from "../../lib/mcp";
import { conversationRows, mcpConversationEntries, qaReviewerEntries } from "../../lib/transcripts";
import { feedbackTone } from "../../lib/feedback";
import { consoleHref } from "../../lib/url-state";
import { Icon } from "../../ui/icons";
import { Badge, Button, Callout, FieldLabel, Input, PropertyList, Spinner, TabPanel, Tabs, Textarea, type Tone } from "../../ui/primitives";
import { CopyButton, DetailStats } from "../shared/detail";
import { Transcript } from "../shared/Transcript";

type Section = "conversation" | "review" | "correction" | "details";

export function McpCallDetail({ row, allRows, qaEntries, relatedFeedback, onAdvance }: {
  row: McpCallLogRow,
  allRows: readonly McpCallLogRow[],
  qaEntries: readonly QaEntriesRow[],
  relatedFeedback: readonly FeedbackLogRow[],
  /** Opens the next row of the list, for "Mark reviewed & next"; null on the last row. */
  onAdvance: (() => void) | null,
}) {
  const { actions } = useConsoleData();
  const now = useClockTick();
  const tabsId = useId();
  const [section, setSection] = useState<Section>("conversation");
  const status = qaStatus(row, now);
  const featureRequest = featureRequestFromFlagsJson(row.qaFlagsJson);
  const linkedQa = qaEntries.find(entry => entry.sourceMcpCorrelationId === row.correlationId);

  // Optimistic override while the reviewed-state round trip is in flight; cleared once the live
  // subscription reports the same value (or reverted if the reducer call fails).
  const [optimisticReviewed, setOptimisticReviewed] = useState<boolean | null>(null);
  useEffect(() => {
    if (optimisticReviewed != null && optimisticReviewed === (row.humanReviewedAt != null)) setOptimisticReviewed(null);
  }, [row.humanReviewedAt, optimisticReviewed]);
  const isReviewed = optimisticReviewed ?? row.humanReviewedAt != null;

  async function setReviewed(reviewed: boolean) {
    const previous = optimisticReviewed;
    setOptimisticReviewed(reviewed);
    try {
      await actions.setHumanReviewed(row.correlationId, reviewed);
    } catch (error) {
      setOptimisticReviewed(previous);
      throw error;
    }
  }

  return (
    <div>
      <header className="space-y-3 px-5 pb-4 pt-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone="violet" mono>{row.toolName}</Badge>
          {isCallError(row) ? <Badge tone="red" dot>Error</Badge> : <Badge tone="green" dot>OK</Badge>}
          <Badge tone={qaStatusTone(status)}>QA {qaStatusLabel(status)}</Badge>
          {row.qaNeedsHumanReview === true && !isReviewed && <Badge tone="amber" dot>Needs review</Badge>}
          {isReviewed && <Badge tone="green">Reviewed</Badge>}
          {featureRequest != null && <Badge tone="blue">Feature request</Badge>}
        </div>
        <h2 className="line-clamp-3 text-[15px] font-semibold leading-6 tracking-tight text-foreground">{row.question}</h2>
        <p className="text-xs text-muted-foreground">
          {hasMcpContextValue(row.user) ? row.user : "Unknown user"}
          <span className="mx-1.5 text-muted-foreground/50">·</span>
          <span title={formatPacificTimestamp(toDate(row.createdAt))}>{formatAgo(toDate(row.createdAt))}</span>
          {isReviewed && row.humanReviewedBy != null && (
            <>
              <span className="mx-1.5 text-muted-foreground/50">·</span>
              Reviewed by {row.humanReviewedBy}{row.humanReviewedAt != null ? ` ${formatAgo(toDate(row.humanReviewedAt))}` : ""}
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {isReviewed ? (
            <Button icon="check" onClick={() => setReviewed(false)}>Reviewed · Undo</Button>
          ) : (
            <>
              <Button variant="primary" icon="check" onClick={() => setReviewed(true)}>Mark reviewed</Button>
              {onAdvance != null && (
                <Button
                  onClick={async () => {
                    await setReviewed(true);
                    onAdvance();
                  }}
                >
                  Mark reviewed & next
                </Button>
              )}
            </>
          )}
          <CopyButton getText={() => formatMcpCallContext(row)} label="Copy context" title="Copy the full call context for pasting into an AI chat" />
        </div>
      </header>

      <DetailStats items={[
        { label: "Result", value: isCallError(row) ? "Error" : "OK", className: isCallError(row) ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400" },
        { label: "QA score", value: qaStatusLabel(status), className: status.kind === "scored" ? scoreTextClass(status.score) : undefined },
        { label: "Duration", value: formatDuration(row.durationMs) },
        { label: "Steps", value: String(row.stepCount) },
      ]} />

      <div className="px-5 pt-1">
        <Tabs
          id={tabsId}
          label="Call detail sections"
          value={section}
          onChange={setSection}
          items={[
            { value: "conversation", label: "Conversation" },
            { value: "review", label: "QA review", count: relatedFeedback.length > 0 ? relatedFeedback.length : undefined },
            { value: "correction", label: linkedQa == null ? "Correction" : linkedQa.published ? "Correction · Published" : "Correction · Draft" },
            { value: "details", label: "Details" },
          ]}
        />
      </div>

      <div className="px-5 py-4">
        {isCallError(row) && section !== "details" && (
          <Callout title="The MCP call returned an error" className="mb-4">
            <p className="whitespace-pre-wrap break-words font-mono text-[11px]">{row.errorMessage}</p>
          </Callout>
        )}
        {section === "conversation" && (
          <TabPanel id={tabsId} value="conversation" className="space-y-4">
            {row.reason !== "" && <ContextNote label="Why the agent called this tool" text={row.reason} />}
            {hasMcpContextValue(row.context) && <ContextNote label="Task context" text={row.context} />}
            <ConversationSection row={row} allRows={allRows} />
          </TabPanel>
        )}
        {section === "review" && (
          <TabPanel id={tabsId} value="review" className="space-y-4">
            <QaReview row={row} now={now} />
            <RelatedFeedback rows={relatedFeedback} />
          </TabPanel>
        )}
        {/* Stays mounted while hidden so a half-written correction survives a detour to another tab. */}
        <TabPanel id={tabsId} value="correction" hidden={section !== "correction"}>
          <CorrectionForm row={row} qa={linkedQa} />
        </TabPanel>
        {section === "details" && (
          <TabPanel id={tabsId} value="details">
            <PropertyList items={[
              { label: "User", value: hasMcpContextValue(row.user) ? row.user : "Unknown" },
              { label: "Project", value: hasMcpContextValue(row.project) ? row.project : "Unknown" },
              { label: "Tool", value: row.toolName, mono: true },
              { label: "Model", value: row.modelId, mono: true },
              { label: "Started", value: formatPacificTimestamp(toDate(row.createdAt)) },
              { label: "Duration", value: `${Number(row.durationMs).toLocaleString()}ms` },
              { label: "Correlation ID", value: row.correlationId, mono: true },
              { label: "Conversation ID", value: row.conversationId ?? "—", mono: true },
              { label: "Reason", value: row.reason, hidden: row.reason === "" },
              { label: "Task context", value: row.context, hidden: !hasMcpContextValue(row.context) },
              { label: "Error", value: row.errorMessage ?? "", mono: true, hidden: !isCallError(row) },
              { label: "QA requested", value: formatPacificTimestamp(qaReviewStartedAt(row)) },
              { label: "QA model", value: row.qaReviewModelId ?? "—", mono: true },
            ]} />
          </TabPanel>
        )}
      </div>
    </div>
  );
}

function ContextNote({ label, text }: { label: string, text: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-foreground">{text}</p>
    </div>
  );
}

function ConversationSection({ row, allRows }: { row: McpCallLogRow, allRows: readonly McpCallLogRow[] }) {
  const rows = useMemo(() => conversationRows(row, allRows), [row, allRows]);
  const entries = useMemo(() => mcpConversationEntries(rows), [rows]);
  const totalSteps = rows.reduce((sum, callRow) => sum + callRow.stepCount, 0);
  const totalDuration = rows.reduce((sum, callRow) => sum + Number(callRow.durationMs), 0);
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{rows.length > 1 ? `${rows.length} calls in this conversation` : "Single call"}</span>
        <span className="tabular-nums">{totalSteps} steps · {formatDuration(totalDuration)}</span>
      </div>
      <Transcript entries={entries} assistantLabel="MCP agent" />
    </section>
  );
}

function QaReview({ row, now }: { row: McpCallLogRow, now: number }) {
  const { actions } = useConsoleData();
  const status = qaStatus(row, now);
  const [queued, setQueued] = useState(false);
  const scheduleTimeout = useScheduledTimeout();
  const retry = async () => {
    await actions.retryAiReview(row);
    setQueued(true);
    scheduleTimeout(() => setQueued(false), 3000);
  };
  const retryButton = <Button size="xs" icon="refresh" onClick={retry}>{queued ? "Queued" : "Retry review"}</Button>;

  if (status.kind === "error") {
    return <Callout title="The QA review errored" actions={retryButton}><p className="whitespace-pre-wrap">{status.message}</p></Callout>;
  }
  if (status.kind === "review-failed") {
    return (
      <Callout tone="warning" title="No QA verdict arrived" actions={retryButton}>
        Requested {formatAgo(qaReviewStartedAt(row))}. The reviewer was likely skipped (missing OpenRouter key) or its background task stopped.
      </Callout>
    );
  }
  if (status.kind === "pending") {
    return (
      <div className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-3 text-xs text-muted-foreground">
        <Spinner /> Automated QA review in progress…
      </div>
    );
  }

  const flags = parseQaFlags(row.qaFlagsJson);
  const reviewerEntries = qaReviewerEntries(row);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-xl border border-border p-4">
        <ScoreRing score={status.score} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={row.qaAnswerCorrect === true ? "green" : "red"} dot>{row.qaAnswerCorrect === true ? "Correct" : "Incorrect"}</Badge>
            <Badge tone={row.qaAnswerRelevant === true ? "green" : "red"} dot>{row.qaAnswerRelevant === true ? "Relevant" : "Off-topic"}</Badge>
            {row.qaNeedsHumanReview === true && <Badge tone="amber">Flagged for human review</Badge>}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Reviewed by <span className="font-mono">{row.qaReviewModelId ?? "unknown model"}</span>
            {row.qaReviewedAt != null && <> · {formatAgo(toDate(row.qaReviewedAt))}</>}
          </p>
        </div>
      </div>

      {flags.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-foreground">Flags</p>
          {flags.map((flag, index) => {
            const tone: Tone = SEVERITY_TONE.get(flag.severity) ?? "neutral";
            return (
              <div key={index} className="rounded-lg border border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-medium text-foreground">{flag.type === FEATURE_REQUEST_FLAG_TYPE ? "feature request" : flag.type}</span>
                  <Badge tone={tone}>{flag.severity}</Badge>
                </div>
                {flag.summary != null && flag.summary !== "" && <p className="mt-1 text-xs font-medium text-foreground">{flag.summary}</p>}
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{flag.explanation}</p>
              </div>
            );
          })}
        </div>
      )}

      {row.qaImprovementSuggestions != null && row.qaImprovementSuggestions !== "" && (
        <div>
          <p className="mb-1 text-xs font-medium text-foreground">Suggestions</p>
          <p className="whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{row.qaImprovementSuggestions}</p>
        </div>
      )}

      {reviewerEntries.length > 0 && <ReviewerTrace entries={reviewerEntries} />}
    </div>
  );
}

function ReviewerTrace({ entries }: { entries: ReturnType<typeof qaReviewerEntries> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(previous => !previous)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted hover:transition-none"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size="sm" className="text-muted-foreground" />
        Reviewer trace
        <span className="font-normal text-muted-foreground">{entries.length} step{entries.length === 1 ? "" : "s"}</span>
      </button>
      {open && <div className="border-t border-border p-3"><Transcript entries={entries} assistantLabel="QA reviewer" /></div>}
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const color = score >= 80 ? "rgb(16 185 129)" : score >= 50 ? "rgb(245 158 11)" : "rgb(239 68 68)";
  return (
    <div className="relative grid size-14 shrink-0 place-items-center">
      <svg viewBox="0 0 56 56" className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle cx="28" cy="28" r={radius} fill="none" stroke="hsl(var(--border))" strokeWidth="5" />
        <circle cx="28" cy="28" r={radius} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(score / 100) * circumference} ${circumference}`} />
      </svg>
      <span className={cn("text-base font-semibold tabular-nums", scoreTextClass(score))}>{score}</span>
    </div>
  );
}

function RelatedFeedback({ rows }: { rows: readonly FeedbackLogRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-foreground">Feedback from this conversation</p>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {rows.map(feedback => (
          <Link
            key={String(feedback.id)}
            href={consoleHref("/console/feedback", { id: String(feedback.id) })}
            className="block px-3 py-2.5 transition-colors hover:bg-muted hover:transition-none"
          >
            <span className="flex items-center justify-between gap-3">
              <Badge tone={feedbackTone(feedback.category)}>{feedback.category}</Badge>
              <span className="text-[11px] text-muted-foreground">{formatAgo(toDate(feedback.createdAt))}</span>
            </span>
            <span className="mt-1.5 line-clamp-2 block text-xs leading-5 text-foreground">{feedback.message}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function CorrectionForm({ row, qa }: { row: McpCallLogRow, qa: QaEntriesRow | undefined }) {
  const { actions } = useConsoleData();
  const persistedQuestion = qa?.question ?? "";
  const persistedAnswer = qa?.answer ?? "";
  const [question, setQuestion] = useState(persistedQuestion);
  const [answer, setAnswer] = useState(persistedAnswer);
  const [notice, setNotice] = useState<{ tone: "success" | "error", text: string } | null>(null);
  const [deepWikiLoading, setDeepWikiLoading] = useState(false);
  const scheduleTimeout = useScheduledTimeout();
  const questionId = useId();
  const answerId = useId();

  useEffect(() => {
    setQuestion(persistedQuestion);
    setAnswer(persistedAnswer);
  }, [persistedQuestion, persistedAnswer, row.correlationId]);

  const isPublished = qa?.published === true;
  const dirty = question !== persistedQuestion || answer !== persistedAnswer;
  const canSave = question.trim() !== "" && answer.trim() !== "";

  async function save(publish: boolean) {
    try {
      await actions.saveCorrection(row.correlationId, question, answer, publish);
      setNotice({ tone: "success", text: publish ? "Published to /questions and marked reviewed." : "Draft saved and call marked reviewed." });
      scheduleTimeout(() => setNotice(null), 3000);
    } catch (error) {
      setNotice({ tone: "error", text: `Save failed: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] font-semibold text-foreground">Human correction</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {qa == null
              ? "Write the answer the agent should have given. Saving also marks the call reviewed."
              : `${isPublished ? "Published" : "Draft"} · last edited by ${qa.lastEditedBy} ${formatAgo(toDate(qa.lastEditedAt))}`}
          </p>
        </div>
        {qa != null && <Badge tone={isPublished ? "green" : "amber"} dot>{isPublished ? "Published" : "Draft"}</Badge>}
      </div>

      {notice != null && <Callout tone={notice.tone}>{notice.text}</Callout>}

      <div>
        <FieldLabel htmlFor={questionId}>Question</FieldLabel>
        <Input id={questionId} size="md" value={question} onChange={event => setQuestion(event.target.value)} placeholder="The question, as a user would ask it" />
      </div>
      <div>
        <FieldLabel htmlFor={answerId} hint="Markdown">Answer</FieldLabel>
        <Textarea id={answerId} rows={10} className="resize-y font-mono" value={answer} onChange={event => setAnswer(event.target.value)} placeholder="The corrected answer…" />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" icon="copy" onClick={() => {
          setQuestion(row.question);
          setAnswer(row.response);
        }}>Prefill from call</Button>
        <Button
          size="xs"
          icon="sparkles"
          loading={deepWikiLoading}
          onClick={() => {
            const asked = question.trim() === "" ? row.question : question;
            setDeepWikiLoading(true);
            runAsynchronouslyWithAlert(fetchDeepWikiAnswer(asked)
              .then(text => {
                setAnswer(text);
                if (question.trim() === "") setQuestion(asked);
              }, (error: unknown) => {
                setNotice({ tone: "error", text: `DeepWiki failed: ${error instanceof Error ? error.message : String(error)}` });
              })
              .finally(() => setDeepWikiLoading(false)));
          }}
        >
          Ask DeepWiki
        </Button>
        {dirty && <span className="text-[11px] text-amber-600 dark:text-amber-400">Unsaved changes</span>}
        <div className="ml-auto flex items-center gap-2">
          {isPublished && !dirty && <Button size="sm" variant="danger-ghost" onClick={() => save(false)}>Unpublish</Button>}
          {(dirty || qa == null) && (
            <Button size="sm" disabled={!canSave} onClick={() => save(false)} title={isPublished ? "Saving as a draft removes the entry from /questions" : undefined}>
              {isPublished ? "Save as draft (unpublish)" : "Save draft"}
            </Button>
          )}
          <Button size="sm" variant="primary" disabled={!canSave || (isPublished && !dirty)} onClick={() => save(true)}>
            {isPublished ? "Update published" : "Publish"}
          </Button>
        </div>
      </div>
    </div>
  );
}
