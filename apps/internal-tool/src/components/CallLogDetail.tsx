import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { format, formatDistanceToNow } from "date-fns";
import { useState, useEffect } from "react";
import type { FeedbackLogRow, McpCallLogRow, QaEntriesRow } from "../types";
import { QA_REVIEW_FAILED_THRESHOLD_MS, qaReviewStartedAt, toDate } from "../utils";
import { feedbackCategoryColor } from "../lib/feedback-category";
import { FEATURE_REQUEST_FLAG_TYPE, featureRequestFromFlagsJson } from "../lib/feature-request-flag";
import { AssistantBubble, ConversationReplay, type ToolCall } from "./ConversationReplay";
import { DetailMetricStrip, DetailPanelTabs } from "./DetailPanelNavigation";
import { Alert, Badge, Button, cn, Input, Textarea } from "./design";
import { CopyFullContextButton } from "./CopyFullContextButton";
import { formatMcpCallContext } from "../lib/copy-log-context";
import { hasMcpContextValue } from "../lib/mcp-context";

/** Panel surface for the detail cards, matching the design Card's tintable glass treatment. */
const panelClasses = "overflow-hidden rounded-xl border border-black/[0.06] bg-card shadow-sm ring-1 ring-black/[0.04] dark:border-white/[0.06] dark:ring-white/[0.04]";
const sectionLabelClasses = "text-[10px] font-medium uppercase tracking-wider text-muted-foreground";

// ─── Main Component ────────────────────────────────────

export function CallLogDetail({ row, allRows, qaEntries, relatedFeedback, onClose, onOpenFeedback, onSaveCorrection, onSetReviewed, onRetryReview }: {
  row: McpCallLogRow;
  allRows: McpCallLogRow[];
  qaEntries: QaEntriesRow[];
  relatedFeedback: readonly FeedbackLogRow[];
  onClose: () => void;
  onOpenFeedback: (feedback: FeedbackLogRow) => void;
  onSaveCorrection?: (correlationId: string, correctedQuestion: string, correctedAnswer: string, publish: boolean) => Promise<void> | void;
  onSetReviewed?: (correlationId: string, reviewed: boolean) => Promise<void> | void;
  onRetryReview?: (correlationId: string, payload: { question: string; reason: string; response: string }) => Promise<void> | void;
}) {
  const linkedQa = qaEntries.find(q => q.sourceMcpCorrelationId === row.correlationId);
  const [activeSection, setActiveSection] = useState<"conversation" | "review" | "correction">("conversation");
  // Optimistic override while the reviewed-state roundtrip is in flight. Cleared
  // once the real subscription update catches up.
  const [optimisticReviewed, setOptimisticReviewed] = useState<boolean | null>(null);
  useEffect(() => {
    const actual = row.humanReviewedAt != null;
    if (optimisticReviewed != null && optimisticReviewed === actual) {
      setOptimisticReviewed(null);
    }
  }, [row.humanReviewedAt, optimisticReviewed]);
  const isReviewed = optimisticReviewed ?? (row.humanReviewedAt != null);
  const qaReviewAgeMs = new Date().getTime() - qaReviewStartedAt(row).getTime();
  const qaSummary = row.qaErrorMessage != null && row.qaErrorMessage !== ""
    ? "Error"
    : row.qaOverallScore != null
      ? `${row.qaOverallScore}/100`
      : qaReviewAgeMs > QA_REVIEW_FAILED_THRESHOLD_MS ? "Failed" : "Pending";
  const resultSummary = row.errorMessage != null && row.errorMessage !== "" ? "Error" : "OK";
  const featureRequest = featureRequestFromFlagsJson(row.qaFlagsJson);

  const handleSetReviewed = (reviewed: boolean) => {
    const previous = optimisticReviewed;
    setOptimisticReviewed(reviewed);
    runAsynchronouslyWithAlert(
      Promise.resolve(onSetReviewed?.(row.correlationId, reviewed)).catch(err => {
        // Revert the optimistic override so the UI reflects the database's real state.
        setOptimisticReviewed(previous);
        captureError("call-log-set-reviewed", err);
        throw err;
      })
    );
  };

  return (
    <div className="min-h-full">
      <header className="bg-background pt-4">
        {/* Actions sit in the title row rather than in a strip of their own: the
            panel's job is reviewing, so "Mark reviewed" should be reachable
            without reading past the metadata to find it. */}
        <div className="flex items-start justify-between gap-4 px-4 pb-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-foreground">MCP review</h2>
              <Badge color="purple" mono>{row.toolName}</Badge>
              {isReviewed && (
                <Badge color="green" title={row.humanReviewedAt ? format(toDate(row.humanReviewedAt), "PPpp") : undefined}>
                  Reviewed
                </Badge>
              )}
              {featureRequest != null && <Badge color="blue">Feature request</Badge>}
            </div>
            {isReviewed && row.humanReviewedBy != null && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                Reviewed by {row.humanReviewedBy}
                {row.humanReviewedAt != null ? ` ${formatDistanceToNow(toDate(row.humanReviewedAt), { addSuffix: true })}` : ""}
              </p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {onSetReviewed && (
              <Button variant={isReviewed ? "outline" : "default"} onClick={() => handleSetReviewed(!isReviewed)}>
                {isReviewed ? "Unmark reviewed" : "Mark reviewed"}
              </Button>
            )}
            <CopyFullContextButton getText={() => formatMcpCallContext(row)} subject="MCP call" />
            <Button variant="ghost" className="size-7 shrink-0 px-0 text-base" aria-label="Close MCP call details" onClick={onClose}>×</Button>
          </div>
        </div>
        <DetailMetricStrip items={[
          { label: "Result", value: resultSummary, tone: resultSummary === "Error" ? "error" : "success" },
          { label: "QA review", value: qaSummary, tone: qaSummary === "Error" || qaSummary === "Failed" ? "error" : "default" },
          { label: "Duration", value: `${Number(row.durationMs).toLocaleString()}ms` },
          { label: "Steps", value: String(row.stepCount) },
        ]} />
        <McpCallSummary row={row} />
        <DetailPanelTabs
          label="MCP call detail sections"
          value={activeSection}
          onChange={setActiveSection}
          items={[
            { value: "conversation", label: "Conversation" },
            { value: "review", label: "AI QA review" },
            { value: "correction", label: "Human correction" },
          ]}
        />
      </header>

      <div className="space-y-4 p-4 pb-8">
        {activeSection === "conversation" && (
          <div role="tabpanel">
            <ConversationReplay key={row.correlationId} row={row} allRows={allRows} />
          </div>
        )}
        {activeSection === "review" && <div role="tabpanel" className="space-y-4">
          <QaReviewCard row={row} onRetryReview={onRetryReview} />
          <RelatedFeedbackCard rows={relatedFeedback} onOpen={onOpenFeedback} />
        </div>}
        {activeSection === "correction" && (
          <div role="tabpanel"><HumanCorrectionCard row={row} qa={linkedQa} onSave={onSaveCorrection} /></div>
        )}
      </div>
    </div>
  );
}

function McpCallSummary({ row }: { row: McpCallLogRow }) {
  const user = hasMcpContextValue(row.user) ? row.user : "Unknown";
  const project = hasMcpContextValue(row.project) ? row.project : "Unknown";

  return (
    <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-t border-black/[0.06] px-4 py-3 dark:border-white/[0.06]">
      <SummaryItem label="User" value={user} />
      <SummaryItem label="Project" value={project} />
      <SummaryItem label="Model" value={row.modelId} mono />
      <SummaryItem label="Started" value={format(toDate(row.createdAt), "MMM d, HH:mm:ss")} />
      <SummaryItem label="Correlation ID" value={row.correlationId} mono />
      <SummaryItem label="Conversation ID" value={row.conversationId != null && row.conversationId !== "" ? row.conversationId : "—"} mono />
      {row.reason !== "" && <SummaryItem label="Reason" value={row.reason} wide />}
      {hasMcpContextValue(row.context) && <SummaryItem label="Task context" value={row.context} wide />}
      {row.errorMessage != null && row.errorMessage !== "" && <SummaryItem label="Error" value={row.errorMessage} wide />}
    </dl>
  );
}

function SummaryItem({ label, value, mono = false, wide = false }: { label: string; value: string; mono?: boolean; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className={sectionLabelClasses}>{label}</dt>
      <dd className={cn("mt-0.5 line-clamp-2 break-words text-xs leading-5 text-foreground", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

function RelatedFeedbackCard({ rows, onOpen }: {
  rows: readonly FeedbackLogRow[],
  onOpen: (feedback: FeedbackLogRow) => void,
}) {
  if (rows.length === 0) return null;

  return (
    <div className={panelClasses}>
      <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-2.5 dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-foreground">Related feedback</h3>
          <Badge color="purple" mono>give_feedback</Badge>
        </div>
        <span className="text-[10px] tabular-nums text-muted-foreground">
          {rows.length} {rows.length === 1 ? "entry" : "entries"}
        </span>
      </div>
      <div className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
        {rows.map(feedback => (
          <button
            key={String(feedback.id)}
            type="button"
            onClick={() => onOpen(feedback)}
            className="block w-full px-4 py-3 text-left transition-colors hover:bg-foreground/[0.04] hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span className="flex items-center justify-between gap-3">
              <Badge color={feedbackCategoryColor(feedback.category)}>{feedback.category}</Badge>
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {formatDistanceToNow(toDate(feedback.createdAt), { addSuffix: true })}
              </span>
            </span>
            <span className="mt-2 line-clamp-3 block text-xs leading-5 text-foreground">{feedback.message}</span>
            <span className="mt-1.5 block text-[10px] font-medium text-muted-foreground">Open feedback details</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── AI QA Review ──────────────────────────────────────

type QaFlag = { type: string; severity: string; explanation: string; summary?: string };

function RetryReviewButton({ row, onRetryReview, label = "Retry review", tone = "indigo" }: {
  row: McpCallLogRow;
  onRetryReview: (correlationId: string, payload: { question: string; reason: string; response: string }) => Promise<void> | void;
  label?: string;
  tone?: "indigo" | "red";
}) {
  const [retrying, setRetrying] = useState(false);
  const [justTriggered, setJustTriggered] = useState(false);

  return (
    <Button
      size="xs"
      variant={tone === "red" ? "destructive" : "outline"}
      disabled={retrying}
      onClick={() => {
        setRetrying(true);
        runAsynchronouslyWithAlert(
          Promise.resolve(onRetryReview(row.correlationId, { question: row.question, reason: row.reason, response: row.response }))
            .then(() => {
              setJustTriggered(true);
              setTimeout(() => setJustTriggered(false), 3000);
            })
            .catch(err => {
              captureError("call-log-retry-review", err);
              throw err;
            })
            .finally(() => setRetrying(false))
        );
      }}
    >
      {retrying ? "Retrying…" : justTriggered ? "Queued" : label}
    </Button>
  );
}

function QaReviewCard({ row, onRetryReview }: {
  row: McpCallLogRow;
  onRetryReview?: (correlationId: string, payload: { question: string; reason: string; response: string }) => Promise<void> | void;
}) {
  if (row.qaErrorMessage) {
    return (
      <Alert className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider">AI QA Review</h3>
          {onRetryReview && <RetryReviewButton row={row} onRetryReview={onRetryReview} tone="red" />}
        </div>
        <p className="whitespace-pre-wrap text-sm">Error: {row.qaErrorMessage}</p>
      </Alert>
    );
  }

  if (row.qaOverallScore == null) {
    const reviewStartedAt = qaReviewStartedAt(row);
    const ageMs = Date.now() - reviewStartedAt.getTime();
    const reviewFailed = ageMs > QA_REVIEW_FAILED_THRESHOLD_MS;

    if (reviewFailed) {
      return (
        <Alert variant="warning" className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider">AI QA Review</h3>
              <Badge color="orange">Review failed</Badge>
            </div>
            {onRetryReview && <RetryReviewButton row={row} onRetryReview={onRetryReview} />}
          </div>
          <p className="text-xs">
            No review completed in {formatDistanceToNow(reviewStartedAt)}. The reviewer was likely skipped (missing OpenRouter key) or the background task stopped. Retry the review to run it again.
          </p>
        </Alert>
      );
    }

    return (
      <div className={cn(panelClasses, "p-4")}>
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">AI QA Review</h3>
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
          <span className="text-xs text-muted-foreground">Reviewing...</span>
        </div>
      </div>
    );
  }

  let flags: QaFlag[] = [];
  try {
    flags = JSON.parse(row.qaFlagsJson ?? "[]") as QaFlag[];
  } catch {
    // ignore
  }

  const scoreColor = row.qaOverallScore >= 80
    ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/15"
    : row.qaOverallScore >= 50
      ? "text-amber-700 dark:text-amber-300 bg-amber-500/15"
      : "text-red-700 dark:text-red-400 bg-red-500/15";

  const lowSeverityClasses = "border-border bg-foreground/[0.04]";
  const severityClasses = new Map<string, string>([
    ["critical", "border-red-500 bg-red-500/10"],
    ["high", "border-orange-500 bg-orange-500/10"],
    ["medium", "border-amber-500 bg-amber-500/10"],
    ["low", lowSeverityClasses],
  ]);

  return (
    <div className={panelClasses}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-2.5 dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">AI QA Review</h3>
          {row.qaNeedsHumanReview && !row.humanReviewedAt && (
            <Badge color="orange">Needs Review</Badge>
          )}
        </div>
        <span className={cn("rounded-lg px-2 py-0.5 text-lg font-bold tabular-nums", scoreColor)}>
          {row.qaOverallScore}
        </span>
      </div>

      <div className="p-4 space-y-3">
        {/* Badges */}
        <div className="flex gap-2">
          <Badge color={row.qaAnswerCorrect ? "green" : "red"}>
            {row.qaAnswerCorrect ? "correct" : "incorrect"}
          </Badge>
          <Badge color={row.qaAnswerRelevant ? "green" : "red"}>
            {row.qaAnswerRelevant ? "relevant" : "off-topic"}
          </Badge>
        </div>

        {/* Flags */}
        {flags.length > 0 && (
          <div className="space-y-1.5">
            {flags.map((flag, i) => (
              <div key={i} className={cn("rounded-lg border px-3 py-2 text-sm", severityClasses.get(flag.severity) ?? lowSeverityClasses)}>
                <div className="mb-0.5 flex items-center gap-2">
                  <span className="font-mono text-xs text-foreground">{flag.type === FEATURE_REQUEST_FLAG_TYPE ? "feature request" : flag.type}</span>
                  <span className="text-[10px] uppercase text-muted-foreground">{flag.severity}</span>
                </div>
                {flag.type === FEATURE_REQUEST_FLAG_TYPE && flag.summary != null && flag.summary !== "" && (
                  <p className="mb-1 text-xs font-medium text-foreground">{flag.summary}</p>
                )}
                <p className="text-xs text-muted-foreground">{flag.explanation}</p>
              </div>
            ))}
          </div>
        )}

        {/* Suggestions */}
        {row.qaImprovementSuggestions && (
          <div>
            <h4 className={cn(sectionLabelClasses, "mb-1")}>Suggestions</h4>
            <p className="whitespace-pre-wrap text-xs text-muted-foreground">{row.qaImprovementSuggestions}</p>
          </div>
        )}

        {/* Conversation timeline */}
        {row.qaConversationJson && (
          <QaConversationTimeline json={row.qaConversationJson} />
        )}

        {/* Model */}
        {row.qaReviewModelId && (
          <p className="text-[10px] text-muted-foreground">by {row.qaReviewModelId}</p>
        )}
      </div>
    </div>
  );
}

// ─── Card 3: Human Correction ──────────────────────────

async function fetchDeepWikiAnswer(questionText: string): Promise<string> {
  const res = await fetch("https://mcp.deepwiki.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ask_question",
        arguments: {
          repoName: "hexclave/hexclave",
          question: questionText,
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepWiki error: ${res.status}`);
  }

  const rawText = await res.text();
  const dataLine = rawText.split("\n").find(line => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error("No data in DeepWiki response");
  }

  const data = JSON.parse(dataLine.slice(6)) as {
    result?: { content?: Array<{ text?: string }> };
  };

  return data.result?.content
    ?.filter((c): c is { text: string } => typeof c.text === "string")
    .map(c => c.text)
    .join("\n\n") ?? "(no response)";
}

function HumanCorrectionCard({ row, qa, onSave }: {
  row: McpCallLogRow;
  qa: QaEntriesRow | undefined;
  onSave?: (correlationId: string, correctedQuestion: string, correctedAnswer: string, publish: boolean) => Promise<void> | void;
}) {
  const persistedQuestion = qa?.question ?? "";
  const persistedAnswer = qa?.answer ?? "";
  const isPublished = qa?.published === true;
  const hasDraft = qa != null;

  const [question, setQuestion] = useState(persistedQuestion);
  const [answer, setAnswer] = useState(persistedAnswer);
  const [lastAction, setLastAction] = useState<"published" | "saved" | "deepwiki-error" | "error" | null>(null);
  const [deepWikiLoading, setDeepWikiLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setQuestion(persistedQuestion);
    setAnswer(persistedAnswer);
  }, [persistedQuestion, persistedAnswer, row.correlationId]);

  const handleSave = async (publish: boolean) => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      await onSave?.(row.correlationId, question, answer, publish);
      setLastAction(publish ? "published" : "saved");
      setTimeout(() => setLastAction(null), 3000);
    } catch {
      setLastAction("error");
      setTimeout(() => setLastAction(null), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  const hasUnsavedChanges =
    question !== persistedQuestion ||
    answer !== persistedAnswer;

  const saveAction = (() => {
    if (isSaving) return { label: "Saving…", isDraft: !isPublished, disabled: true };
    if (hasUnsavedChanges) return { label: "Save Draft", isDraft: true, disabled: false };
    if (!hasDraft) return { label: "Save Draft", isDraft: true, disabled: true };
    return { label: isPublished ? "Update" : "Publish", isDraft: false, disabled: false };
  })();

  // Subtle state tint on the card edge: published = green, unpublished draft = amber.
  const cardTint = isPublished
    ? "ring-emerald-500/20"
    : hasDraft
      ? "ring-amber-500/25"
      : "";

  return (
    <div className={cn(panelClasses, cardTint)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-2.5 dark:border-white/[0.06]">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-foreground">Human Correction</h3>
          {isPublished ? (
            <Badge color="green">&#10003; Published</Badge>
          ) : hasDraft ? (
            <Badge color="orange">Draft</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          {qa?.lastPublishedAt && (
            <span>{format(toDate(qa.lastPublishedAt), "MMM d, yyyy")}</span>
          )}
          {qa?.lastEditedBy && (
            <span>by {qa.lastEditedBy}</span>
          )}
          {isPublished && (
            <button
              onClick={() => void handleSave(false)}
              className="text-red-600 transition-colors hover:transition-none hover:text-red-500 dark:text-red-400"
            >
              Unpublish
            </button>
          )}
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* Feedback toast */}
        {lastAction && (
          <div className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-medium",
            lastAction === "published" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" :
              lastAction === "deepwiki-error" || lastAction === "error" ? "bg-red-500/15 text-red-700 dark:text-red-400" :
                "bg-blue-500/15 text-blue-700 dark:text-blue-400"
          )}>
            {lastAction === "published" ? "Published to /questions" :
              lastAction === "deepwiki-error" ? "Failed to fetch from DeepWiki" :
                lastAction === "error" ? "Failed to save" :
                  "Draft saved"}
          </div>
        )}

        {/* Question */}
        <div>
          <label className={cn(sectionLabelClasses, "mb-1 block")}>Question</label>
          <Input
            type="text"
            className="h-9 px-3 text-sm"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="The question..."
          />
        </div>

        {/* Answer */}
        <div>
          <label className={cn(sectionLabelClasses, "mb-1 block")}>Answer</label>
          <Textarea
            className="h-40 resize-y px-3 py-2 font-mono text-sm"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Write the corrected answer..."
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button
            onClick={() => {
              setQuestion(row.question);
              setAnswer(row.response);
            }}
          >
            Pre-fill from call
          </Button>
          <Button
            disabled={deepWikiLoading}
            onClick={() => {
              const q = question || row.question;
              setDeepWikiLoading(true);
              fetchDeepWikiAnswer(q)
                .then(a => {
                  setAnswer(a);
                  if (!question) {
                    setQuestion(q);
                  }
                })
                .catch(() => setLastAction("deepwiki-error"))
                .finally(() => setDeepWikiLoading(false));
            }}
          >
            {deepWikiLoading ? "Fetching..." : "Pre-fill from DeepWiki"}
          </Button>
          {hasUnsavedChanges && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">unsaved changes</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant={saveAction.isDraft ? "outline" : "default"}
              onClick={() => void handleSave(!hasUnsavedChanges)}
              disabled={saveAction.disabled}
            >
              {saveAction.label}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Reviewer conversation ──────────────────────────

type QaStep = {
  step: number,
  text?: string,
  toolCalls?: Array<{ toolName: string, toolCallId?: string, args: unknown }>,
  toolResults?: Array<{ toolName: string, toolCallId?: string, result: unknown }>,
};

/**
 * Pairs each tool call with its result. The reviewer emits calls and results as
 * two separate lists, so they are matched on toolCallId where the model
 * supplied one and by position otherwise (older rows predate the id).
 */
function qaStepToolCalls(step: QaStep): ToolCall[] {
  const results = step.toolResults ?? [];
  const byId = new Map(results.flatMap(r => (r.toolCallId == null ? [] : [[r.toolCallId, r] as const])));
  return (step.toolCalls ?? []).map((call, i) => ({
    type: "tool-call",
    toolName: call.toolName,
    toolCallId: call.toolCallId ?? `${step.step}-${i}`,
    args: call.args,
    result: (call.toolCallId == null ? undefined : byId.get(call.toolCallId))?.result ?? results[i]?.result ?? null,
  }));
}

/**
 * The reviewer's own agent loop, rendered with the same bubbles as the MCP
 * conversation above it — one transcript style for every agent trace in this
 * panel, distinguished by accent rather than by a separate layout.
 */
function QaConversationTimeline({ json }: { json: string }) {
  const [expanded, setExpanded] = useState(false);

  let steps: QaStep[];
  try {
    steps = JSON.parse(json) as QaStep[];
  } catch {
    return null;
  }

  if (steps.length === 0) return null;

  return (
    <div>
      <button
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:transition-none hover:text-foreground"
        onClick={() => setExpanded(prev => !prev)}
      >
        <span className="text-[10px]">{expanded ? "\u25BE" : "\u25B8"}</span>
        Reviewer conversation ({steps.length} step{steps.length !== 1 ? "s" : ""})
      </button>
      {expanded && (
        <div className="mt-3 space-y-4">
          {steps.map(step => (
            <AssistantBubble
              key={step.step}
              accent="indigo"
              label="QA"
              content={step.text ?? ""}
              toolCalls={qaStepToolCalls(step)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
