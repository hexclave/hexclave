"use client";

import {
  DesignAnalyticsCard,
  DesignAnalyticsCardHeader,
  DesignButton,
} from "@/components/design-components";
import { SpinnerGapIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import {
  type TraceTimeRangeHours,
  type TraceVolumeBucket,
} from "./trace-volume";
import { getBucketGranularity } from "../bucket-granularity";

function formatBucket(bucketMs: number, hours: TraceTimeRangeHours): string {
  const date = new Date(bucketMs);
  if (hours === 1) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  if (hours === 24) {
    return date.toLocaleTimeString([], { hour: "numeric" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function TraceVolumeChart({
  buckets,
  hours,
  loading,
  error,
  onRetry,
}: {
  buckets: TraceVolumeBucket[],
  hours: TraceTimeRangeHours,
  loading: boolean,
  error: string | null,
  onRetry: () => Promise<void>,
}) {
  const granularity = getBucketGranularity(hours);
  const total = useMemo(
    () => buckets.reduce((sum, bucket) => sum + bucket.count, 0),
    [buckets],
  );
  const maximum = useMemo(
    () => Math.max(0, ...buckets.map((bucket) => bucket.count)),
    [buckets],
  );

  return (
    <DesignAnalyticsCard
      gradient="purple"
      className="shrink-0"
      chart={{ type: "bar", tooltipType: "default", highlightMode: "bar-segment" }}
    >
      <DesignAnalyticsCardHeader
        compact
        label="Trace volume"
        right={(
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {total.toLocaleString()} traces · {granularity.label}
          </span>
        )}
      />
      <div className="h-24 px-4 pb-3 pt-2">
        {loading && (
          <div className="flex h-full items-center justify-center" aria-label="Loading trace volume">
            <SpinnerGapIcon className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        )}
        {!loading && error != null && (
          <div className="flex h-full items-center justify-center gap-3">
            <p className="text-xs text-destructive" role="alert">Could not load trace volume.</p>
            <DesignButton size="sm" variant="secondary" onClick={onRetry}>Retry</DesignButton>
          </div>
        )}
        {!loading && error == null && buckets.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No trace volume is available for this time range.
          </div>
        )}
        {!loading && error == null && buckets.length > 0 && (
          <div
            className="flex h-full min-w-0 flex-col"
            role="img"
            aria-label={`${total.toLocaleString()} traces, ${granularity.label}`}
          >
            <ol className="flex min-h-0 flex-1 items-end gap-px" aria-label="Trace counts by time bucket">
              {buckets.map((bucket) => {
                const label = formatBucket(bucket.bucketMs, hours);
                const height = maximum === 0
                  ? 0
                  : Math.max(6, (bucket.count / maximum) * 100);
                return (
                  <li
                    key={bucket.bucketMs}
                    className="group flex h-full min-w-0 flex-1 items-end"
                    aria-label={`${label}: ${bucket.count.toLocaleString()} ${bucket.count === 1 ? "trace" : "traces"}`}
                    title={`${label} · ${bucket.count.toLocaleString()} ${bucket.count === 1 ? "trace" : "traces"}`}
                  >
                    <span
                      className="block w-full rounded-t-[2px] bg-primary/65 transition-colors duration-150 group-hover:bg-primary group-hover:transition-none"
                      style={{ height: `${height}%` }}
                      aria-hidden="true"
                    />
                  </li>
                );
              })}
            </ol>
            <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
              <span>{formatBucket(buckets[0]?.bucketMs ?? 0, hours)}</span>
              <span>{formatBucket(buckets.at(-1)?.bucketMs ?? 0, hours)}</span>
            </div>
          </div>
        )}
      </div>
    </DesignAnalyticsCard>
  );
}
