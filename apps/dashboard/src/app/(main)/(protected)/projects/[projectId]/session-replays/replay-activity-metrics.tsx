"use client";

import { SimpleTooltip } from "@/components/ui";
import { ClockIcon, CursorClickIcon, KeyboardIcon, ListBulletsIcon } from "@phosphor-icons/react";
import { formatReplayCount, formatReplayDuration } from "./replay-list-formatting";

export function ReplayActivityMetrics({
  durationMs,
  eventCount,
  clickCount,
  keystrokeCount,
  onActivate,
}: {
  durationMs: number,
  eventCount: number,
  clickCount: number,
  keystrokeCount: number,
  onActivate?: () => void,
}) {
  const metrics = [
    {
      label: "Replay duration",
      value: formatReplayDuration(durationMs),
      exactValue: formatReplayDuration(durationMs),
      icon: ClockIcon,
    },
    {
      label: "Recorded events",
      value: formatReplayCount(eventCount),
      exactValue: eventCount.toLocaleString(),
      icon: ListBulletsIcon,
    },
    {
      label: "Recorded clicks",
      value: formatReplayCount(clickCount),
      exactValue: clickCount.toLocaleString(),
      icon: CursorClickIcon,
    },
    {
      label: "Recorded keystrokes",
      value: formatReplayCount(keystrokeCount),
      exactValue: keystrokeCount.toLocaleString(),
      icon: KeyboardIcon,
    },
  ];

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] tabular-nums text-muted-foreground"
      aria-label="Replay activity"
      onClick={onActivate}
    >
      {metrics.map((metric) => {
        const Icon = metric.icon;
        return (
          <SimpleTooltip
            key={metric.label}
            tooltip={`${metric.label}: ${metric.exactValue}`}
            inline
            className="inline-flex items-center gap-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-foreground/20"
          >
            <Icon className="size-3.5" aria-hidden="true" />
            <span>{metric.value}</span>
          </SimpleTooltip>
        );
      })}
    </div>
  );
}
