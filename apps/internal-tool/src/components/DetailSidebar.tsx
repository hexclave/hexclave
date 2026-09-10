"use client";

import type { ReactNode } from "react";
import { DEFAULT_DETAIL_SIDEBAR_WIDTH, MAX_DETAIL_SIDEBAR_WIDTH, MIN_DETAIL_SIDEBAR_WIDTH, normalizeDetailSidebarWidth } from "../lib/sidebar-size";
import { Resizer, cn, useResizableWidth } from "./design";

// All three detail panes (MCP call, AI usage, feedback) share one persisted width: they show the same
// kind of content at the same place on screen, so a reviewer who widens one expects the others to
// follow rather than having to drag again per tab.
const DETAIL_SIDEBAR_WIDTH_STORAGE_KEY = "internal-tool-detail-sidebar-width";

export function DetailSidebar({ children, onClose, label }: { children: ReactNode, onClose: () => void, label: string }) {
  const { width, isResizing, resizerProps } = useResizableWidth({
    label,
    storageKey: DETAIL_SIDEBAR_WIDTH_STORAGE_KEY,
    defaultWidth: DEFAULT_DETAIL_SIDEBAR_WIDTH,
    minWidth: MIN_DETAIL_SIDEBAR_WIDTH,
    maxWidth: MAX_DETAIL_SIDEBAR_WIDTH,
    normalize: normalizeDetailSidebarWidth,
    edge: "left",
  });

  return (
    <>
      <button
        type="button"
        aria-label={`Close ${label}`}
        onClick={onClose}
        className="absolute inset-0 z-20 bg-background/70 backdrop-blur-sm lg:hidden"
      />
      <aside
        aria-label={label}
        // Below `lg` the pane is an overlay sized to the viewport, so the persisted desktop width is
        // overridden there rather than letting a wide drag push it off screen.
        style={{ width }}
        className={cn(
          "absolute inset-y-0 right-0 z-30 flex shrink-0 flex-col border-l border-black/[0.08] bg-background shadow-[-8px_0_24px_hsl(var(--foreground)/0.08)] dark:border-white/[0.08] lg:relative lg:shadow-none",
          "max-lg:!w-[min(34rem,calc(100%_-_1rem))]",
          isResizing && "select-none",
        )}
      >
        {/* The scroll container is nested rather than being the <aside> itself so the resize handle,
            which hangs just past the left border, is neither clipped nor scrolled away with content. */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        <Resizer {...resizerProps} />
      </aside>
    </>
  );
}
