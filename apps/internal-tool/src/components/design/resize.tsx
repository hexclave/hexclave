"use client";

import { useEffect, useState } from "react";
import { readLocalStorage, writeLocalStorage } from "../../lib/browser-storage";
import { cn } from "./cn";

const KEYBOARD_STEP = 16;

/**
 * Shared drag-to-resize behaviour for the app's docked panels. Both sidebars persist their width per
 * browser (there is no server-side user preference store in the internal tool) and clamp through a
 * caller-supplied `normalize`, so the clamping rules stay next to the constants they belong to.
 *
 * `edge` says which edge of the panel the handle sits on, which is what turns a pointer's viewport x
 * into a width: a panel anchored left grows with `clientX`, one anchored right grows as `clientX`
 * shrinks.
 */
export function useResizableWidth({
  label,
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  normalize,
  edge,
}: {
  label: string,
  storageKey: string,
  defaultWidth: number,
  minWidth: number,
  maxWidth: number,
  normalize: (width: number) => number,
  edge: "left" | "right",
}) {
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return defaultWidth;
    const persistedWidth = readLocalStorage(storageKey);
    if (persistedWidth == null) return defaultWidth;
    return normalize(Number(persistedWidth));
  });
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    writeLocalStorage(storageKey, width.toString());
  }, [storageKey, width]);

  return {
    width,
    isResizing,
    resizerProps: { label, width, minWidth, maxWidth, defaultWidth, normalize, edge, isResizing, setWidth, setIsResizing },
  };
}

export type ResizerProps = ReturnType<typeof useResizableWidth>["resizerProps"];

export function Resizer({
  label,
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  normalize,
  edge,
  isResizing,
  setWidth,
  setIsResizing,
}: ResizerProps) {
  // The handle is positioned just outside the panel so the hit area straddles the border, which is
  // where users aim. Panels that resize from their right edge grow toward larger `clientX`; ones that
  // resize from their left edge (right-docked panels) grow as the pointer moves left.
  const widthForClientX = (clientX: number) => normalize(edge === "right" ? clientX : window.innerWidth - clientX);
  return (
    <div
      role="separator"
      aria-label={`Resize ${label}`}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onDoubleClick={() => setWidth(defaultWidth)}
      onPointerDown={event => {
        // preventDefault stops the text-selection drag but also suppresses the focus a mousedown
        // would give; focusing explicitly keeps the arrow keys working right after a drag.
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        setIsResizing(true);
      }}
      onPointerMove={event => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        setWidth(widthForClientX(event.clientX));
      }}
      onPointerUp={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        setIsResizing(false);
      }}
      onLostPointerCapture={() => setIsResizing(false)}
      onKeyDown={event => {
        // Arrow keys always mean "wider to the right, narrower to the left" on screen, so a
        // right-docked panel has to invert them relative to its own width.
        const towardsLarger = edge === "right" ? "ArrowRight" : "ArrowLeft";
        const towardsSmaller = edge === "right" ? "ArrowLeft" : "ArrowRight";
        if (event.key === towardsSmaller) {
          event.preventDefault();
          setWidth(current => normalize(current - KEYBOARD_STEP));
        } else if (event.key === towardsLarger) {
          event.preventDefault();
          setWidth(current => normalize(current + KEYBOARD_STEP));
        } else if (event.key === "Home") {
          event.preventDefault();
          setWidth(edge === "right" ? minWidth : maxWidth);
        } else if (event.key === "End") {
          event.preventDefault();
          setWidth(edge === "right" ? maxWidth : minWidth);
        }
      }}
      className={cn(
        "group absolute inset-y-0 z-40 hidden w-3 cursor-col-resize touch-none focus-visible:outline-none lg:block",
        edge === "right" ? "-right-1.5" : "-left-1.5",
      )}
    >
      <span className={cn(
        "absolute inset-y-0 left-1/2 w-px bg-transparent transition-colors group-hover:bg-foreground/25 group-hover:transition-none group-focus-visible:bg-foreground/40",
        isResizing && "bg-foreground/40",
      )} />
      <span className={cn(
        "absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/10 transition-colors group-hover:bg-foreground/30 group-hover:transition-none group-focus-visible:bg-foreground/40",
        isResizing && "bg-foreground/30",
      )} />
    </div>
  );
}
