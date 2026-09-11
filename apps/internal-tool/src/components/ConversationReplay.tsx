import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { McpCallLogRow } from "../types";
import { toDate } from "../utils";
import { Badge, Button, cn } from "./design";
import { markdownComponents } from "./markdown-components";

const microLabelClasses = "text-[10px] font-medium uppercase tracking-wider text-muted-foreground";

export type ToolCall = {
  type: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  result: unknown;
};

/**
 * Which agent a bubble belongs to. The MCP answer and the QA reviewer are two
 * different models reasoning about the same call, and the panel shows both, so
 * they get different accents to keep it obvious whose trace you are reading.
 */
export type BubbleAccent = "purple" | "indigo";

const bubbleAvatarClasses = new Map<BubbleAccent, { ring: string, text: string }>([
  ["purple", { ring: "bg-purple-500/15", text: "text-purple-600 dark:text-purple-400" }],
  ["indigo", { ring: "bg-indigo-500/15", text: "text-indigo-600 dark:text-indigo-400" }],
]);

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:transition-none hover:bg-foreground/[0.06] hover:text-foreground"
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

export function ToolCallCard({ call, accent = "purple" }: { call: { toolName: string; args: unknown; result: unknown }; accent?: BubbleAccent }) {
  const [expanded, setExpanded] = useState(false);
  const colors = accent === "indigo"
    ? { dot: "text-indigo-500 dark:text-indigo-400", name: "text-indigo-700 dark:text-indigo-300", bg: "bg-indigo-500/[0.08]", ring: "ring-indigo-500/20" }
    : { dot: "text-purple-500 dark:text-purple-400", name: "text-purple-700 dark:text-purple-300", bg: "bg-foreground/[0.04]", ring: "ring-foreground/[0.06]" };

  return (
    <div className={cn("overflow-hidden rounded-lg ring-1", colors.bg, colors.ring)}>
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:transition-none hover:bg-foreground/[0.05]"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={cn("text-xs", colors.dot)}>&#9673;</span>
        <span className={cn("flex-1 font-mono text-xs font-medium", colors.name)}>{call.toolName}</span>
        <span className="text-[10px] text-muted-foreground">{expanded ? "collapse" : "expand"}</span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-black/[0.06] px-3 pb-3 pt-1 dark:border-white/[0.06]">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className={microLabelClasses}>Args</span>
              <CopyButton text={JSON.stringify(call.args, null, 2)} />
            </div>
            <pre className="max-h-32 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded bg-card px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className={microLabelClasses}>Result</span>
              <CopyButton text={typeof call.result === "string" ? call.result : JSON.stringify(call.result, null, 2)} />
            </div>
            <pre className="max-h-32 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded bg-card px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
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
      <div className="max-w-[80%] rounded-xl bg-blue-500/10 px-3.5 py-2 text-foreground">
        <p className="break-words text-sm leading-relaxed">{text}</p>
      </div>
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-500/15">
        <span className="text-xs font-bold text-blue-600 dark:text-blue-400">U</span>
      </div>
    </div>
  );
}

export function AssistantBubble({ content, toolCalls, accent = "purple", label = "AI" }: {
  content: string,
  toolCalls: ToolCall[],
  accent?: BubbleAccent,
  label?: string,
}) {
  const avatar = bubbleAvatarClasses.get(accent)
    ?? throwErr(`No avatar classes for accent ${accent}; bubbleAvatarClasses must cover every BubbleAccent`);
  return (
    <div className="flex gap-2.5 justify-start">
      <div className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", avatar.ring)}>
        <span className={cn("text-[10px] font-bold", avatar.text)}>{label}</span>
      </div>
      <div className="min-w-0 max-w-[calc(100%-2rem)] flex flex-col gap-2">
        {toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {toolCalls.map((call, i) => (
              <ToolCallCard key={call.toolCallId || String(i)} call={call} accent={accent} />
            ))}
          </div>
        )}
        {content && (
          <div className="rounded-xl bg-foreground/[0.04] px-3.5 py-2">
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {content}
            </Markdown>
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex gap-2.5 justify-start">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-500/15">
        <span className="text-xs font-bold text-purple-600 dark:text-purple-400">AI</span>
      </div>
      <div className="rounded-xl bg-foreground/[0.04] px-3.5 py-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="inline-flex gap-0.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" style={{ animationDelay: "150ms" }} />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-purple-500 dark:bg-purple-400" style={{ animationDelay: "300ms" }} />
          </span>
          <span>Thinking...</span>
        </div>
      </div>
    </div>
  );
}

function CallDivider({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="h-px flex-1 bg-border" />
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Call {current} of {total}</span>
      <div className="h-px flex-1 bg-border" />
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

  const responseWords = row.response.split(/(\s+)/);
  const totalWords = responseWords.filter(w => w.trim()).length;
  return { toolCalls, responseWords, totalWords };
}

// ─── Phases ─────────────────────────────────────────────

type ReplayPhase =
  | "question" | "thinking" | "tools" | "response"
  | "call-divider"
  | "done";

// ─── Main Component ─────────────────────────────────────

export function ConversationReplay({ row, allRows }: { row: McpCallLogRow; allRows: McpCallLogRow[] }) {
  const conversationRows = useMemo(() => {
    if (row.conversationId) {
      const related = allRows
        .filter(r => r.conversationId === row.conversationId)
        .sort((a, b) => Number(toDate(a.createdAt)) - Number(toDate(b.createdAt)));
      if (related.length > 1) return related;
    }
    return [row];
  }, [row, allRows]);

  // The recorded conversation is useful immediately; Play temporarily replaces it with the
  // animated trace instead of hiding the primary evidence behind another modal.
  const [phase, setPhase] = useState<ReplayPhase>("done");
  const [callIndex, setCallIndex] = useState(0);
  const [visibleToolCount, setVisibleToolCount] = useState(0);
  const [revealedWords, setRevealedWords] = useState(0);
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

  // The replay used to scroll its own card; the transcript now sits flat in the
  // detail panel, so "follow along" means scrolling whichever ancestor actually
  // scrolls. scrollIntoView walks up and finds it, which keeps the animation
  // watchable without this component knowing what it is nested in.
  const scrollToBottom = useCallback(() => {
    containerRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, []);

  // Phase sequencer
  useEffect(() => {
    if (phase === "done") return;

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
        setPhase("question");
        scrollToBottom();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [phase, visibleToolCount, revealedWords, callData, callIndex, conversationRows.length, scrollToBottom]);

  const startReplay = () => {
    setPhase("question");
    setCallIndex(0);
    setCompletedCalls(0);
    setVisibleToolCount(0);
    setRevealedWords(0);
  };

  const skipToEnd = () => {
    setPhase("done");
    setCallIndex(conversationRows.length - 1);
    setCompletedCalls(conversationRows.length);
    setVisibleToolCount(999);
    setRevealedWords(999);
  };

  const totalSteps = conversationRows.reduce((sum, r) => sum + r.stepCount, 0);
  const totalDuration = conversationRows.reduce((sum, r) => sum + Number(r.durationMs), 0);

  return (
    // No card: the transcript is the primary content of this tab, so it reads
    // directly on the panel background like the AI usage conversation does,
    // rather than as a boxed widget inside an already-boxed panel.
    <section className="space-y-3 pb-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className={microLabelClasses}>Conversation</h3>
          <Badge>{isMultiCall ? `${conversationRows.length} calls` : "1 call"}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {phase !== "done" && (
            <Button onClick={skipToEnd}>Skip</Button>
          )}
          {phase === "done" && (
            <Button variant="default" onClick={startReplay}>▶ Play</Button>
          )}
        </div>
      </div>

      <div ref={containerRef} className="space-y-4">
        {/* Sliced from the rows themselves rather than counted up to `completedCalls`, which can
            exceed the row count if the live subscription drops a row mid-replay. */}
        {(phase === "done" ? conversationRows : conversationRows.slice(0, completedCalls)).map((completedRow, i) => {
          const completedCall = parseCallData(completedRow);
          return (
            <div key={String(completedRow.id)} className="space-y-4">
              {i > 0 && <CallDivider current={i + 1} total={conversationRows.length} />}
              {completedRow.userPrompt && (
                <div className="text-center">
                  <span className={microLabelClasses}>Original Prompt</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">{completedRow.userPrompt}</p>
                </div>
              )}
              <UserBubble text={completedRow.question} />
              <AssistantBubble content={completedRow.response} toolCalls={completedCall.toolCalls} />
            </div>
          );
        })}

        {phase !== "done" && (
          <div className="space-y-4">
            {callIndex > 0 && callIndex > completedCalls - 1 && (
              <CallDivider current={callIndex + 1} total={conversationRows.length} />
            )}

            {currentRow.userPrompt && (
              <div className="text-center">
                <span className={microLabelClasses}>Original Prompt</span>
                <p className="mt-0.5 text-xs text-muted-foreground">{currentRow.userPrompt}</p>
              </div>
            )}

            <UserBubble text={currentRow.question} />

            {phase === "thinking" && <ThinkingIndicator />}

            {(phase === "tools" || phase === "response" || phase === "call-divider") && (
              <AssistantBubble
                content={
                  phase === "tools" ? "" :
                    phase === "call-divider" ? currentRow.response :
                      getPartialText(callData.responseWords, revealedWords)
                }
                toolCalls={callData.toolCalls.slice(0, phase === "tools" ? visibleToolCount : callData.toolCalls.length)}
              />
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1 text-[10px] text-muted-foreground">
        <span>
          {totalSteps} step{totalSteps !== 1 ? "s" : ""} {"\u00B7"} {totalDuration.toLocaleString()}ms
          {isMultiCall && ` \u00B7 ${conversationRows.length} calls`}
        </span>
        <span className="font-mono">{currentRow.modelId}</span>
      </div>
    </section>
  );
}
