"use client";

import { cn, Typography } from "@/components/ui";
import { LayoutGroup, motion, useReducedMotion, type Transition } from "motion/react";
import { useCallback, useEffect, useState, type MutableRefObject, type ReactNode, type Ref } from "react";


const STICKY_HEADER_COMPACT_SCROLL_TOP = 24;
const STICKY_HEADER_MORPH_MS = 520;
const STICKY_HEADER_TITLE_EXIT_MS = 150;
const stickyHeaderLayoutTransition: Transition = {
  duration: STICKY_HEADER_MORPH_MS / 1000,
  ease: [0.32, 0.72, 0, 1],
};
const reducedStickyHeaderLayoutTransition: Transition = {
  duration: 0,
};

const scrollableOverflowValues = new Set(["auto", "scroll", "overlay"]);

/**
 * Deliberately does not check `scrollHeight > clientHeight`: the container is
 * resolved once, on mount, and most pages have not loaded their data yet at
 * that point — so a "is it currently scrollable" test picks nothing, and the
 * header then watches the window (which never scrolls here) and never compacts.
 * Overflow alone is stable from first paint.
 */
function findScrollContainer(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current != null) {
    const overflowY = window.getComputedStyle(current).overflowY;
    if (scrollableOverflowValues.has(overflowY)) return current;
    current = current.parentElement;
  }

  return null;
}

/**
 * Reads the scroll offset directly instead of watching a sentinel element.
 *
 * The sentinel used to be a 1px node rendered above the header and pulled back
 * out of the layout with a negative margin. That forced the header to be wrapped
 * in a container (so the two stayed together), and a wrapper only as tall as the
 * header gives `position: sticky` a zero-length range — the pill scrolled away
 * instead of sticking. The scroll offset is what we actually care about, so read
 * it and let the header stand alone.
 */
function useStickyHeaderCompacted(
  enabled: boolean,
  scrollContainer: "shell" | "main",
  headerElement: HTMLDivElement | null,
) {
  const [compacted, setCompacted] = useState(false);

  useEffect(() => {
    if (!enabled || headerElement == null) {
      setCompacted(false);
      return;
    }

    const scrollRoot = scrollContainer === "main"
      ? headerElement.closest("main")
      : findScrollContainer(headerElement);
    const scrollTarget: HTMLElement | Window = scrollRoot ?? window;

    const read = () => {
      const scrollTop = scrollRoot?.scrollTop ?? window.scrollY;
      const next = scrollTop > STICKY_HEADER_COMPACT_SCROLL_TOP;
      setCompacted((current) => current === next ? current : next);
    };

    read();
    scrollTarget.addEventListener("scroll", read, { passive: true });
    return () => {
      scrollTarget.removeEventListener("scroll", read);
    };
  }, [enabled, scrollContainer, headerElement]);

  return compacted;
}

function useRenderWhileClosing(open: boolean, durationMs: number): boolean {
  const [shouldRender, setShouldRender] = useState(open);

  useEffect(() => {
    if (open) {
      setShouldRender(true);
      return;
    }

    const timeout = setTimeout(() => setShouldRender(false), durationMs);
    return () => clearTimeout(timeout);
  }, [durationMs, open]);

  return open || shouldRender;
}

function useDelayedTrue(value: boolean, delayMs: number): boolean {
  const [delayedValue, setDelayedValue] = useState(value);

  useEffect(() => {
    if (!value) {
      setDelayedValue(false);
      return;
    }

    const timeout = setTimeout(() => setDelayedValue(true), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs, value]);

  return delayedValue;
}

function StickyHeaderChrome({
  title,
  description,
  actions,
  compacted,
  layoutCompacted,
  renderTitle,
  layoutTransition,
  animateLayout,
}: {
  title: string,
  description?: ReactNode,
  actions: ReactNode,
  compacted: boolean,
  layoutCompacted: boolean,
  renderTitle: boolean,
  layoutTransition: Transition,
  animateLayout: boolean,
}) {
  return (
    <motion.div
      layout={animateLayout}
      transition={layoutTransition}
      className={cn(
        "pointer-events-auto relative w-full max-w-full",
        layoutCompacted && "ml-auto w-fit",
      )}
    >
      <motion.div
        layout={animateLayout}
        transition={layoutTransition}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-0 rounded-2xl border border-black/[0.06] bg-white/90 shadow-[0_2px_12px_rgba(0,0,0,0.04)] backdrop-blur-xl will-change-transform transition-[background-color,border-color,box-shadow,opacity] [transition-duration:520ms] [transition-timing-function:cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none dark:border-0 dark:bg-transparent dark:shadow-none dark:backdrop-blur-none",
          layoutCompacted && "rounded-xl border-black/[0.08] bg-white/[0.78] shadow-[0_14px_34px_rgba(15,23,42,0.14)] ring-1 ring-white/[0.55] dark:border-white/[0.08] dark:bg-background/[0.72] dark:shadow-[0_14px_34px_rgba(0,0,0,0.26)] dark:ring-white/[0.08] dark:backdrop-blur-xl",
        )}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-5 top-0 z-10 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent opacity-0 transition-opacity [transition-duration:520ms] motion-reduce:transition-none dark:via-white/20",
          layoutCompacted && "opacity-100",
        )}
      />
      <div
        className={cn(
          "relative z-10 flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5 sm:py-4 dark:px-0 dark:py-0 dark:sm:px-0 dark:sm:py-0",
          layoutCompacted && "gap-0 sm:gap-0",
          layoutCompacted && "px-3 py-2 sm:px-4 sm:py-2.5 dark:px-4 dark:py-2.5 dark:sm:px-4 dark:sm:py-2.5",
        )}
      >
        {renderTitle && (
          <div
            className={cn(
              "min-w-0 sm:min-w-[8rem] transition-[opacity,transform,filter] [transition-duration:150ms] ease-out motion-reduce:transition-none sm:flex-1",
              compacted && "pointer-events-none opacity-0 blur-[1px]",
            )}
          >
            <Typography
              type="h2"
              className="truncate text-xl font-semibold tracking-tight sm:text-2xl"
            >
              {title}
            </Typography>
            {description != null && (
              <Typography type="p" variant="secondary" className="mt-0.5 truncate text-sm">
                {description}
              </Typography>
            )}
          </div>
        )}
        <motion.div
          layout={animateLayout}
          transition={layoutTransition}
          className={cn(
            "relative z-10 min-w-0 max-w-full overflow-x-auto will-change-transform [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "transition-opacity [transition-duration:520ms] motion-reduce:transition-none",
            layoutCompacted && "opacity-95",
          )}
        >
          {actions}
        </motion.div>
      </div>
    </motion.div>
  );
}

export function StickyPageHeader({ title, description, actions, sticky, layoutGroupId, headerRef, scrollContainer = "shell" }: {
  title: string,
  description?: ReactNode,
  actions: ReactNode,
  sticky: boolean,
  layoutGroupId: string,
  headerRef?: Ref<HTMLDivElement>,
  scrollContainer?: "shell" | "main",
}) {
  // A state-backed callback ref, not a plain ref: the compaction hook needs to
  // re-run once the node exists, which a ref alone would not trigger.
  const [headerElement, setHeaderElement] = useState<HTMLDivElement | null>(null);
  const setHeaderNode = useCallback((node: HTMLDivElement | null) => {
    setHeaderElement(node);
    if (typeof headerRef === "function") headerRef(node);
    else if (headerRef != null) (headerRef as MutableRefObject<HTMLDivElement | null>).current = node;
  }, [headerRef]);
  const compacted = useStickyHeaderCompacted(sticky, scrollContainer, headerElement);
  const renderTitle = useRenderWhileClosing(!compacted, STICKY_HEADER_TITLE_EXIT_MS);
  const shouldReduceMotion = useReducedMotion();
  const delayedCompacted = useDelayedTrue(compacted, shouldReduceMotion ? 0 : STICKY_HEADER_TITLE_EXIT_MS);
  const layoutCompacted = sticky && (shouldReduceMotion ? compacted : delayedCompacted);
  const layoutTransition = shouldReduceMotion ? reducedStickyHeaderLayoutTransition : stickyHeaderLayoutTransition;

  return (
    <div
      ref={setHeaderNode}
      className={cn(
        "relative z-30 w-full pointer-events-none",
        sticky && "sticky mb-[var(--page-header-extra-gap,0.5rem)]",
        sticky && (scrollContainer === "main" ? "top-3" : "top-[4.25rem] dark:top-[5.75rem]"),
      )}
    >
      <LayoutGroup id={layoutGroupId}>
        <StickyHeaderChrome
          title={title}
          description={description}
          actions={actions}
          compacted={sticky ? compacted : false}
          layoutCompacted={layoutCompacted}
          renderTitle={sticky ? renderTitle : true}
          layoutTransition={layoutTransition}
          animateLayout
        />
      </LayoutGroup>
    </div>
  );
}
