import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { McpCallLogRow } from "../types";
import { toDate } from "../utils";
import { markdownComponents } from "./markdown-components";

type ToolCall = {
  type: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  result: unknown;
};

type QaStep = {
  step: number;
  text?: string;
  toolCalls?: Array<{ toolName: string; args: unknown }>;
  toolResults?: Array<{ toolName: string; toolCallId: string; result: unknown }>;
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="shrink-0 rounded p-0.5 transition-colors text-gray-400 hover:text-gray-600 hover:bg-gray-100"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }, (err) => {
          console.error("Clipboard write failed:", err);
        });
      }}
    >
      <span className="text-[10px]">{copied ? "copied" : "copy"}</span>
    </button>
  );
}

export function ToolCallCard({ call, accent = "purple" }: { call: { toolName: string; args: unknown; result: unknown }; accent?: "purple" | "indigo" }) {
  const [expanded, setExpanded] = useState(false);
  const colors = accent === "indigo"
    ? { dot: "text-indigo-500", name: "text-indigo-700", bg: "bg-indigo-50", ring: "ring-indigo-200", hover: "hover:bg-indigo-100" }
    : { dot: "text-purple-500", name: "text-purple-700", bg: "bg-gray-50", ring: "ring-gray-200", hover: "hover:bg-gray-100" };

  return (
    <div className={`rounded-lg overflow-hidden ${colors.bg} ring-1 ${colors.ring} transition-all`}>
      <button
        className={`w-full flex items-center gap-2 px-3 py-2 text-left ${colors.hover} transition-colors`}
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`${colors.dot} text-xs`}>&#9673;</span>
        <span className={`text-xs font-medium ${colors.name} flex-1 font-mono`}>{call.toolName}</span>
        <span className="text-[10px] text-gray-400">{expanded ? "collapse" : "expand"}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-gray-200">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Args</span>
              <CopyButton text={JSON.stringify(call.args, null, 2)} />
            </div>
            <pre className="text-[11px] font-mono text-gray-600 bg-white rounded px-2 py-1.5 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Result</span>
              <CopyButton text={typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2)} />
            </div>
            <pre className="text-[11px] font-mono text-gray-600 bg-white rounded px-2 py-1.5 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
              {typeof call.result === "string" ? call.result.slice(0, 500) : JSON.stringify(call.result, null, 2).slice(0, 500)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex gap-2.5 justify-end">
      <div className="rounded-xl px-3.5 py-2 max-w-[80%] bg-blue-50 text-gray-900">
        <p className="text-sm leading-relaxed break-words">{text}</p>
      </div>
      <div className="shrink-0 w-6 h-6 mt-0.5 rounded-full bg-blue-100 flex items-center justify-center">
        <span className="text-blue-500 text-xs font-bold">U</span>
      </div>
    </div>
  );
}

export function AssistantBubble({ content, toolCalls }: { content: string; toolCalls: ToolCall[] }) {
  return (
    <div className="flex gap-2.5 justify-start">
      <div className="shrink-0 w-6 h-6 mt-0.5 rounded-full bg-purple-100 flex items-center justify-center">
        <span className="text-purple-500 text-xs font-bold">AI</span>
      </div>
      <div className="min-w-0 max-w-[calc(100%-2rem)] flex flex-col gap-2">
        {toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {toolCalls.map((call, i) => (
              <ToolCallCard key={call.toolCallId || String(i)} call={call} />
            ))}
          </div>
        )}
        {content && (
          <div className="rounded-xl px-3.5 py-2 bg-gray-50">
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {content}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

function QaReviewerBubble({ content, toolCalls, score }: { content: string; toolCalls: Array<{ toolName: string; args: unknown; result: unknown }>; score?: number }) {
  return (
    <div className="flex gap-2.5 justify-start">
      <div className="shrink-0 w-6 h-6 mt-0.5 rounded-full bg-indigo-100 flex items-center justify-center">
        <span className="text-indigo-500 text-xs font-bold">QA</span>
      </div>
      <div className="min-w-0 max-w-[calc(100%-2rem)] flex flex-col gap-2">
        {toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {toolCalls.map((call, i) => (
              <ToolCallCard key={String(i)} call={call} accent="indigo" />
            ))}
          </div>
        )}
        {content && (
          <div className="rounded-xl px-3.5 py-2 bg-indigo-50">
            <p className="text-sm text-gray-700 whitespace-pre-wrap">{content.slice(0, 300)}{content.length > 300 ? "..." : ""}</p>
          </div>
        )}
        {score != null && (
          <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm font-bold ${
            score >= 80 ? "bg-green-100 text-green-700" : score >= 50 ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"
          }`}>
            Score: {score}
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingIndicator({ label = "Thinking...", color = "purple" }: { label?: string; color?: "purple" | "indigo" }) {
  const bgColor = color === "indigo" ? "bg-indigo-100" : "bg-purple-100";
  const textColor = color === "indigo" ? "text-indigo-500" : "text-purple-500";
  const dotColor = color === "indigo" ? "bg-indigo-400" : "bg-purple-400";
  const avatarText = color === "indigo" ? "QA" : "AI";

  return (
    <div className="flex gap-2.5 justify-start">
      <div className={`shrink-0 w-6 h-6 rounded-full ${bgColor} flex items-center justify-center`}>
        <span className={`${textColor} text-xs font-bold`}>{avatarText}</span>
      </div>
      <div className="bg-gray-50 rounded-xl px-3.5 py-2">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <span className="inline-flex gap-0.5">
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor} animate-pulse`} />
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor} animate-pulse`} style={{ animationDelay: "150ms" }} />
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor} animate-pulse`} style={{ animationDelay: "300ms" }} />
          </span>
          <span>{label}</span>
        </div>
      </div>
    </div>
  );
}

function Divider({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex-1 h-px bg-indigo-200" />
      <span className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wider">{text}</span>
      <div className="flex-1 h-px bg-indigo-200" />
    </div>
  );
}

function CallDivider({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1 h-px bg-gray-300" />
      <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Call {current} of {total}</span>
      <div className="flex-1 h-px bg-gray-300" />
    </div>
  );
}

// ─── Per-call data ──────────────────────────────────────

function parseCallData(row: McpCallLogRow) {
  let toolCalls: ToolCall[] = [];
  try {
    toolCalls = JSON.parse(row.innerToolCallsJson) as ToolCall[];
  } catch {
    // ignore
  }

  let qaSteps: QaStep[] = [];
  try {
    if (row.qaConversationJson) {
      qaSteps = JSON.parse(row.qaConversationJson) as QaStep[];
    }
  } catch {
    // ignore
  }

  const qaToolCalls = qaSteps.flatMap(s =>
    (s.toolCalls ?? []).map((tc, i) => ({
      toolName: tc.toolName,
      args: tc.args,
      result: s.toolResults?.[i]?.result ?? null,
    }))
  );
  const qaVerdictText = qaSteps.find(s => s.text && !s.toolCalls?.length)?.text ?? "";
  const hasQa = qaSteps.length > 0;

  const responseWords = row.response.split(/(\s+)/);
  const totalWords = responseWords.filter(w => w.trim()).length;

  const qaVerdictWords = qaVerdictText.split(/(\s+)/);
  const totalQaWords = qaVerdictWords.filter(w => w.trim()).length;

  return { toolCalls, qaToolCalls, qaVerdictText, qaVerdictWords, hasQa, responseWords, totalWords, totalQaWords };
}

// ─── Phases ─────────────────────────────────────────────

type ReplayPhase =
  | "idle" | "question" | "thinking" | "tools" | "response"
  | "qa-divider" | "qa-thinking" | "qa-tools" | "qa-verdict"
  | "call-divider"
  | "done";

// ─── Main Component ─────────────────────────────────────

export function ConversationReplay({ row, allRows, onClose }: { row: McpCallLogRow; allRows: McpCallLogRow[]; onClose: () => void }) {
  const conversationRows = useMemo(() => {
    if (row.conversationId) {
      const related = allRows
        .filter(r => r.conversationId === row.conversationId)
        .sort((a, b) => Number(toDate(a.createdAt)) - Number(toDate(b.createdAt)));
      if (related.length > 1) return related;
    }
    return [row];
  }, [row, allRows]);

  const [phase, setPhase] = useState<ReplayPhase>("idle");
  const [callIndex, setCallIndex] = useState(0);
  const [visibleToolCount, setVisibleToolCount] = useState(0);
  const [revealedWords, setRevealedWords] = useState(0);
  const [qaVisibleToolCount, setQaVisibleToolCount] = useState(0);
  const [qaRevealedWords, setQaRevealedWords] = useState(0);
  // Track completed calls for rendering
  const [completedCalls, setCompletedCalls] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentRow = conversationRows[callIndex] ?? conversationRows[0];
  const callData = useMemo(() => parseCallData(currentRow), [currentRow]);
  const isMultiCall = conversationRows.length > 1;

  const getPartialText = useCallback((words: string[], revealed: number) => {
    let wordCount = 0;
    let result = "";
    for (const part of words) {
      if (part.trim()) {
        wordCount++;
        if (wordCount > revealed) break;
      }
      result += part;
    }
    return result;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  // Phase sequencer
  useEffect(() => {
    if (phase === "idle" || phase === "done") return;

    if (phase === "question") {
      const timer = setTimeout(() => {
        setPhase("thinking");
        scrollToBottom();
      }, 800);
      return () => clearTimeout(timer);
    }
    if (phase === "thinking") {
      const timer = setTimeout(() => {
        setPhase(callData.toolCalls.length > 0 ? "tools" : "response");
        scrollToBottom();
      }, 1200);
      return () => clearTimeout(timer);
    }
    if (phase === "tools") {
      if (visibleToolCount < callData.toolCalls.length) {
        const timer = setTimeout(() => {
          setVisibleToolCount(prev => prev + 1);
          scrollToBottom();
        }, 600);
        return () => clearTimeout(timer);
      }
      const timer = setTimeout(() => {
        setPhase("response");
        scrollToBottom();
      }, 400);
      return () => clearTimeout(timer);
    }
    if (phase === "response") {
      if (revealedWords < callData.totalWords) {
        const timer = setTimeout(() => {
          setRevealedWords(prev => Math.min(prev + 3, callData.totalWords));
          scrollToBottom();
        }, 20);
        return () => clearTimeout(timer);
      }
      if (callData.hasQa) {
        const timer = setTimeout(() => {
          setPhase("qa-divider");
          scrollToBottom();
        }, 600);
        return () => clearTimeout(timer);
      }
      // No QA — go to next call or done
      if (callIndex < conversationRows.length - 1) {
        const timer = setTimeout(() => {
          setPhase("call-divider");
          scrollToBottom();
        }, 400);
        return () => clearTimeout(timer);
      }
      setPhase("done");
      return;
    }
    if (phase === "qa-divider") {
      const timer = setTimeout(() => {
        setPhase("qa-thinking");
        scrollToBottom();
      }, 500);
      return () => clearTimeout(timer);
    }
    if (phase === "qa-thinking") {
      const timer = setTimeout(() => {
        setPhase(callData.qaToolCalls.length > 0 ? "qa-tools" : "qa-verdict");
        scrollToBottom();
      }, 800);
      return () => clearTimeout(timer);
    }
    if (phase === "qa-tools") {
      if (qaVisibleToolCount < callData.qaToolCalls.length) {
        const timer = setTimeout(() => {
          setQaVisibleToolCount(prev => prev + 1);
          scrollToBottom();
        }, 600);
        return () => clearTimeout(timer);
      }
      const timer = setTimeout(() => {
        setPhase("qa-verdict");
        scrollToBottom();
      }, 400);
      return () => clearTimeout(timer);
    }
    if (phase === "qa-verdict") {
      if (qaRevealedWords < callData.totalQaWords) {
        const timer = setTimeout(() => {
          setQaRevealedWords(prev => Math.min(prev + 3, callData.totalQaWords));
          scrollToBottom();
        }, 20);
        return () => clearTimeout(timer);
      }
      if (callIndex < conversationRows.length - 1) {
        const timer = setTimeout(() => {
          setPhase("call-divider");
          scrollToBottom();
        }, 400);
        return () => clearTimeout(timer);
      }
      setPhase("done");
      return;
    }
    // phase === "call-divider"
    {
      const timer = setTimeout(() => {
        setCompletedCalls(callIndex + 1);
        setCallIndex(prev => prev + 1);
        setVisibleToolCount(0);
        setRevealedWords(0);
        setQaVisibleToolCount(0);
        setQaRevealedWords(0);
        setPhase("question");
        scrollToBottom();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [phase, visibleToolCount, revealedWords, qaVisibleToolCount, qaRevealedWords, callData, callIndex, conversationRows.length, scrollToBottom]);

  const startReplay = () => {
    setPhase("question");
    setCallIndex(0);
    setCompletedCalls(0);
    setVisibleToolCount(0);
    setRevealedWords(0);
    setQaVisibleToolCount(0);
    setQaRevealedWords(0);
  };

  const skipToEnd = () => {
    setPhase("done");
    setCallIndex(conversationRows.length - 1);
    setCompletedCalls(conversationRows.length);
    setVisibleToolCount(999);
    setRevealedWords(999);
    setQaVisibleToolCount(999);
    setQaRevealedWords(999);
  };

  const showQaSection = phase === "qa-divider" || phase === "qa-thinking" || phase === "qa-tools" || phase === "qa-verdict";
  const isActiveOrDone = phase !== "idle";

  // Aggregate stats
  const totalSteps = conversationRows.reduce((sum, r) => sum + r.stepCount, 0);
  const totalDuration = conversationRows.reduce((sum, r) => sum + Number(r.durationMs), 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-8">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900">
              {isMultiCall ? "Conversation Replay" : "Call Replay"}
            </h2>
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">
              {isMultiCall ? `${conversationRows.length} calls` : currentRow.toolName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {phase === "idle" && (
              <button onClick={startReplay} className="px-3 py-1 text-xs font-medium text-white bg-purple-600 rounded-md hover:bg-purple-700">
                Play
              </button>
            )}
            {phase !== "idle" && phase !== "done" && (
              <button onClick={skipToEnd} className="px-3 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded-md hover:bg-gray-200">
                Skip
              </button>
            )}
            {phase === "done" && (
              <button onClick={startReplay} className="px-3 py-1 text-xs font-medium text-purple-600 bg-purple-50 rounded-md hover:bg-purple-100">
                Replay
              </button>
            )}
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm px-2">
              close
            </button>
          </div>
        </div>

        {/* Conversation area */}
        <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {phase === "idle" && (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Click Play to replay this {isMultiCall ? "conversation" : "call"}
            </div>
          )}

          {isActiveOrDone && (
            <>
              {/* Completed calls */}
              {Array.from({ length: phase === "done" ? conversationRows.length : completedCalls }).map((_, i) => {
                const r = conversationRows[i];
                const d = parseCallData(r);
                return (
                  <div key={String(r.id)} className="space-y-4">
                    {i > 0 && <CallDivider current={i + 1} total={conversationRows.length} />}
                    {r.userPrompt && (
                      <div className="text-center">
                        <span className="text-[10px] uppercase text-gray-400 font-medium tracking-wider">Original Prompt</span>
                        <p className="text-xs text-gray-500 mt-0.5">{r.userPrompt}</p>
                      </div>
                    )}
                    <UserBubble text={r.question} />
                    <AssistantBubble content={r.response} toolCalls={d.toolCalls} />
                    {d.hasQa && (
                      <>
                        <Divider text="AI QA Review" />
                        <QaReviewerBubble
                          content={d.qaVerdictText}
                          toolCalls={d.qaToolCalls}
                          score={r.qaOverallScore ?? undefined}
                        />
                      </>
                    )}
                  </div>
                );
              })}

              {/* Current call being animated (only if not done) */}
              {phase !== "done" && (
                <div className="space-y-4">
                  {callIndex > 0 && callIndex > completedCalls - 1 && (
                    <CallDivider current={callIndex + 1} total={conversationRows.length} />
                  )}

                  {currentRow.userPrompt && (
                    <div className="text-center">
                      <span className="text-[10px] uppercase text-gray-400 font-medium tracking-wider">Original Prompt</span>
                      <p className="text-xs text-gray-500 mt-0.5">{currentRow.userPrompt}</p>
                    </div>
                  )}

                  <UserBubble text={currentRow.question} />

                  {phase === "thinking" && <ThinkingIndicator />}

                  {(phase === "tools" || phase === "response" || showQaSection || phase === "call-divider") && (
                    <AssistantBubble
                      content={
                        phase === "tools" ? "" :
                          showQaSection || phase === "call-divider" ? currentRow.response :
                        getPartialText(callData.responseWords, revealedWords)
                      }
                      toolCalls={callData.toolCalls.slice(0, phase === "tools" ? visibleToolCount : callData.toolCalls.length)}
                    />
                  )}

                  {(showQaSection || phase === "call-divider") && callData.hasQa && (
                    <>
                      <Divider text="AI QA Review" />
                      {phase === "qa-thinking" && <ThinkingIndicator label="Reviewing..." color="indigo" />}
                      {(phase === "qa-tools" || phase === "qa-verdict" || phase === "call-divider") && (
                        <QaReviewerBubble
                          content={
                            phase === "qa-tools" ? "" :
                              phase === "call-divider" ? callData.qaVerdictText :
                            getPartialText(callData.qaVerdictWords, qaRevealedWords)
                          }
                          toolCalls={callData.qaToolCalls.slice(0, phase === "qa-tools" ? qaVisibleToolCount : callData.qaToolCalls.length)}
                          score={phase === "call-divider" ? currentRow.qaOverallScore ?? undefined : undefined}
                        />
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-between text-xs text-gray-400">
          <span>
            {totalSteps} step{totalSteps !== 1 ? "s" : ""} {"\u00B7"} {totalDuration.toLocaleString()}ms
            {isMultiCall && ` \u00B7 ${conversationRows.length} calls`}
          </span>
          <span>{currentRow.modelId}</span>
        </div>
      </div>
    </div>
  );
}
