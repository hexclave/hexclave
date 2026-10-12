import { useMemo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AiQueryLogRow } from "../types";
import { toDate } from "../utils";
import { AssistantBubble, ToolCallCard, UserBubble } from "./ConversationReplay";
import { markdownComponents } from "./markdown-components";

type MessageIn = {
  role: "user" | "assistant" | "tool",
  content: unknown,
};

type StepEntry = {
  step: number,
  text?: string,
  toolCalls?: Array<{ toolName: string, toolCallId: string, args: unknown }>,
  toolResults?: Array<{ toolName: string, toolCallId: string, result: unknown }>,
};

function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
        return JSON.stringify(part);
      })
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

export function UsageDetail({ row, onClose }: { row: AiQueryLogRow, onClose: () => void }) {
  const messages: MessageIn[] = useMemo(() => {
    try {
      const parsed = JSON.parse(row.messagesJson);
      return Array.isArray(parsed) ? parsed as MessageIn[] : [];
    } catch {
      return [];
    }
  }, [row.messagesJson]);

  const steps: StepEntry[] = useMemo(() => {
    try {
      const parsed = JSON.parse(row.stepsJson);
      return Array.isArray(parsed) ? parsed as StepEntry[] : [];
    } catch {
      return [];
    }
  }, [row.stepsJson]);

  const requestedTools: string[] = useMemo(() => {
    try {
      const parsed = JSON.parse(row.requestedToolsJson);
      return Array.isArray(parsed) ? parsed as string[] : [];
    } catch {
      return [];
    }
  }, [row.requestedToolsJson]);

  const assistantBubbles = steps.map((s, i) => {
    const toolCalls = (s.toolCalls ?? []).map((tc, idx) => {
      const matched = s.toolResults?.find(r => r.toolCallId === tc.toolCallId) ?? s.toolResults?.[idx];
      return {
        type: "tool-call",
        toolName: tc.toolName,
        toolCallId: tc.toolCallId,
        args: tc.args,
        result: matched?.result ?? null,
      };
    });
    return { key: i, text: s.text ?? "", toolCalls };
  });

  const isError = row.errorMessage != null && row.errorMessage !== "";

  return (
    <div className="flex flex-col h-full bg-white">
      <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 font-mono text-[10px]">
              {row.systemPromptId}
            </span>
            <span className="inline-flex px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 font-mono text-[10px]">
              {row.modelId}
            </span>
            <span className="inline-flex px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-[10px]">
              {row.mode}
            </span>
            {isError && (
              <span className="inline-flex px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px]">error</span>
            )}
            {row.conversationId != null && (
              <span className="inline-flex px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px]">MCP</span>
            )}
          </div>
          <p className="text-[11px] text-gray-400 font-mono mt-1">
            {toDate(row.createdAt).toLocaleString()}
            {" · "}{Number(row.durationMs).toLocaleString()}ms
            {" · "}in {row.inputTokens?.toLocaleString() ?? "?"} tok
            {(() => {
              const r = row.cachedInputTokens ?? 0;
              const w = row.cacheCreationTokens ?? 0;
              if (r === 0 && w === 0) return null;
              const parts: string[] = [];
              if (r > 0) parts.push(`r ${r.toLocaleString()}`);
              if (w > 0) parts.push(`w ${w.toLocaleString()}`);
              return <> (cache {parts.join(", ")})</>;
            })()}
            {" · "}out {row.outputTokens?.toLocaleString() ?? "?"} tok
            {row.costUsd != null && <>{" · "}${row.costUsd.toFixed(4)}</>}
            {(() => {
              const savings = row.cacheDiscountUsd;
              if (savings == null) return null;
              const sign = savings >= 0 ? "+" : "−";
              const color = savings >= 0 ? "text-green-600" : "text-red-600";
              return <>{" · "}<span className={color}>cache {sign}${Math.abs(savings).toFixed(4)}</span></>;
            })()}
          </p>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 ml-2 text-gray-400 hover:text-gray-600 text-sm"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {isError && (
          <div className="mx-4 mt-4 rounded-lg bg-red-50 ring-1 ring-red-200 p-3">
            <p className="text-[10px] uppercase text-red-500 font-medium tracking-wider mb-1">Error</p>
            <pre className="text-xs text-red-800 whitespace-pre-wrap break-words font-mono">{row.errorMessage}</pre>
          </div>
        )}

        {/* Metadata panel */}
        <div className="m-4 bg-gray-50 rounded-lg p-3 space-y-1 text-xs">
          <MetaRow label="Quality / Speed" value={`${row.quality} / ${row.speed}`} />
          <MetaRow label="Authed" value={row.isAuthenticated ? "yes" : "no"} />
          {row.projectId && <MetaRow label="Project" value={row.projectId} />}
          {row.userId && <MetaRow label="User" value={row.userId} />}
          {row.conversationId && <MetaRow label="Conversation" value={row.conversationId} />}
          <MetaRow label="Steps" value={String(row.stepCount)} />
          <MetaRow label="Tools requested" value={requestedTools.length > 0 ? requestedTools.join(", ") : "—"} />
        </div>

        {/* Conversation replay */}
        <div className="px-4 pb-6 space-y-3">
          <h3 className="text-[10px] uppercase text-gray-400 font-medium tracking-wider">Input Messages</h3>
          {messages.length === 0 && (
            <p className="text-xs text-gray-400">No input messages.</p>
          )}
          {messages.map((m, i) => {
            const text = messageContentToText(m.content);
            if (m.role === "user") {
              return <UserBubble key={`in-${i}`} text={text} />;
            }
            if (m.role === "assistant") {
              return <AssistantBubble key={`in-${i}`} content={text} toolCalls={[]} />;
            }
            return (
              <div key={`in-${i}`} className="flex gap-2.5 justify-start">
                <div className="shrink-0 w-6 h-6 mt-0.5 rounded-full bg-gray-200 flex items-center justify-center">
                  <span className="text-gray-500 text-[10px] font-bold">T</span>
                </div>
                <div className="rounded-xl px-3.5 py-2 bg-gray-50 max-w-[80%]">
                  <pre className="text-[11px] font-mono text-gray-600 whitespace-pre-wrap break-all">{text}</pre>
                </div>
              </div>
            );
          })}

          <h3 className="text-[10px] uppercase text-gray-400 font-medium tracking-wider pt-2">Assistant Steps</h3>
          {assistantBubbles.length === 0 && (
            <p className="text-xs text-gray-400">No assistant output recorded.</p>
          )}
          {assistantBubbles.map(bubble => (
            <div key={bubble.key} className="space-y-1.5">
              {bubble.toolCalls.length > 0 && (
                <div className="space-y-1.5">
                  {bubble.toolCalls.map((call, i) => (
                    <ToolCallCard key={call.toolCallId || String(i)} call={call} />
                  ))}
                </div>
              )}
              {bubble.text && (
                <div className="flex gap-2.5 justify-start">
                  <div className="shrink-0 w-6 h-6 mt-0.5 rounded-full bg-purple-100 flex items-center justify-center">
                    <span className="text-purple-500 text-xs font-bold">AI</span>
                  </div>
                  <div className="min-w-0 max-w-[calc(100%-2rem)] rounded-xl px-3.5 py-2 bg-gray-50">
                    <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {bubble.text}
                    </Markdown>
                  </div>
                </div>
              )}
            </div>
          ))}

          {row.finalText && assistantBubbles.length === 0 && (
            <>
              <h3 className="text-[10px] uppercase text-gray-400 font-medium tracking-wider pt-2">Final Response</h3>
              <div className="rounded-xl px-3.5 py-2 bg-blue-50">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {row.finalText}
                </Markdown>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex gap-2">
      <span className="text-[10px] uppercase text-gray-400 font-medium tracking-wider w-32 shrink-0">{label}</span>
      <span className="text-gray-700 font-mono break-all">{value}</span>
    </div>
  );
}
