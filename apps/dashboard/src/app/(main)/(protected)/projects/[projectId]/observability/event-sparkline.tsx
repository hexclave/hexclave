"use client";

import { cn } from "@/lib/utils";
import { useMemo } from "react";


export type EventSparklineBucket = {
  key: string | number,
  value: number,
  highlighted?: boolean,
};

export type EventSparklineTone = "neutral" | "error";

type ToneClasses = { base: string, highlighted: string };

const TONE_CLASSES = new Map<EventSparklineTone, ToneClasses>([
  ["neutral", { base: "bg-foreground/25", highlighted: "bg-red-500/80" }],
  ["error", { base: "bg-red-500/45", highlighted: "bg-red-500/85" }],
]);

function getToneClasses(tone: EventSparklineTone): ToneClasses {
  const classes = TONE_CLASSES.get(tone);
  if (classes == null) throw new Error(`Missing sparkline tone classes for "${tone}"`);
  return classes;
}

function SparklineHairline({ className, label }: { className?: string, label: string | null }) {
  return (
    <div
      className={cn("flex h-6 items-center", className)}
      {...(label == null ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    >
      <span className="h-px w-full bg-foreground/10" />
    </div>
  );
}

export function EventSparkline({
  buckets,
  ariaLabel,
  tone = "neutral",
  pending = false,
  className,
}: {
  buckets: readonly EventSparklineBucket[],
  ariaLabel: string,
  tone?: EventSparklineTone,
  pending?: boolean,
  className?: string,
}) {
  const maximum = useMemo(
    () => Math.max(0, ...buckets.map((bucket) => bucket.value)),
    [buckets],
  );
  const toneClasses = getToneClasses(tone);

  if (pending) return <SparklineHairline className={className} label="Loading activity" />;
  if (buckets.length === 0) return <SparklineHairline className={className} label={ariaLabel} />;

  return (
    <div className={cn("flex h-6 items-end gap-px", className)} role="img" aria-label={ariaLabel}>
      {buckets.map((bucket) => {
        const heightPercent = maximum === 0 || bucket.value === 0
          ? 0
          : Math.max(12, (bucket.value / maximum) * 100);
        return (
          <span key={bucket.key} className="flex h-full min-w-0 flex-1 items-end">
            {heightPercent === 0 ? (
              <span className="block h-px w-full rounded-full bg-foreground/10" aria-hidden="true" />
            ) : (
              <span
                className={cn(
                  "block w-full rounded-t-[1px]",
                  bucket.highlighted === true ? toneClasses.highlighted : toneClasses.base,
                )}
                style={{ height: `${heightPercent}%` }}
                aria-hidden="true"
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
