"use client";

import { useEffect, useRef } from "react";
import { Button } from "./controls";
import { cn } from "./cn";

export function SelectionCheckbox({
  checked,
  indeterminate = false,
  label,
  onChange,
}: {
  checked: boolean,
  indeterminate?: boolean,
  label: string,
  onChange: (checked: boolean) => void,
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current != null) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={event => onChange(event.target.checked)}
      onClick={event => event.stopPropagation()}
      className="size-3.5 cursor-pointer rounded border-border accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    />
  );
}

export function SelectionToolbar({
  count,
  noun = "row",
  onClear,
  children,
  className,
}: {
  count: number,
  noun?: string,
  onClear: () => void,
  children?: React.ReactNode,
  className?: string,
}) {
  if (count === 0) return null;
  return (
    <div className={cn(
      "mb-3 flex min-h-10 flex-wrap items-center gap-2 rounded-lg border border-black/[0.08] bg-card px-3 py-2 shadow-sm ring-1 ring-black/[0.04] dark:border-white/[0.08] dark:ring-white/[0.04]",
      className,
    )}>
      <span className="mr-auto text-xs font-medium text-foreground">
        {count} {noun}{count === 1 ? "" : "s"} selected
      </span>
      {children}
      <Button size="xs" variant="ghost" onClick={onClear}>Clear selection</Button>
    </div>
  );
}
