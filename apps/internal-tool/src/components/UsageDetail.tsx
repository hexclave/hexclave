import { useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatAiRequestContext } from "../lib/copy-log-context";
import type { AiQueryLogRow } from "../types";
import { toDate } from "../utils";
import { AssistantBubble, ToolCallCard, UserBubble } from "./ConversationReplay";
import { CopyFullContextButton } from "./CopyFullContextButton";
import { DetailMetricStrip, DetailPanelTabs } from "./DetailPanelNavigation";
import { Alert, Badge, Button } from "./design";
import { markdownComponents } from "./markdown-components";

const sectionLabelClasses = "text-[10px] font-medium uppercase tracking-wider text-muted-foreground";

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
  const [activeSection, setActiveSection] = useState<"conversation" | "request">("conversation");
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
  const inputTokens = row.inputTokens?.toLocaleString() ?? "Unknown";
  const outputTokens = row.outputTokens?.toLocaleString() ?? "Unknown";

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-10 bg-background/95 pt-4 backdrop-blur-md">
        <div className="flex items-start justify-between gap-4 px-4 pb-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-foreground">AI request</h2>
              <Badge color={isError ? "red" : "green"} size="xs">{isError ? "Error" : "Completed"}</Badge>
              {row.conversationId != null && <Badge color="orange" size="xs">MCP</Badge>}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
              <span className="font-mono">{row.modelId}</span>
              <span aria-hidden="true">·</span>
              <span>{toDate(row.createdAt).toLocaleString()}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CopyFullContextButton getText={() => formatAiRequestContext(row)} subject="AI request" />
            <Button variant="ghost" className="size-7 shrink-0 px-0 text-base" aria-label="Close AI request details" onClick={onClose}>×</Button>
          </div>
        </div>
        <DetailMetricStrip items={[
          { label: "Duration", value: `${Number(row.durationMs).toLocaleString()}ms` },
          { label: "Input", value: `${inputTokens} tok` },
          { label: "Output", value: `${outputTokens} tok` },
          { label: "Cost", value: row.costUsd == null ? "Unpriced" : `$${row.costUsd.toFixed(4)}` },
        ]} />
        <DetailPanelTabs
          label="AI request detail sections"
          value={activeSection}
          onChange={setActiveSection}
          items={[
            { value: "conversation", label: "Conversation" },
            { value: "request", label: "Request details" },
          ]}
        />
      </header>

      <div className="flex-1 p-4">
        {isError && (
          <Alert className="mb-4 p-3">
            <p className="mb-1 text-[10px] font-medium uppercase tracking-wider">Request error</p>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs">{row.errorMessage}</pre>
          </Alert>
        )}

        {activeSection === "conversation" && <div role="tabpanel" className="space-y-3 pb-6">
          <h3 className={sectionLabelClasses}>Input messages</h3>
          {messages.length === 0 && (
            <p className="text-xs text-muted-foreground">No input messages.</p>
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
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-foreground/10">
                  <span className="text-[10px] font-bold text-muted-foreground">T</span>
                </div>
                <div className="max-w-[80%] rounded-xl bg-foreground/[0.04] px-3.5 py-2">
                  <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{text}</pre>
                </div>
              </div>
            );
          })}

          <h3 className={`${sectionLabelClasses} pt-3`}>Assistant trace</h3>
          {assistantBubbles.length === 0 && (
            <p className="text-xs text-muted-foreground">No assistant output recorded.</p>
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
                  <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-500/15">
                    <span className="text-xs font-bold text-purple-600 dark:text-purple-400">AI</span>
                  </div>
                  <div className="min-w-0 max-w-[calc(100%-2rem)] rounded-xl bg-foreground/[0.04] px-3.5 py-2">
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
              <h3 className={`${sectionLabelClasses} pt-3`}>Final response</h3>
              <div className="rounded-xl bg-blue-500/10 px-3.5 py-2">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {row.finalText}
                </Markdown>
              </div>
            </>
          )}
        </div>}

        {activeSection === "request" && <div role="tabpanel" className="pb-6">
          <section>
            <h3 className="mb-2 text-xs font-semibold text-foreground">Routing</h3>
            <div className="divide-y divide-black/[0.06] border-y border-black/[0.06] dark:divide-white/[0.06] dark:border-white/[0.06]">
              <MetaRow label="System prompt" value={row.systemPromptId} />
              <MetaRow label="Model" value={row.modelId} />
              <MetaRow label="Mode" value={row.mode} />
              <MetaRow label="Quality / speed" value={`${row.quality} / ${row.speed}`} />
              <MetaRow label="Steps" value={String(row.stepCount)} />
              <MetaRow label="Tools requested" value={requestedTools.length > 0 ? requestedTools.join(", ") : "None"} />
            </div>
          </section>
          <section className="mt-6">
            <h3 className="mb-2 text-xs font-semibold text-foreground">Identity</h3>
            <div className="divide-y divide-black/[0.06] border-y border-black/[0.06] dark:divide-white/[0.06] dark:border-white/[0.06]">
              <MetaRow label="Authentication" value={row.isAuthenticated ? "Authenticated" : "Anonymous"} />
              {row.projectId && <MetaRow label="Project" value={row.projectId} />}
              {row.userId && <MetaRow label="User" value={row.userId} />}
              {row.conversationId && <MetaRow label="Conversation" value={row.conversationId} />}
            </div>
          </section>
          {(row.cachedInputTokens != null || row.cacheCreationTokens != null || row.cacheDiscountUsd != null) && (
            <section className="mt-6">
              <h3 className="mb-2 text-xs font-semibold text-foreground">Prompt cache</h3>
              <div className="divide-y divide-black/[0.06] border-y border-black/[0.06] dark:divide-white/[0.06] dark:border-white/[0.06]">
                <MetaRow label="Cache read" value={`${(row.cachedInputTokens ?? 0).toLocaleString()} tok`} />
                <MetaRow label="Cache write" value={`${(row.cacheCreationTokens ?? 0).toLocaleString()} tok`} />
                {row.cacheDiscountUsd != null && <MetaRow label="Savings" value={`$${row.cacheDiscountUsd.toFixed(4)}`} />}
              </div>
            </section>
          )}
        </div>}
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string, value: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-3 py-2.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="break-all font-mono text-foreground">{value}</span>
    </div>
  );
}
