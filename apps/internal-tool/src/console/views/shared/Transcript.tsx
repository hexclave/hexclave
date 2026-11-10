"use client";

import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../../components/design/cn";
import { markdownComponents } from "../../../components/markdown-components";
import { Icon } from "../../ui/icons";
import { Badge } from "../../ui/primitives";

export type TranscriptToolCall = { toolName: string, toolCallId: string, args: unknown, result: unknown };

export type TranscriptEntry =
  | { kind: "user", text: string }
  | { kind: "assistant", text: string, toolCalls: readonly TranscriptToolCall[] }
  | { kind: "tool", text: string }
  | { kind: "note", label: string, text: string }
  | { kind: "divider", label: string };

/**
 * An agent trace rendered as a vertical timeline (user → tool calls → answer), the layout most AI
 * observability tools use. One component renders every trace in the console: MCP conversations,
 * the QA reviewer's own loop and Unified AI requests, distinguished only by `actor` labels.
 */
export function Transcript({ entries, assistantLabel = "Assistant", emptyLabel = "Nothing recorded." }: {
  entries: readonly TranscriptEntry[],
  assistantLabel?: string,
  emptyLabel?: string,
}) {
  if (entries.length === 0) return <p className="py-6 text-center text-xs text-muted-foreground">{emptyLabel}</p>;
  return (
    <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-border">
      {entries.map((entry, index) => {
        switch (entry.kind) {
          case "divider": {
            return (
              <li key={index} className="relative flex items-center gap-3 py-1 pl-8">
                <span className="text-[11px] font-medium text-muted-foreground">{entry.label}</span>
                <span className="h-px flex-1 bg-border" />
              </li>
            );
          }
          case "note": {
            return (
              <li key={index} className="relative pl-8">
                <p className="text-[11px] font-medium text-muted-foreground">{entry.label}</p>
                <p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{entry.text}</p>
              </li>
            );
          }
          case "user": {
            return (
              <TimelineItem key={index} avatar="U" avatarClass="bg-blue-500/15 text-blue-700 dark:text-blue-300" actor="User">
                <div className="rounded-lg border border-blue-500/15 bg-blue-500/[0.05] px-3 py-2 text-[13px] leading-6 text-foreground">
                  <p className="whitespace-pre-wrap break-words">{entry.text}</p>
                </div>
              </TimelineItem>
            );
          }
          case "tool": {
            return (
              <TimelineItem key={index} avatar="T" avatarClass="bg-muted text-muted-foreground" actor="Tool message">
                <pre className="hx-scroll max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted px-3 py-2 font-mono text-[11px] text-muted-foreground">{entry.text}</pre>
              </TimelineItem>
            );
          }
          case "assistant": {
            return (
              <TimelineItem key={index} avatar="AI" avatarClass="bg-violet-500/15 text-violet-700 dark:text-violet-300" actor={assistantLabel}>
                <div className="space-y-2">
                  {entry.toolCalls.map((call, callIndex) => <ToolCallBlock key={call.toolCallId === "" ? callIndex : call.toolCallId} call={call} />)}
                  {entry.text !== "" && (
                    <div className="min-w-0 rounded-lg border border-border bg-card px-3 py-2">
                      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{entry.text}</Markdown>
                    </div>
                  )}
                </div>
              </TimelineItem>
            );
          }
        }
      })}
    </ol>
  );
}

function TimelineItem({ avatar, avatarClass, actor, children }: { avatar: string, avatarClass: string, actor: string, children: ReactNode }) {
  return (
    <li className="relative pl-8">
      <span className={cn("absolute left-0 top-0 grid size-6 place-items-center rounded-full text-[9px] font-bold ring-4 ring-card", avatarClass)}>{avatar}</span>
      <p className="mb-1 text-[11px] font-medium leading-6 text-muted-foreground">{actor}</p>
      {children}
    </li>
  );
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  // JSON.stringify returns undefined (despite its typing) for undefined, functions and symbols.
  if (value === undefined) return "undefined";
  return JSON.stringify(value, null, 2);
}

function ToolCallBlock({ call }: { call: TranscriptToolCall }) {
  const [open, setOpen] = useState(false);
  const failed = typeof call.result === "object" && call.result != null
    && (("success" in call.result && call.result.success === false) || ("error" in call.result && typeof call.result.error === "string"));
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/40">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(previous => !previous)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted hover:transition-none"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size="xs" className="text-muted-foreground" />
        <Icon name="terminal" size="sm" className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">{call.toolName}</span>
        {failed && <Badge tone="red">failed</Badge>}
      </button>
      {open && (
        <div className="space-y-2 border-t border-border p-2.5">
          <CodePane label="Arguments" text={stringify(call.args)} />
          <CodePane label="Result" text={stringify(call.result)} />
        </div>
      )}
    </div>
  );
}

function CodePane({ label, text }: { label: string, text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={() => runAsynchronouslyWithAlert(navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }))}
          className="rounded px-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground hover:transition-none"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="hx-scroll max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-card px-2.5 py-2 font-mono text-[11px] leading-[1.6] text-muted-foreground">
        {text}
      </pre>
    </div>
  );
}
