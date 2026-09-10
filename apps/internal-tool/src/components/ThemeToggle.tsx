"use client";

import { useTheme, type Theme } from "../lib/theme";
import { cn } from "./design";

const OPTIONS: Array<{ value: Theme, label: string, shortLabel: string }> = [
  { value: "light", label: "Light", shortLabel: "Light" },
  { value: "dark", label: "Dark", shortLabel: "Dark" },
  { value: "system", label: "System", shortLabel: "Auto" },
];

function ThemeIcon({ theme }: { theme: Theme }) {
  const classes = "size-3.5 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.7]";
  switch (theme) {
    case "light": {
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className={classes}>
          <circle cx="10" cy="10" r="3" />
          <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
        </svg>
      );
    }
    case "dark": {
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className={classes}>
          <path d="M16.2 12.6A6.6 6.6 0 0 1 7.4 3.8a6.6 6.6 0 1 0 8.8 8.8Z" />
        </svg>
      );
    }
    case "system": {
      return (
        <svg aria-hidden="true" viewBox="0 0 20 20" className={classes}>
          <rect x="3" y="4" width="14" height="10" rx="1.5" />
          <path d="M7 17h6M10 14v3" />
        </svg>
      );
    }
  }
}

/**
 * Three-way theme switch (light / dark / system), same semantics as the dashboard's switch — it
 * writes the shared `theme` localStorage key. Before hydration `theme` reads as "system" on both
 * server and client, so no option is highlighted until `mounted` flips to true.
 */
export function ThemeToggle() {
  const { theme, setTheme, mounted } = useTheme();
  const nextTheme: Theme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";

  return (
    <>
      <button
        type="button"
        onClick={() => setTheme(nextTheme)}
        aria-label={`Current theme: ${theme}. Switch to ${nextTheme} theme`}
        title={`Current: ${theme} · switch to ${nextTheme}`}
        className={cn(
          "mx-auto flex size-9 items-center justify-center rounded-lg border border-black/[0.06] bg-foreground/[0.025] text-muted-foreground ring-1 ring-black/[0.03] lg:hidden",
          "transition-colors hover:bg-foreground/[0.06] hover:text-foreground hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "dark:border-white/[0.08] dark:ring-white/[0.04]",
        )}
      >
        <ThemeIcon theme={mounted ? theme : "system"} />
      </button>
      <div className="hidden w-full grid-cols-3 rounded-lg border border-black/[0.06] bg-foreground/[0.025] p-1 ring-1 ring-black/[0.03] dark:border-white/[0.08] dark:ring-white/[0.04] lg:grid">
        {OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            onClick={() => setTheme(option.value)}
            aria-label={`${option.label} theme`}
            aria-pressed={mounted && theme === option.value}
            title={`${option.label} theme`}
            className={cn(
              "flex h-7 w-full items-center justify-center gap-1 rounded-md px-1 text-[11px] leading-none",
              "transition-colors hover:transition-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              mounted && theme === option.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground",
            )}
          >
            <ThemeIcon theme={option.value} />
            <span className="text-[10px]">{option.shortLabel}</span>
          </button>
        ))}
      </div>
    </>
  );
}
