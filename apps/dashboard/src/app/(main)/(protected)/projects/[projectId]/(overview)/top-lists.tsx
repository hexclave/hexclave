'use client';

import { DesignAnalyticsCard, useInfiniteListWindow } from "@/components/design-components";
import { CountryFlag, getReferrerHost, ReferrerFavicon, regionName } from "@/components/geo-referrer";
import { Link } from "@/components/link";
import { SimpleTooltip, Typography } from "@/components/ui";
import { type AppId } from "@/lib/apps-frontend";
import { type MetricsNamedCount, type MetricsTopReferrer } from "@/lib/hexclave-app-internals";
import { GlobeIcon } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { useEffect, useMemo, useRef, useState } from "react";
import { easeOutCubic, prefersReducedMotion } from "./animation-utils";

const TOP_LIST_ANIMATION_MS = 260;

function useAnimatedBarValues(rows: Array<{ id: string, value: number }>): Map<string, number> {
  const [animatedValues, setAnimatedValues] = useState(() => new Map(rows.map((row) => [row.id, row.value])));
  const previousValuesRef = useRef(animatedValues);

  useEffect(() => {
    const nextValues = new Map(rows.map((row) => [row.id, row.value]));
    if (prefersReducedMotion()) {
      previousValuesRef.current = nextValues;
      setAnimatedValues(nextValues);
      return;
    }

    const previousValues = previousValuesRef.current;
    const startedAt = performance.now();
    let frameId: number | null = null;

    const renderFrame = (now: number) => {
      const linearProgress = Math.min(1, (now - startedAt) / TOP_LIST_ANIMATION_MS);
      const progress = easeOutCubic(linearProgress);
      setAnimatedValues(new Map(rows.map((row) => {
        const previous = previousValues.get(row.id) ?? 0;
        return [row.id, previous + (row.value - previous) * progress];
      })));

      if (linearProgress < 1) {
        frameId = requestAnimationFrame(renderFrame);
        return;
      }

      previousValuesRef.current = nextValues;
      setAnimatedValues(nextValues);
    };

    frameId = requestAnimationFrame(renderFrame);
    return () => {
      if (frameId != null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [rows]);

  return animatedValues;
}

function SetupAppPromptInline({
  projectId,
  appId,
  appLabel,
  metricLabel,
}: {
  projectId: string,
  appId: AppId,
  appLabel: string,
  metricLabel: string,
}) {
  return (
    <div className="flex h-full min-h-0 w-full items-center justify-center px-4 py-4">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <Typography variant="secondary" className="text-xs">
          Enable{" "}
          <span className="font-semibold text-foreground">{appLabel}</span>{" "}
          in App Configuration to track {metricLabel}.
        </Typography>
        <Link
          href={`/projects/${projectId}/app-configuration/apps/${appId}`}
          className="inline-flex items-center rounded-md bg-foreground/[0.08] px-3 py-1.5 text-[11px] font-medium text-foreground transition-colors duration-150 hover:bg-foreground/[0.12] hover:transition-none"
        >
          Open App Configuration
        </Link>
      </div>
    </div>
  );
}

export function ReferrersWithAnalyticsCard({
  topReferrers,
  analyticsEnabled,
  projectId,
  onSelectReferrer,
  selectedReferrer,
  headerTooltip,
}: {
  topReferrers: MetricsTopReferrer[],
  analyticsEnabled: boolean,
  projectId: string,
  onSelectReferrer?: (referrer: string) => void,
  selectedReferrer?: string,
  headerTooltip?: string,
}) {
  const listWindow = useInfiniteListWindow(topReferrers.length);
  const referrerBarRows = useMemo(
    () => topReferrers.map((item) => ({ id: item.referrer, value: item.visitors })),
    [topReferrers],
  );
  const animatedVisitorsByReferrer = useAnimatedBarValues(referrerBarRows);
  const max = topReferrers.length > 0 ? topReferrers[0].visitors : 0;

  return (
    <DesignAnalyticsCard gradient="purple" className="h-full" chart={{ type: "none", tooltipType: "none", highlightMode: "none" }}>
      <div className="px-4 py-3 border-b border-foreground/[0.05]">
        <SimpleTooltip tooltip={headerTooltip} inline className="w-fit">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Top Referrers</span>
        </SimpleTooltip>
      </div>
      <div ref={listWindow.scrollRef} className="p-4 pt-3 flex-1 min-h-0 max-h-[320px] overflow-y-auto flex flex-col gap-2">
        {!analyticsEnabled ? (
          <SetupAppPromptInline projectId={projectId} appId="analytics" appLabel="Analytics" metricLabel="referrer metrics" />
        ) : topReferrers.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Typography variant="secondary" className="text-xs">No referrer data</Typography>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {topReferrers.slice(0, listWindow.visibleCount).map((item) => {
              const host = getReferrerHost(item.referrer);
              const clickable = onSelectReferrer != null;
              const isSelected = selectedReferrer === item.referrer;
              const animatedVisitors = animatedVisitorsByReferrer.get(item.referrer) ?? item.visitors;
              return (
                <div
                  key={item.referrer}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onSelectReferrer(item.referrer) : undefined}
                  onKeyDown={clickable ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectReferrer(item.referrer);
                    }
                  } : undefined}
                  className={`relative flex items-center justify-between rounded-lg px-2.5 py-1.5 overflow-hidden ${
                    clickable ? "cursor-pointer transition-colors hover:bg-foreground/[0.04]" : ""
                  } ${isSelected ? "ring-1 ring-purple-500/40" : ""}`}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-lg bg-purple-500/10 dark:bg-purple-400/10"
                    style={{ width: max > 0 ? `${(animatedVisitors / max) * 100}%` : '0%' }}
                  />
                  <span className="relative flex items-center gap-2 min-w-0 max-w-[70%]">
                    {host ? (
                      <ReferrerFavicon host={host} />
                    ) : (
                      <span aria-hidden className="h-4 w-4 shrink-0 rounded-sm bg-foreground/[0.06]" />
                    )}
                    <span className="text-[11px] text-foreground truncate">{item.referrer}</span>
                  </span>
                  <span className="relative text-[11px] font-medium text-foreground tabular-nums">{item.visitors.toLocaleString()}</span>
                </div>
              );
            })}
            {listWindow.hasMore && (
              <div ref={listWindow.sentinelRef} className="py-2 text-center">
                <Typography variant="secondary" className="text-[10px]">
                  Loading more...
                </Typography>
              </div>
            )}
          </div>
        )}
      </div>
    </DesignAnalyticsCard>
  );
}

export function TopRegionsCard({
  usersByCountry,
  onSelectCountry,
  selectedCountry,
  headerTooltip,
}: {
  usersByCountry: Record<string, number>,
  onSelectCountry?: (code: string) => void,
  selectedCountry?: string,
  headerTooltip?: string,
}) {
  const entries = useMemo(
    () => Object.entries(usersByCountry)
      .filter(([code, count]) => code && Number.isFinite(count) && count > 0)
      .map(([code, count]) => ({ code: code.toUpperCase(), count }))
      .sort((a, b) => b.count - a.count || stringCompare(a.code, b.code)),
    [usersByCountry],
  );

  const listWindow = useInfiniteListWindow(entries.length);
  const max = entries.length > 0 ? entries[0].count : 0;
  const regionBarRows = useMemo(
    () => entries.map((item) => ({ id: item.code, value: item.count })),
    [entries],
  );
  const animatedCountsByCode = useAnimatedBarValues(regionBarRows);

  return (
    <DesignAnalyticsCard gradient="blue" className="h-full" chart={{ type: "none", tooltipType: "none", highlightMode: "none" }}>
      <div className="flex items-center gap-2 border-b border-foreground/[0.05] px-4 py-3">
        <GlobeIcon className="h-3.5 w-3.5 text-muted-foreground" weight="fill" />
        <SimpleTooltip tooltip={headerTooltip} inline className="w-fit">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Top Regions</span>
        </SimpleTooltip>
      </div>
      <div ref={listWindow.scrollRef} className="p-4 pt-3 flex-1 min-h-0 max-h-[320px] overflow-y-auto flex flex-col gap-2">
        {entries.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Typography variant="secondary" className="text-xs">No region data</Typography>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {entries.slice(0, listWindow.visibleCount).map((item) => {
              const clickable = onSelectCountry != null;
              const isSelected = selectedCountry === item.code;
              const animatedCount = animatedCountsByCode.get(item.code) ?? item.count;
              return (
                <div
                  key={item.code}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onSelectCountry(item.code) : undefined}
                  onKeyDown={clickable ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectCountry(item.code);
                    }
                  } : undefined}
                  className={`relative flex items-center justify-between rounded-lg px-2.5 py-1.5 overflow-hidden ${
                    clickable ? "cursor-pointer transition-colors hover:bg-foreground/[0.04]" : ""
                  } ${isSelected ? "ring-1 ring-blue-500/40" : ""}`}
                >
                  <div
                    className="absolute inset-y-0 left-0 rounded-lg bg-blue-500/10 dark:bg-blue-400/10"
                    style={{ width: max > 0 ? `${(animatedCount / max) * 100}%` : '0%' }}
                  />
                  <span className="relative flex items-center gap-2 min-w-0 max-w-[70%]">
                    <CountryFlag code={item.code} />
                    <span className="text-[11px] text-foreground truncate">{regionName(item.code)}</span>
                  </span>
                  <span className="relative text-[11px] font-medium text-foreground tabular-nums">{item.count.toLocaleString()}</span>
                </div>
              );
            })}
            {listWindow.hasMore && (
              <div ref={listWindow.sentinelRef} className="py-2 text-center">
                <Typography variant="secondary" className="text-[10px]">
                  Loading more...
                </Typography>
              </div>
            )}
          </div>
        )}
      </div>
    </DesignAnalyticsCard>
  );
}

// Generic top-N named-count card. Reused for Browsers / Operating Systems /
// Devices on the analytics overview so the three breakdowns share the same
// row layout, bar tint, and empty-state behavior as the referrer card.
export function TopNamedListCard({
  title,
  items,
  gradient,
  barClassName,
  Icon: HeaderIcon,
  emptyLabel,
  getRowIcon,
  onSelectItem,
  selectedItem,
  headerTooltip,
}: {
  title: string,
  items: MetricsNamedCount[],
  gradient: "purple" | "blue" | "cyan" | "green" | "orange" | "slate",
  barClassName: string,
  Icon: Icon,
  emptyLabel: string,
  getRowIcon?: (name: string) => React.ReactNode,
  onSelectItem?: (name: string) => void,
  selectedItem?: string,
  headerTooltip?: string,
}) {
  const listWindow = useInfiniteListWindow(items.length);
  const max = items.length > 0 ? items[0].visitors : 0;
  const namedBarRows = useMemo(
    () => items.map((item) => ({ id: item.name, value: item.visitors })),
    [items],
  );
  const animatedVisitorsByName = useAnimatedBarValues(namedBarRows);

  return (
    <DesignAnalyticsCard gradient={gradient} className="h-full" chart={{ type: "none", tooltipType: "none", highlightMode: "none" }}>
      <div className="flex items-center gap-2 border-b border-foreground/[0.05] px-4 py-3">
        <HeaderIcon className="h-3.5 w-3.5 text-muted-foreground" weight="fill" />
        <SimpleTooltip tooltip={headerTooltip} inline className="w-fit">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{title}</span>
        </SimpleTooltip>
      </div>
      <div ref={listWindow.scrollRef} className="p-4 pt-3 flex-1 min-h-0 max-h-[320px] overflow-y-auto flex flex-col gap-2">
        {items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <Typography variant="secondary" className="text-xs">{emptyLabel}</Typography>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {items.slice(0, listWindow.visibleCount).map((item) => {
              const clickable = onSelectItem != null;
              const isSelected = selectedItem === item.name;
              const animatedVisitors = animatedVisitorsByName.get(item.name) ?? item.visitors;
              return (
                <div
                  key={item.name}
                  role={clickable ? "button" : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => onSelectItem(item.name) : undefined}
                  onKeyDown={clickable ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectItem(item.name);
                    }
                  } : undefined}
                  className={`relative flex items-center justify-between rounded-lg px-2.5 py-1.5 overflow-hidden ${
                    clickable ? "cursor-pointer transition-colors hover:bg-foreground/[0.04]" : ""
                  } ${isSelected ? "ring-1 ring-foreground/30" : ""}`}
                >
                  <div
                    className={`absolute inset-y-0 left-0 rounded-lg ${barClassName}`}
                    style={{ width: max > 0 ? `${(animatedVisitors / max) * 100}%` : '0%' }}
                  />
                  <span className="relative flex items-center gap-2 min-w-0 max-w-[70%]">
                    {getRowIcon?.(item.name)}
                    <span className="text-[11px] text-foreground truncate">{item.name}</span>
                  </span>
                  <span className="relative text-[11px] font-medium text-foreground tabular-nums">{item.visitors.toLocaleString()}</span>
                </div>
              );
            })}
            {listWindow.hasMore && (
              <div ref={listWindow.sentinelRef} className="py-2 text-center">
                <Typography variant="secondary" className="text-[10px]">
                  Loading more...
                </Typography>
              </div>
            )}
          </div>
        )}
      </div>
    </DesignAnalyticsCard>
  );
}
