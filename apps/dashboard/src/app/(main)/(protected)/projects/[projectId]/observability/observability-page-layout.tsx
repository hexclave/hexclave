"use client";

import { useId, type ReactNode } from "react";
import { AnalyticsEventLimitBanner } from "../analytics/shared";
import { PageLayout } from "../page-layout";
import { StickyPageHeader } from "../sticky-page-header";

/**
 * One shape for every page under the observability app (issues, logs, traces,
 * services, performance, registry), matching the overview page: the app shell
 * scrolls, and a title-plus-actions bar morphs into the floating pill on the
 * way. No description line — the pill is the house header, and it carries a
 * title and controls only.
 *
 * The grid pages used to run a second "contained" shape where the page was
 * pinned to the viewport and the data grid scrolled inside itself. That gave
 * those two tabs a nested scrollbar and their own padding rules, which is
 * exactly the inconsistency this layout exists to prevent — unbounded grids now
 * virtualize against the shell scrollport instead (see `DataGrid`'s page-scroll
 * path), so they scroll like every other page.
 */
export type ObservabilityPageLayoutProps = {
  title: string,
  actions?: ReactNode,
  children: ReactNode,
};

export function ObservabilityPageLayout({
  title,
  actions,
  children,
}: ObservabilityPageLayoutProps) {
  const layoutGroupId = useId();

  return (
    <PageLayout fillWidth spacing="compact">
      {/*
        A direct child, exactly like the overview page renders it. Any wrapper
        would become the sticky header's containing block, and one only as tall
        as the header gives `position: sticky` nothing to travel over — the pill
        would scroll away instead of pinning.
      */}
      <StickyPageHeader
        title={title}
        actions={actions ?? null}
        sticky
        layoutGroupId={layoutGroupId}
      />

      {/*
        The whole observability app reads from the analytics event quota, so the
        limit warning belongs to the layout rather than to whichever page
        remembered to opt in.
      */}
      <div data-observability-page-banner className="shrink-0 empty:hidden">
        <AnalyticsEventLimitBanner />
      </div>

      {/*
        `--data-grid-sticky-top` is where a sticky data-grid header parks itself.
        The global value only clears the app's top bar; these pages also have the
        floating header pill above the content, so a grid header parking at the
        global offset would slide underneath it. These values are the pill's own
        sticky offset (4.25rem, 5.75rem in dark) plus its compacted height
        (3.5rem) plus a 0.75rem gap, so the two pinned bands stack.
      */}
      <div
        data-observability-page-body
        className="flex min-w-0 flex-col gap-[var(--page-content-gap)] [--data-grid-sticky-top:8.5rem] dark:[--data-grid-sticky-top:10rem]"
      >
        {children}
      </div>
    </PageLayout>
  );
}
