"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "./cn";

/**
 * Modal built on the native `<dialog>` element opened with `showModal()`, which is what gives it
 * real modal behaviour for free: focus is contained in the dialog, Escape closes it, and focus goes
 * back to whatever opened it when it closes. A `div` with `role="dialog"` only announces itself as
 * modal; it does not trap anything.
 *
 * The element is rendered for as long as the component is mounted, so "open" and "mounted" are the
 * same thing: callers conditionally render it. Clicking the backdrop (the dialog element itself,
 * outside the panel) also closes.
 */
export function ModalDialog({
  labelledBy,
  describedBy,
  onClose,
  children,
  className,
}: {
  labelledBy: string,
  describedBy?: string,
  onClose: () => void,
  children: ReactNode,
  className?: string,
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog == null) return;
    dialog.showModal();
    // Closing before React removes the node is what restores focus to the opener; unmounting an
    // open dialog skips that step.
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      // `cancel` fires for Escape (and for the browser's own close gestures). It is prevented so the
      // caller's state stays the single source of truth for whether the dialog exists.
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
      // The browser gives `<dialog>` its own borders, padding, and a `max-width: calc(100% - 6px)`
      // sizing, all of which are reset here; the backdrop is styled through the `backdrop:` variant.
      className={cn(
        "m-auto w-full max-w-lg rounded-xl border border-black/[0.06] bg-popover p-0 text-popover-foreground shadow-2xl",
        "backdrop:bg-black/50 backdrop:backdrop-blur-sm dark:border-white/[0.08]",
        className,
      )}
    >
      {children}
    </dialog>
  );
}
