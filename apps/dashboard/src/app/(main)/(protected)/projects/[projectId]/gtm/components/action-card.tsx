"use client";

import { DesignBadge, type DesignBadgeColor, DesignCard } from "@/components/design-components";
import { Link } from "@/components/link";
import type { GrowthActionItem, GrowthActionStatus, GrowthActionType } from "@/lib/growth/growth-types";
import { ArrowRightIcon, ArticleIcon, LightningIcon, MegaphoneIcon } from "@phosphor-icons/react";
import { useSearchParams } from "next/navigation";
import type { ElementType } from "react";
import { useCallback } from "react";
import { useProjectId } from "../../use-admin-app";
import { getGrowthMetricLabel } from "./metric-comparison-data";

export const GROWTH_ACTION_TYPE_META = new Map<GrowthActionType, { label: string, icon: ElementType }>([
  ["run_ads", { label: "Run ads", icon: MegaphoneIcon }],
  ["publish_blog", { label: "Publish blog", icon: ArticleIcon }],
  ["custom", { label: "Custom", icon: LightningIcon }],
]);

export const GROWTH_ACTION_STATUS_BADGE = new Map<GrowthActionStatus, { label: string, color: DesignBadgeColor }>([
  ["proposed", { label: "Proposed", color: "blue" }],
  ["active", { label: "Active", color: "green" }],
  ["completed", { label: "Completed", color: "purple" }],
  ["dismissed", { label: "Dismissed", color: "orange" }],
]);

/**
 * Returns a function that appends the current query string to an href. Growth's demo mode lives in the
 * query string (`?demo=…&demoPhase=…`) and deeper pages inherit it (see the frame's demo toolbar), so
 * every intra-growth link must carry the params along or a demo click would silently fall back to the
 * default phase.
 */
export function useGrowthHref(): (path: string) => string {
  const searchParams = useSearchParams();
  return useCallback((path: string) => {
    const query = searchParams.toString();
    return query.length === 0 ? path : `${path}?${query}`;
  }, [searchParams]);
}

export function GrowthActionStatusBadge(props: { status: GrowthActionStatus, size?: "sm" | "md" }) {
  const meta = GROWTH_ACTION_STATUS_BADGE.get(props.status) ?? { label: props.status, color: "blue" as const };
  return <DesignBadge label={meta.label} color={meta.color} size={props.size ?? "sm"} />;
}

export function GrowthWatchedMetricChips(props: { action: GrowthActionItem }) {
  if (props.action.watchedMetrics.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {props.action.watchedMetrics.map((metric) => (
        <span
          key={metric.metricId}
          className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.05] px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
        >
          {getGrowthMetricLabel(metric.metricId)}
          <span className="tabular-nums text-muted-foreground/60">· {metric.windowDays}d</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Clickable summary card for one action item in the report's recommended-actions grid. The whole card
 * is one link to the action detail page so the grid stays scannable.
 */
export function GrowthActionCard(props: { action: GrowthActionItem, href?: string, linkLabel?: string }) {
  const { action } = props;
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const typeMeta = GROWTH_ACTION_TYPE_META.get(action.typeId) ?? { label: action.typeId, icon: LightningIcon };
  const TypeIcon = typeMeta.icon;
  return (
    <Link
      href={props.href ?? withQuery(`/projects/${projectId}/gtm/actions/${action.id}`)}
      className="group block h-full rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <DesignCard className="h-full transition-shadow duration-150 hover:shadow-md hover:transition-none">
        <div className="flex h-full flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <TypeIcon className="size-4" />
              {typeMeta.label}
            </span>
            <GrowthActionStatusBadge status={action.status} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="text-sm font-semibold text-foreground">{action.title}</p>
            <p className="line-clamp-3 text-sm text-muted-foreground">{action.description}</p>
          </div>
          <div className="mt-auto flex flex-wrap items-end justify-between gap-3">
            <GrowthWatchedMetricChips action={action} />
            <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-foreground sm:mt-5">{props.linkLabel ?? "Review action"} <ArrowRightIcon className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:transition-none" /></span>
          </div>
        </div>
      </DesignCard>
    </Link>
  );
}
