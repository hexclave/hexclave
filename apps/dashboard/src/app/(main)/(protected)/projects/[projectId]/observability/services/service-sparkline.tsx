"use client";

import { useMemo } from "react";
import { EventSparkline } from "../event-sparkline";
import type { ServiceTimelineBucket } from "./services-data";

export function ServiceSparkline({
  buckets,
  bucketLabel,
  className,
}: {
  buckets: readonly ServiceTimelineBucket[],
  bucketLabel: string,
  className?: string,
}) {
  const sparklineBuckets = useMemo(
    () => buckets.map((bucket) => ({
      key: bucket.bucketMs,
      value: bucket.requestCount,
      highlighted: bucket.errorCount > 0,
    })),
    [buckets],
  );
  const totals = useMemo(() => buckets.reduce(
    (accumulator, bucket) => ({
      requests: accumulator.requests + bucket.requestCount,
      errors: accumulator.errors + bucket.errorCount,
    }),
    { requests: 0, errors: 0 },
  ), [buckets]);

  return (
    <EventSparkline
      buckets={sparklineBuckets}
      ariaLabel={`${totals.requests.toLocaleString()} requests and ${totals.errors.toLocaleString()} errors, ${bucketLabel}`}
      className={className}
    />
  );
}
