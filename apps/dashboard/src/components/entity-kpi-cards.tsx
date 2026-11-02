"use client";

import { Skeleton } from "@/components/ui";
import type { MetricsEntityKpis } from "@/lib/hexclave-app-internals";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import { UserPageMetricCard } from "../app/(main)/(protected)/projects/[projectId]/users/[userId]/user-page-metric-card";

export type EntityKpiLabels = {
  newCard: { label: string, comparisonLabel: string },
  activeCard: { label: string, comparisonLabel: string },
  returningCard: { label: string },
  totalCard: { label: string, comparisonLabel: string },
};

type EntityKpiCardsProps = {
  /** Used as the captureError tag for the React error-boundary. */
  errorTag: string,
  labels: EntityKpiLabels,
  /** `null` while loading; the cards render a skeleton. */
  kpis: MetricsEntityKpis | null,
  /** Set when loading the KPIs failed; the cards are hidden. */
  error?: unknown,
};

const capturedKpiErrors = new WeakMap<Error, Set<string>>();

function captureKpiErrorOnce(error: Error, tag: string) {
  let tags = capturedKpiErrors.get(error);
  if (!tags) {
    tags = new Set();
    capturedKpiErrors.set(error, tags);
  }
  if (tags.has(tag)) return;
  tags.add(tag);
  captureError(tag, error);
}

function sumLast(arr: number[], n: number): number {
  let total = 0;
  for (const x of arr.slice(-n)) total += x;
  return total;
}

function formatCompact(n: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

function KpiGrid(props: {
  kpis: MetricsEntityKpis,
  labels: EntityKpiLabels,
}) {
  const { kpis, labels } = props;
  const dailyNew = kpis.daily_new.map((p) => p.activity);
  const splitTotal = kpis.daily_active_split.total.map((p) => p.activity);
  const splitNew = kpis.daily_active_split.new.map((p) => p.activity);
  const totalCount = kpis.total;

  const new7 = sumLast(dailyNew, 7);
  const newPrev7 = sumLast(dailyNew.slice(0, -7), 7);
  const newSpark = dailyNew.slice(-14);

  const activeToday = splitTotal[splitTotal.length - 1] ?? 0;
  const activePrev7Avg = (() => {
    const prev = splitTotal.slice(-8, -1);
    if (prev.length === 0) return 0;
    return prev.reduce((a, b) => a + b, 0) / prev.length;
  })();
  const activeSpark = splitTotal.slice(-14);

  const last7Total = sumLast(splitTotal, 7);
  const last7New = sumLast(splitNew, 7);
  const prev7Total = sumLast(splitTotal.slice(0, -7), 7);
  const prev7New = sumLast(splitNew.slice(0, -7), 7);
  const returningRate = last7Total > 0 ? ((last7Total - last7New) / last7Total) * 100 : 0;
  const returningRatePrev = prev7Total > 0 ? ((prev7Total - prev7New) / prev7Total) * 100 : 0;
  const returningSpark = splitTotal.slice(-14).map((total, i) => {
    const newCount = splitNew.slice(-14)[i] ?? 0;
    return total > 0 ? ((total - newCount) / total) * 100 : 0;
  });

  const totalPrev = Math.max(0, totalCount - new7);
  const totalSpark = (() => {
    const last14New = dailyNew.slice(-14);
    if (last14New.length === 0) return [];
    const out = new Array<number>(last14New.length);
    out[last14New.length - 1] = totalCount;
    for (let i = last14New.length - 2; i >= 0; i -= 1) {
      out[i] = Math.max(0, out[i + 1] - last14New[i + 1]);
    }
    return out;
  })();

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <UserPageMetricCard
        label={labels.newCard.label}
        value={formatCompact(new7)}
        description="last 7 days"
        gradient="blue"
        delta={{ current: new7, previous: newPrev7, comparisonLabel: labels.newCard.comparisonLabel }}
        spark={{ values: newSpark }}
      />
      <UserPageMetricCard
        label={labels.activeCard.label}
        value={formatCompact(activeToday)}
        description="today vs 7d avg"
        gradient="green"
        delta={{
          current: activeToday,
          previous: Math.round(activePrev7Avg),
          comparisonLabel: labels.activeCard.comparisonLabel,
        }}
        spark={{ values: activeSpark }}
      />
      <UserPageMetricCard
        label={labels.returningCard.label}
        value={`${returningRate.toFixed(0)}%`}
        description="last 7 days"
        gradient="purple"
        delta={{
          current: Math.round(returningRate),
          previous: Math.round(returningRatePrev),
          comparisonLabel: "% returning",
        }}
        spark={{ values: returningSpark }}
      />
      <UserPageMetricCard
        label={labels.totalCard.label}
        value={formatCompact(totalCount)}
        description="this week"
        gradient="orange"
        delta={{ current: totalCount, previous: totalPrev, comparisonLabel: labels.totalCard.comparisonLabel }}
        spark={{ values: totalSpark }}
      />
    </div>
  );
}

function KpiSkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-[88px] w-full rounded-xl" />
      ))}
    </div>
  );
}

export function EntityKpiCards({ errorTag, labels, kpis, error }: EntityKpiCardsProps) {
  const ErrorComponent = ({ error }: { error: unknown }) => {
    if (error instanceof Error) {
      captureKpiErrorOnce(error, errorTag);
    }
    return null;
  };
  if (error != null) {
    return <ErrorComponent error={error} />;
  }
  return (
    <ErrorBoundary errorComponent={ErrorComponent}>
      {kpis != null ? (
        <KpiGrid kpis={kpis} labels={labels} />
      ) : (
        <KpiSkeletonGrid />
      )}
    </ErrorBoundary>
  );
}
