"use client";

import { cn } from "@/components/ui";
import { type ToolCallContentPartProps } from "@assistant-ui/react";
import { CaretDownIcon, DatabaseIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

type ToolResult = {
  success?: boolean,
  result?: unknown[],
  error?: string,
  rowCount?: number,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readToolResult(value: unknown): ToolResult | undefined {
  if (!isRecord(value)) return undefined;
  if ("success" in value && value.success !== undefined && typeof value.success !== "boolean") return undefined;
  if ("result" in value && value.result !== undefined && !Array.isArray(value.result)) return undefined;
  if ("error" in value && value.error !== undefined && typeof value.error !== "string") return undefined;
  if ("rowCount" in value && value.rowCount !== undefined && typeof value.rowCount !== "number") return undefined;
  return {
    success: typeof value.success === "boolean" ? value.success : undefined,
    result: Array.isArray(value.result) ? value.result : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
    rowCount: typeof value.rowCount === "number" ? value.rowCount : undefined,
  };
}

function readErrorMessage(value: unknown): string | undefined {
  return isRecord(value) && typeof value.message === "string" ? value.message : undefined;
}

function readQueryArg(value: unknown): string | undefined {
  return isRecord(value) && typeof value.query === "string" ? value.query : undefined;
}

/**
 * Shared assistant-ui tool fallback. Renders a collapsible card for any
 * tool call streamed from the unified AI endpoint (sql-query, docs, etc.).
 */
export function ToolFallback({
  toolName,
  args,
  result,
  status,
  argsText,
  headerAction,
}: ToolCallContentPartProps & { headerAction?: ReactNode }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isRunning = status.type === "running" || status.type === "requires-action";
  const isComplete = status.type === "complete";
  const isIncomplete = status.type === "incomplete";

  const typed = readToolResult(result);
  const hasOutput = typed !== undefined;
  const isSuccess = hasOutput && typed.success !== false && !isIncomplete;
  const errorMessage = hasOutput && typed.success === false
    ? typed.error
    : isIncomplete
      ? readErrorMessage(status.error)
      : undefined;

  const label = toolName === "queryAnalytics"
    ? "Analytics Query"
    : toolName === "readBranchConfig"
      ? "Project Config"
      : toolName;
  const queryArg = readQueryArg(args) ?? (argsText ? argsText : undefined);

  return (
    <div
      className={cn(
        "my-2 rounded-lg overflow-hidden transition-all duration-200 ease-out",
        "bg-foreground/[0.03] ring-1 ring-foreground/[0.08]",
        isExpanded && "ring-purple-500/20",
      )}
    >
      <button
        type="button"
        onClick={() => setIsExpanded(prev => !prev)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-left",
          "hover:bg-foreground/[0.02] transition-colors",
        )}
      >
        <DatabaseIcon className="h-3.5 w-3.5 text-purple-400 shrink-0" />
        <span className="text-[12px] font-medium text-foreground/80 flex-1">{label}</span>
        {isRunning ? (
          <SpinnerGapIcon className="h-3 w-3 text-purple-400 animate-spin shrink-0" />
        ) : isComplete && isSuccess && typed.rowCount !== undefined ? (
          <span className="text-[10px] text-green-400/80 shrink-0">
            {typed.rowCount} {typed.rowCount === 1 ? "row" : "rows"}
          </span>
        ) : !isSuccess && (isIncomplete || hasOutput) ? (
          <span className="text-[10px] text-red-400/80 shrink-0">Error</span>
        ) : null}
        {headerAction ? (
          <span className="flex shrink-0 items-center">
            {headerAction}
          </span>
        ) : null}
        <div className={cn("flex shrink-0 items-center transition-transform duration-200", !isExpanded && "-rotate-90")}>
          <CaretDownIcon className="h-3 w-3 text-muted-foreground/50" />
        </div>
      </button>

      <div
        className={cn(
          "grid transition-all duration-200 ease-out",
          isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3 pt-1 space-y-2 border-t border-foreground/[0.06]">
            {queryArg && (
              <div>
                <span className="text-[9px] font-medium text-muted-foreground/60 uppercase tracking-wider">
                  Query
                </span>
                <pre className="mt-1 text-[10px] font-mono text-foreground/70 bg-foreground/[0.03] rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all">
                  {queryArg}
                </pre>
              </div>
            )}
            {hasOutput && isSuccess && (
              <div>
                <span className="text-[9px] font-medium text-muted-foreground/60 uppercase tracking-wider">Result</span>
                <pre className="mt-1 text-[10px] font-mono text-foreground/70 bg-foreground/[0.03] rounded px-2 py-1.5 overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(typed.result ?? typed, null, 2)}
                </pre>
              </div>
            )}
            {errorMessage && (
              <div>
                <span className="text-[9px] font-medium text-muted-foreground/60 uppercase tracking-wider">Error</span>
                <div className="mt-1 text-[11px] text-red-400/90 bg-red-500/[0.08] rounded px-2 py-1.5">
                  {errorMessage}
                </div>
              </div>
            )}
            {isRunning && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60 py-1">
                <SpinnerGapIcon className="h-3 w-3 animate-spin" />
                <span>Running query...</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
