"use client";

import { DesignAlert, DesignBadge, DesignCard, DesignDialog } from "@/components/design-components";
import { isRecord } from "@hexclave/shared/dist/utils/objects";
import { formatAbsoluteTimeFromMillis, tryParseJson } from "../format";
import { LogLevelChip } from "../log-level";
import { ClockCounterClockwiseIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { LeadingUpToLogLine } from "./correlation";


function parseStructuredLogMessage(message: string): { type: string, value: string } | null {
  const parsed = tryParseJson(message);
  if (!isRecord(parsed)) return null;
  if (typeof parsed.type !== "string" || typeof parsed.value !== "string") return null;
  return { type: parsed.type, value: parsed.value };
}

export function IssueLeadingUpTo({
  lines,
  error,
  subtitle,
  hasCorrelation,
}: {
  lines: readonly LeadingUpToLogLine[] | null,
  error: string | null,
  subtitle?: string,
  hasCorrelation: boolean,
}) {
  const [selection, setSelection] = useState<{ line: LeadingUpToLogLine, lines: readonly LeadingUpToLogLine[] } | null>(null);
  const selectedLine = selection?.lines === lines ? selection.line : null;
  const structuredMessage = selectedLine == null ? null : parseStructuredLogMessage(selectedLine.message);

  return (
    <>
      <DesignCard title="Leading up to this" icon={ClockCounterClockwiseIcon} subtitle={subtitle}>
        {error != null && (
          <DesignAlert variant="warning" title="Couldn't load logs" description="The log excerpt could not be loaded." />
        )}
        {error == null && lines == null && (
          <div className="flex items-center justify-center py-6">
            <SpinnerGapIcon className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading logs" />
          </div>
        )}
        {error == null && lines != null && lines.length === 0 && (
          <div className="py-2 text-xs text-muted-foreground/70">
            {!hasCorrelation
              ? "This occurrence carries no trace, page view, or session id to correlate on."
              : "No log lines in the five minutes before this error."}
          </div>
        )}
        {error == null && lines != null && lines.length > 0 && (
          <ol className="max-h-80 space-y-1.5 overflow-y-auto">
            {lines.map((line, index) => (
              <li key={`${line.eventAtMillis}-${index}`} className="min-w-0">
                <button
                  type="button"
                  className="group flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2 py-1 text-left transition-colors duration-150 hover:transition-none hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={`View log event ${index + 1}`}
                  onClick={() => setSelection({ line, lines })}
                >
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
                    {formatAbsoluteTimeFromMillis(line.eventAtMillis)}
                  </span>
                  <LogLevelChip level={line.level} />
                  <span className="min-w-0 truncate font-mono text-[11px]" title={line.message}>
                    {line.message}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </DesignCard>

      <DesignDialog
        open={selectedLine != null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
        size="lg"
        icon={ClockCounterClockwiseIcon}
        title="Log event"
        description={selectedLine == null ? undefined : formatAbsoluteTimeFromMillis(selectedLine.eventAtMillis)}
      >
        {selectedLine != null && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <LogLevelChip level={selectedLine.level} />
              {selectedLine.serviceName != null && <DesignBadge label={selectedLine.serviceName} color="zinc" size="sm" />}
            </div>
            {structuredMessage != null ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-foreground/[0.06]">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Type</span>
                  <DesignBadge label={structuredMessage.type} color="zinc" size="sm" />
                </div>
                <div>
                  <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Value</div>
                  <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-foreground/[0.03] p-3 font-mono text-xs leading-relaxed ring-1 ring-foreground/[0.06]">
                    {structuredMessage.value === "" ? "No value" : structuredMessage.value}
                  </pre>
                </div>
              </div>
            ) : (
              <div>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Message</div>
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-foreground/[0.03] p-3 font-mono text-xs leading-relaxed ring-1 ring-foreground/[0.06]">
                  {selectedLine.message === "" ? "No message" : selectedLine.message}
                </pre>
              </div>
            )}
          </div>
        )}
      </DesignDialog>
    </>
  );
}
