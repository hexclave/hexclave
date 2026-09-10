"use client";

import { cn } from "./design";

export function DetailPanelTabs<T extends string>({
  label,
  items,
  value,
  onChange,
}: {
  label: string,
  items: ReadonlyArray<{ value: T, label: string }>,
  value: T,
  onChange: (value: T) => void,
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 px-4 pb-2 pt-2">
      {items.map(item => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={value === item.value}
          tabIndex={value === item.value ? 0 : -1}
          onClick={() => onChange(item.value)}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
            const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
            if (tabs == null || tabs.length === 0) return;
            event.preventDefault();
            const currentIndex = Array.from(tabs).indexOf(event.currentTarget);
            const nextIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : event.key === "ArrowRight"
                  ? (currentIndex + 1) % tabs.length
                  : (currentIndex - 1 + tabs.length) % tabs.length;
            tabs[nextIndex].focus();
            tabs[nextIndex].click();
          }}
          className={cn(
            "h-8 rounded-md px-3 text-xs font-medium transition-colors hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            value === item.value
              ? "bg-foreground/[0.09] text-foreground"
              : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function DetailMetricStrip({ items }: {
  items: ReadonlyArray<{ label: string, value: string, tone?: "default" | "error" | "success" }>,
}) {
  return (
    <dl className="grid grid-cols-2 divide-x divide-y divide-black/[0.06] border-t border-black/[0.06] dark:divide-white/[0.06] dark:border-white/[0.06] sm:grid-cols-4 sm:divide-y-0">
      {items.map(item => (
        <div key={item.label} className="min-w-0 px-4 py-2.5 first:border-t-0">
          <dt className="text-[10px] text-muted-foreground">{item.label}</dt>
          <dd className={cn(
            "mt-0.5 truncate font-mono text-xs font-medium tabular-nums",
            item.tone === "error"
              ? "text-red-600 dark:text-red-400"
              : item.tone === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-foreground",
          )}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
