"use client";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui";

export type StatsBarData = {
  sent: number,
  bounced: number,
  spam: number,
  errors: number,
  cancelled: number,
  inProgress: number,
};

type StatsBarProps = {
  data: StatsBarData,
  className?: string,
};

function buildTooltipLines(data: StatsBarData): { label: string, count: number, color: string }[] {
  return [
    { label: "Sent", count: data.sent, color: "bg-green-500" },
    { label: "Bounced", count: data.bounced, color: "bg-red-400" },
    { label: "Spam", count: data.spam, color: "bg-yellow-400" },
    { label: "Errors", count: data.errors, color: "bg-red-500" },
    { label: "Cancelled", count: data.cancelled, color: "bg-muted-foreground/50" },
    { label: "Pending", count: data.inProgress, color: "bg-gray-400" },
  ].filter(l => l.count > 0);
}

export function StatsBar({ data, className }: StatsBarProps) {
  const total = data.sent + data.bounced + data.spam + data.errors + data.cancelled + data.inProgress;

  if (total === 0) {
    return (
      <div className={cn("w-full", className)}>
        <div className="h-3 w-full rounded bg-gray-200" />
      </div>
    );
  }

  const sentPercent = (data.sent / total) * 100;
  const bouncedPercent = (data.bounced / total) * 100;
  const spamPercent = (data.spam / total) * 100;
  const errorsPercent = (data.errors / total) * 100;
  const cancelledPercent = (data.cancelled / total) * 100;
  const inProgressPercent = (data.inProgress / total) * 100;

  const tooltipLines = buildTooltipLines(data);

  return (
    <div className={cn("w-full", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="h-3 w-full rounded overflow-hidden flex cursor-default">
            {sentPercent > 0 && (
              <div className="bg-green-500 h-full" style={{ width: `${sentPercent}%` }} />
            )}
            {bouncedPercent > 0 && (
              <div
                className="h-full"
                style={{
                  width: `${bouncedPercent}%`,
                  background: "repeating-linear-gradient(45deg, #ef4444, #ef4444 4px, #fca5a5 4px, #fca5a5 8px)",
                }}
              />
            )}
            {spamPercent > 0 && (
              <div className="bg-yellow-400 h-full" style={{ width: `${spamPercent}%` }} />
            )}
            {errorsPercent > 0 && (
              <div className="bg-red-500 h-full" style={{ width: `${errorsPercent}%` }} />
            )}
            {cancelledPercent > 0 && (
              <div className="bg-muted-foreground/50 h-full" style={{ width: `${cancelledPercent}%` }} />
            )}
            {inProgressPercent > 0 && (
              <div className="bg-gray-400 h-full" style={{ width: `${inProgressPercent}%` }} />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          <div className="space-y-1">
            {tooltipLines.map(({ label, count, color }) => (
              <div key={label} className="flex items-center gap-2">
                <span className={cn("w-2 h-2 rounded-full shrink-0", color)} />
                <span>{label}: {count}</span>
              </div>
            ))}
            <div className="text-muted-foreground pt-0.5 border-t border-border/40">Total: {total}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
