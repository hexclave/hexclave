import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { clsx } from "clsx";
import { format, formatDistanceToNow } from "date-fns";
import { useState, useEffect } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { McpCallLogRow, QaEntriesRow } from "../types";
import { QA_REVIEW_FAILED_THRESHOLD_MS, qaReviewStartedAt, toDate } from "../utils";
import { ConversationReplay } from "./ConversationReplay";
import { markdownComponents } from "./markdown-components";

// ─── Shared ────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="text-xs text-blue-500 hover:text-blue-700 ml-2"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, (err) => {
          console.error("Clipboard write failed:", err);
        });
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

// ─── Main Component ────────────────────────────────────

export function CallLogDetail({ row, allRows, qaEntries, onClose, onSaveCorrection, onSetReviewed, onRetryReview }: {
  row: McpCallLogRow;
  allRows: McpCallLogRow[];
  qaEntries: QaEntriesRow[];
  onClose: () => void;
  onSaveCorrection?: (correlationId: string, correctedQuestion: string, correctedAnswer: string, publish: boolean) => Promise<void> | void;
  onSetReviewed?: (correlationId: string, reviewed: boolean) => Promise<void> | void;
  onRetryReview?: (correlationId: string, payload: { question: string; reason: string; response: string }) => Promise<void> | void;
}) {
  const linkedQa = qaEntries.find(q => q.sourceMcpCorrelationId === row.correlationId);
  const [showReplay, setShowReplay] = useState(false);
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
    <div className="p-4 space-y-4">
      {showReplay && (
        <ConversationReplay row={row} allRows={allRows} onClose={() => setShowReplay(false)} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-900">Call Detail</h2>
          {isReviewed && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800"
              title={row.humanReviewedAt ? format(toDate(row.humanReviewedAt), "PPpp") : ""}
            >
              &#10003; Reviewed
              {row.humanReviewedBy ? ` by ${row.humanReviewedBy}` : ""}
              {row.humanReviewedAt
                ? ` · ${formatDistanceToNow(toDate(row.humanReviewedAt), { addSuffix: true })}`
                : " · just now"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isReviewed && onSetReviewed && (
            <button
              onClick={() => handleSetReviewed(true)}
              className="px-2.5 py-1 text-xs font-medium text-green-700 bg-green-50 rounded-md hover:bg-green-100 border border-green-200"
            >
              Mark as reviewed
            </button>
          )}
          {isReviewed && onSetReviewed && (
            <button
              onClick={() => handleSetReviewed(false)}
              className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-gray-50 rounded-md hover:bg-gray-100 border border-gray-200"
            >
              Unmark
            </button>
          )}
          <button
            onClick={() => setShowReplay(true)}
            className="px-2.5 py-1 text-xs font-medium text-purple-600 bg-purple-50 rounded-md hover:bg-purple-100"
          >
            Replay
          </button>
          <button className="text-gray-400 hover:text-gray-600 text-sm" onClick={onClose}>
            close
          </button>
        </div>
      </div>

      {/* Card 1: MCP Call */}
      <MpcCallCard row={row} />

      {/* Card 2: AI QA Review */}
      <QaReviewCard row={row} onRetryReview={onRetryReview} />

      {/* Card 3: Human Correction */}
      <HumanCorrectionCard row={row} qa={linkedQa} onSave={onSaveCorrection} />
    </div>
  );
}

// ─── Card 1: MCP Call ──────────────────────────────────

function MpcCallCard({ row }: { row: McpCallLogRow }) {
  const [toolsExpanded, setToolsExpanded] = useState(true);

  let toolCalls: Array<{ type: string; toolName: string; toolCallId: string; args: unknown; result: unknown }> = [];
  try {
    toolCalls = JSON.parse(row.innerToolCallsJson) as typeof toolCalls;
  } catch {
    // ignore
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {/* Metadata bar */}
      <div className="px-4 py-2.5 border-b border-gray-100 flex items-center gap-2 flex-wrap text-xs text-gray-500">
        <span className="inline-flex items-center px-2 py-0.5 rounded font-medium bg-purple-100 text-purple-800">
          {row.toolName}
        </span>
        <span title={format(toDate(row.createdAt), "PPpp")}>
          {formatDistanceToNow(toDate(row.createdAt), { addSuffix: true })}
        </span>
        <span>{Number(row.durationMs).toLocaleString()}ms</span>
        <span>{row.stepCount} step{row.stepCount !== 1 ? "s" : ""}</span>
        <span className="text-gray-400">{row.modelId}</span>
      </div>

      <div className="p-4 space-y-3">
        {row.errorMessage && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            {row.errorMessage}
          </div>
        )}

        {/* User Prompt */}
        {row.userPrompt && (
          <div>
            <h4 className="text-[10px] uppercase text-gray-400 font-medium tracking-wider mb-0.5">User Prompt</h4>
            <p className="text-sm text-gray-700">{row.userPrompt}</p>
          </div>
        )}

        {/* Reason */}
        <p className="text-xs text-gray-500 italic">{row.reason}</p>

        {/* Question */}
        <div>
          <div className="flex items-center mb-1">
            <h4 className="text-[10px] uppercase text-gray-400 font-medium tracking-wider">Question</h4>
            <CopyButton text={row.question} />
          </div>
          <p className="text-sm text-gray-900 whitespace-pre-wrap">{row.question}</p>
        </div>

        {/* Response */}
        <div>
          <div className="flex items-center mb-1">
            <h4 className="text-[10px] uppercase text-gray-400 font-medium tracking-wider">AI Response</h4>
            <CopyButton text={row.response} />
          </div>
          <div className="bg-gray-50 p-3 rounded max-h-64 overflow-auto text-sm">
            {row.response ? (
              <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {row.response}
              </Markdown>
            ) : <span className="text-gray-400">(empty)</span>}
          </div>
        </div>

        {/* Tool Calls */}
        {toolCalls.length > 0 && (
          <div>
            <button
              className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
              onClick={() => setToolsExpanded(prev => !prev)}
            >
              <span className="text-[10px]">{toolsExpanded ? "▾" : "▸"}</span>
              Tool Calls ({toolCalls.length})
            </button>
            {toolsExpanded && (
              <div className="mt-2 space-y-2">
                {toolCalls.map((call, i) => (
                  <InnerToolCall key={call.toolCallId || String(i)} call={call} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function InnerToolCall({ call }: { call: { toolName: string; toolCallId: string; args: unknown; result: unknown } }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-gray-200 rounded">
      <button
        className="w-full text-left px-3 py-2 text-sm flex items-center justify-between hover:bg-gray-50"
        onClick={() => setExpanded(prev => !prev)}
      >
        <span className="font-mono text-xs">
          <span className="text-purple-600">{call.toolName}</span>
          <span className="text-gray-400 ml-2">#{call.toolCallId.slice(0, 8)}</span>
        </span>
        <span className="text-gray-400 text-xs">{expanded ? "collapse" : "expand"}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          <div>
            <p className="text-xs text-gray-500 mb-1">Args:</p>
            <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-40">{JSON.stringify(call.args, null, 2)}</pre>
          </div>
          <div>
            <p className="text-xs text-gray-500 mb-1">Result:</p>
            <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto max-h-40">{JSON.stringify(call.result, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Card 2: AI QA Review ──────────────────────────────

type QaFlag = { type: string; severity: string; explanation: string };

function RetryReviewButton({ row, onRetryReview, label = "Retry review", tone = "indigo" }: {
  row: McpCallLogRow;
  onRetryReview: (correlationId: string, payload: { question: string; reason: string; response: string }) => Promise<void> | void;
  label?: string;
  tone?: "indigo" | "red";
}) {
  const [retrying, setRetrying] = useState(false);
  const [justTriggered, setJustTriggered] = useState(false);

  const toneClasses = tone === "red"
    ? "text-red-700 bg-red-100 hover:bg-red-200 border-red-300"
    : "text-indigo-700 bg-indigo-100 hover:bg-indigo-200 border-indigo-300";

  return (
    <button
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
      className={clsx(
        "px-2 py-1 text-[11px] font-medium border rounded",
        retrying ? "text-gray-400 bg-gray-50 border-gray-200" : toneClasses,
      )}
    >
      {retrying ? "Retrying…" : justTriggered ? "Queued" : label}
    </button>
  );
}

function QaReviewCard({ row, onRetryReview }: {
  row: McpCallLogRow;
  onRetryReview?: (correlationId: string, payload: { question: string; reason: string; response: string }) => Promise<void> | void;
}) {
  if (row.qaErrorMessage) {
    return (
      <div className="bg-red-50/50 border border-red-200 rounded-lg p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-red-800 uppercase tracking-wider">AI QA Review</h3>
          {onRetryReview && <RetryReviewButton row={row} onRetryReview={onRetryReview} tone="red" />}
        </div>
        <p className="text-sm text-red-700 whitespace-pre-wrap">Error: {row.qaErrorMessage}</p>
      </div>
    );
  }

  if (row.qaOverallScore == null) {
    const reviewStartedAt = qaReviewStartedAt(row);
    const ageMs = Date.now() - reviewStartedAt.getTime();
    const reviewFailed = ageMs > QA_REVIEW_FAILED_THRESHOLD_MS;

    if (reviewFailed) {
      return (
        <div className="bg-amber-50/60 border border-amber-200 rounded-lg p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold text-amber-800 uppercase tracking-wider">AI QA Review</h3>
              <span className="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">Review failed</span>
            </div>
            {onRetryReview && <RetryReviewButton row={row} onRetryReview={onRetryReview} />}
          </div>
          <p className="text-xs text-amber-700">
            No review completed in {formatDistanceToNow(reviewStartedAt)}. The reviewer was likely skipped (missing OpenRouter key) or the background task died — click retry to re-run.
          </p>
        </div>
      );
    }

    return (
      <div className="bg-indigo-50/30 border border-indigo-200 rounded-lg p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-indigo-800 uppercase tracking-wider">AI QA Review</h3>
          <span className="inline-block w-3 h-3 border-2 border-indigo-300 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-indigo-400">Reviewing...</span>
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
    ? "text-green-700 bg-green-100"
    : row.qaOverallScore >= 50
      ? "text-yellow-700 bg-yellow-100"
      : "text-red-700 bg-red-100";

  const severityColors: Record<string, string> = {
    critical: "border-red-400 bg-red-50",
    high: "border-orange-400 bg-orange-50",
    medium: "border-yellow-400 bg-yellow-50",
    low: "border-gray-300 bg-gray-50",
  };

  return (
    <div className="bg-indigo-50/30 border border-indigo-200 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-indigo-100 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-indigo-800 uppercase tracking-wider">AI QA Review</h3>
          {row.qaNeedsHumanReview && !row.humanReviewedAt && (
            <span className="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">Needs Review</span>
          )}
        </div>
        <span className={`text-lg font-bold px-2 py-0.5 rounded ${scoreColor}`}>
          {row.qaOverallScore}
        </span>
      </div>

      <div className="p-4 space-y-3">
        {/* Badges */}
        <div className="flex gap-2">
          <span className={clsx(
            "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
            row.qaAnswerCorrect ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
          )}>
            {row.qaAnswerCorrect ? "correct" : "incorrect"}
          </span>
          <span className={clsx(
            "inline-flex items-center px-2 py-0.5 rounded text-xs font-medium",
            row.qaAnswerRelevant ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
          )}>
            {row.qaAnswerRelevant ? "relevant" : "off-topic"}
          </span>
        </div>

        {/* Flags */}
        {flags.length > 0 && (
          <div className="space-y-1.5">
            {flags.map((flag, i) => (
              <div key={i} className={`border-l-4 pl-3 py-1.5 rounded-r text-sm ${severityColors[flag.severity] ?? severityColors.low}`}>
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono text-xs text-gray-600">{flag.type}</span>
                  <span className="text-[10px] uppercase text-gray-400">{flag.severity}</span>
                </div>
                <p className="text-gray-700 text-xs">{flag.explanation}</p>
              </div>
            ))}
          </div>
        )}

        {/* Suggestions */}
        {row.qaImprovementSuggestions && (
          <div>
            <h4 className="text-[10px] uppercase text-gray-400 font-medium tracking-wider mb-1">Suggestions</h4>
            <p className="text-xs text-gray-600 whitespace-pre-wrap">{row.qaImprovementSuggestions}</p>
          </div>
        )}

        {/* Conversation timeline */}
        {row.qaConversationJson && (
          <QaConversationTimeline json={row.qaConversationJson} />
        )}

        {/* Model */}
        {row.qaReviewModelId && (
          <p className="text-[10px] text-gray-400">by {row.qaReviewModelId}</p>
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

  const cardStyle = isPublished
    ? "bg-green-50/50 border-green-200"
    : hasDraft
      ? "bg-amber-50/50 border-amber-200"
      : "bg-white border-gray-200";

  return (
    <div className={`border rounded-lg overflow-hidden ${cardStyle}`}>
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-inherit flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wider">Human Correction</h3>
          {isPublished ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-800">
              &#10003; Published
            </span>
          ) : hasDraft ? (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-100 text-yellow-800">
              Draft
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-[10px] text-gray-400">
          {qa?.lastPublishedAt && (
            <span>{format(toDate(qa.lastPublishedAt), "MMM d, yyyy")}</span>
          )}
          {qa?.lastEditedBy && (
            <span>by {qa.lastEditedBy}</span>
          )}
          {isPublished && (
            <button
              onClick={() => void handleSave(false)}
              className="text-red-500 hover:text-red-700"
            >
              Unpublish
            </button>
          )}
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* Feedback toast */}
        {lastAction && (
          <div className={clsx(
            "px-3 py-1.5 rounded text-xs font-medium",
            lastAction === "published" ? "bg-green-100 text-green-700" :
              lastAction === "deepwiki-error" || lastAction === "error" ? "bg-red-100 text-red-700" :
                "bg-blue-100 text-blue-700"
          )}>
            {lastAction === "published" ? "Published to /questions" :
              lastAction === "deepwiki-error" ? "Failed to fetch from DeepWiki" :
                lastAction === "error" ? "Failed to save" :
                  "Draft saved"}
          </div>
        )}

        {/* Question */}
        <div>
          <label className="text-[10px] uppercase text-gray-400 font-medium mb-1 block tracking-wider">Question</label>
          <input
            type="text"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="The question..."
          />
        </div>

        {/* Answer */}
        <div>
          <label className="text-[10px] uppercase text-gray-400 font-medium mb-1 block tracking-wider">Answer</label>
          <textarea
            className="w-full h-40 px-3 py-2 border border-gray-300 rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y bg-white"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Write the corrected answer..."
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setQuestion(row.question);
              setAnswer(row.response);
            }}
            className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-300 rounded bg-white"
          >
            Pre-fill from call
          </button>
          <button
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
            className={clsx(
              "px-2 py-1 text-xs border rounded bg-white",
              deepWikiLoading ? "text-gray-400 border-gray-200" : "text-indigo-500 hover:text-indigo-700 border-indigo-300"
            )}
          >
            {deepWikiLoading ? "Fetching..." : "Pre-fill from DeepWiki"}
          </button>
          {hasUnsavedChanges && (
            <span className="text-[10px] text-amber-500">unsaved changes</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => void handleSave(!hasUnsavedChanges)}
              disabled={saveAction.disabled}
              className={clsx(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors hover:transition-none",
                saveAction.disabled
                  ? "text-gray-400 bg-gray-50 cursor-not-allowed"
                  : saveAction.isDraft
                    ? "text-gray-700 bg-gray-100 hover:bg-gray-200"
                    : "text-white bg-blue-600 hover:bg-blue-700",
              )}
            >
              {saveAction.label}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── QA Conversation Timeline ──────────────────────────

type QaStep = {
  step: number;
  text?: string;
  toolCalls?: Array<{ toolName: string; args: unknown }>;
  toolResults?: Array<{ toolName: string; toolCallId: string; result: unknown }>;
};

function formatByteSize(value: unknown): string {
  const str = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const bytes = new Blob([str]).size;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

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
        className="text-xs text-indigo-500 hover:text-indigo-700 flex items-center gap-1"
        onClick={() => setExpanded(prev => !prev)}
      >
        <span className="text-[10px]">{expanded ? "▾" : "▸"}</span>
        Reviewer Conversation ({steps.length} step{steps.length !== 1 ? "s" : ""})
      </button>
      {expanded && (
        <div className="mt-3 relative border-l-2 border-indigo-200 ml-1 space-y-4">
          {steps.map((step) => {
            const hasTools = step.toolCalls && step.toolCalls.length > 0;
            return hasTools
              ? <QaToolStep key={step.step} step={step} />
              : step.text ? <QaConclusionStep key={step.step} step={step} /> : null;
          })}
        </div>
      )}
    </div>
  );
}

function QaToolStep({ step }: { step: QaStep }) {
  const pairs = (step.toolCalls ?? []).map((tc, i) => ({
    toolName: tc.toolName,
    args: tc.args,
    result: step.toolResults?.[i]?.result ?? null,
  }));

  return (
    <div className="relative pl-5">
      <div className="absolute -left-[5px] top-2 w-2 h-2 rounded-full bg-indigo-400" />
      <p className="text-[10px] uppercase text-gray-400 font-medium mb-1.5">
        Step {step.step} — Verification
      </p>
      <div className="space-y-2">
        {pairs.map((pair, i) => (
          <QaToolCard key={i} pair={pair} />
        ))}
      </div>
      {step.text && (
        <div className="mt-2 bg-white/50 rounded p-2">
          <p className="text-xs text-gray-700 whitespace-pre-wrap">{step.text}</p>
        </div>
      )}
    </div>
  );
}

function QaToolCard({ pair }: { pair: { toolName: string; args: unknown; result: unknown } }) {
  const [resultExpanded, setResultExpanded] = useState(false);
  const resultStr = pair.result == null
    ? null
    : typeof pair.result === "string" ? pair.result : JSON.stringify(pair.result, null, 2);

  return (
    <div className="border border-indigo-200 rounded-lg overflow-hidden bg-white/50">
      <div className="px-3 py-1.5 bg-indigo-50">
        <span className="font-mono text-xs text-indigo-700">{pair.toolName}</span>
      </div>
      <div className="px-3 py-2 border-t border-indigo-100">
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] uppercase text-gray-400 font-medium">Args</p>
          <CopyButton text={JSON.stringify(pair.args, null, 2)} />
        </div>
        <pre className="text-xs text-gray-600 overflow-auto max-h-24">{JSON.stringify(pair.args, null, 2)}</pre>
      </div>
      {resultStr != null && (
        <div className="px-3 py-2 border-t border-indigo-100">
          <div className="w-full flex items-center justify-between text-[10px] uppercase text-gray-400 font-medium">
            <button
              className="hover:text-gray-600"
              onClick={() => setResultExpanded(prev => !prev)}
            >
              Result ({formatByteSize(pair.result)}) — {resultExpanded ? "collapse" : "expand"}
            </button>
            {resultExpanded && <CopyButton text={resultStr} />}
          </div>
          {resultExpanded && (
            <pre className="mt-1 text-xs text-gray-600 overflow-auto max-h-64 whitespace-pre-wrap">{resultStr}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function QaConclusionStep({ step }: { step: QaStep }) {
  const [expanded, setExpanded] = useState(false);
  const text = step.text ?? "";
  const truncated = text.length > 150 ? text.slice(0, 150) + "..." : text;

  return (
    <div className="relative pl-5">
      <div className="absolute -left-[5px] top-2 w-2 h-2 rounded-full bg-gray-400" />
      <p className="text-[10px] uppercase text-gray-400 font-medium mb-1.5">
        Step {step.step} — Conclusion
      </p>
      <div className="bg-white/50 rounded-lg p-3">
        <p className="text-xs text-gray-600 whitespace-pre-wrap">
          {expanded ? text : truncated}
        </p>
        {text.length > 150 && (
          <button
            className="text-xs text-indigo-500 hover:text-indigo-700 mt-1"
            onClick={() => setExpanded(prev => !prev)}
          >
            {expanded ? "show less" : "show full"}
          </button>
        )}
      </div>
    </div>
  );
}
