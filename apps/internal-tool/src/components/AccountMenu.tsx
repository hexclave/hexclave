"use client";

import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "./design";

type AccountAction = "settings" | "sign-out";

function AccountIcon({ action }: { action: AccountAction }) {
  const classes = "size-4 shrink-0 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.6]";
  if (action === "settings") {
    return (
      <svg aria-hidden="true" viewBox="0 0 20 20" className={classes}>
        <circle cx="10" cy="7" r="3" />
        <path d="M4.5 16c.8-3 2.63-4.5 5.5-4.5s4.7 1.5 5.5 4.5" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className={classes}>
      <path d="M8 4H4.5v12H8M12.5 6.5 16 10l-3.5 3.5M7 10h9" />
    </svg>
  );
}

export function AccountMenu({
  accountName,
  accountDetail,
  accountInitial,
  onOpenAccountSettings,
  onSignOut,
}: {
  accountName: string,
  accountDetail: string,
  accountInitial: string,
  onOpenAccountSettings: () => Promise<void>,
  onSignOut: () => Promise<void>,
}) {
  const [open, setOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<AccountAction | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstMenuItemRef = useRef<HTMLButtonElement>(null);
  const lastMenuItemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => firstMenuItemRef.current?.focus());
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        requestAnimationFrame(() => triggerRef.current?.focus());
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        if (document.activeElement === firstMenuItemRef.current) lastMenuItemRef.current?.focus();
        else firstMenuItemRef.current?.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (document.activeElement === lastMenuItemRef.current) firstMenuItemRef.current?.focus();
        else lastMenuItemRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const runAccountAction = (action: AccountAction, callback: () => Promise<void>) => {
    if (pendingAction != null) return;
    setPendingAction(action);
    runAsynchronouslyWithAlert(callback().finally(() => setPendingAction(null)));
  };

  return (
    <div ref={containerRef} className="relative">
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Account menu"
          className="absolute bottom-full left-0 z-50 mb-2 w-[min(17rem,calc(100vw-1rem))] rounded-xl border border-black/[0.08] bg-popover p-1.5 text-popover-foreground shadow-md dark:border-white/[0.1]"
        >
          <div className="flex min-w-0 items-center gap-2.5 px-2 py-2">
            <span className="relative grid size-9 shrink-0 place-items-center rounded-lg bg-foreground/[0.08] text-xs font-semibold text-foreground">
              {accountInitial}
              <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-popover bg-emerald-500" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-foreground">{accountName}</span>
              <span className="block truncate text-[10px] text-muted-foreground">{accountDetail}</span>
            </span>
          </div>
          <div className="my-1 border-t border-black/[0.06] dark:border-white/[0.08]" />
          <button
            ref={firstMenuItemRef}
            type="button"
            role="menuitem"
            disabled={pendingAction != null}
            onClick={() => runAccountAction("settings", onOpenAccountSettings)}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.06] hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60"
          >
            <AccountIcon action="settings" />
            <span className="flex-1">Account settings</span>
            {pendingAction === "settings" && <span className="text-[10px] text-muted-foreground">Opening…</span>}
          </button>
          <button
            ref={lastMenuItemRef}
            type="button"
            role="menuitem"
            disabled={pendingAction != null}
            onClick={() => runAccountAction("sign-out", onSignOut)}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-xs font-medium text-red-600 transition-colors hover:bg-red-500/10 hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-red-500 dark:text-red-400 disabled:opacity-60"
          >
            <AccountIcon action="sign-out" />
            <span className="flex-1">Sign out</span>
            {pendingAction === "sign-out" && <span className="text-[10px]">Signing out…</span>}
          </button>
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Open account menu for ${accountName}`}
        title={`${accountName} · ${accountDetail}`}
        onClick={() => setOpen(current => !current)}
        className={cn(
          "flex w-full items-center justify-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left",
          "transition-colors hover:bg-foreground/[0.05] hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring lg:justify-start",
          open && "bg-foreground/[0.06]",
        )}
      >
        <span className="relative grid size-7 shrink-0 place-items-center rounded-md bg-foreground/[0.08] text-[10px] font-semibold text-foreground">
          {accountInitial}
          <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-card bg-emerald-500" />
        </span>
        <span className="hidden min-w-0 flex-1 lg:block">
          <span className="block truncate text-xs font-medium text-foreground">{accountName}</span>
          <span className="block truncate text-[10px] text-muted-foreground">{accountDetail}</span>
        </span>
        <svg aria-hidden="true" viewBox="0 0 20 20" className={cn("hidden size-3.5 shrink-0 fill-none stroke-current text-muted-foreground lg:block [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.7]", open && "rotate-180")}>
          <path d="m6 12 4-4 4 4" />
        </svg>
      </button>
    </div>
  );
}
