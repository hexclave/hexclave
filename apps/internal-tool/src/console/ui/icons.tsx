import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { cn } from "../../components/design/cn";

/**
 * Stroke icons for the console, drawn on a 20×20 grid in the style of the rest of the tool's
 * hand-rolled SVGs. The app has no icon dependency (and adding one needs approval), so every icon
 * the console uses lives here; keep paths simple enough to read at 14–16px.
 */
const ICON_PATHS = {
  overview: "M3.5 3.5h5v5h-5zM11.5 3.5h5v8h-5zM3.5 11.5h5v5h-5zM11.5 14.5h5v2h-5z",
  review: "M4 4.5h12v8H9l-3.5 3v-3H4v-8ZM7 8.5h6",
  analytics: "M4 15.5V11M8 15.5V7.5M12 15.5v-10M16 15.5V9",
  lightbulb: "M10 3.5a4.5 4.5 0 0 0-2.8 8v2h5.6v-2a4.5 4.5 0 0 0-2.8-8ZM8 16.5h4",
  feedback: "M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM7.5 8.5h.01M12.5 8.5h.01M7.5 12c.8.7 1.6 1 2.5 1s1.7-.3 2.5-1",
  sparkles: "M10 3v3M10 14v3M3 10h3M14 10h3M5.5 5.5l2 2M12.5 12.5l2 2M14.5 5.5l-2 2M7.5 12.5l-2 2",
  book: "M3.5 4.5h5A1.5 1.5 0 0 1 10 6v10a2 2 0 0 0-2-2H3.5V4.5ZM16.5 4.5h-5A1.5 1.5 0 0 0 10 6v10a2 2 0 0 1 2-2h4.5V4.5Z",
  terminal: "M3.5 4.5h13v11h-13zM6.5 8l2.5 2-2.5 2M10.5 12.5h3",
  search: "M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM17 17l-3.8-3.8",
  close: "M5 5l10 10M15 5 5 15",
  chevronDown: "m6 8 4 4 4-4",
  chevronUp: "m6 12 4-4 4 4",
  chevronLeft: "m12 6-4 4 4 4",
  chevronRight: "m8 6 4 4-4 4",
  check: "m4.5 10.5 3.5 3.5 7.5-8",
  plus: "M10 4.5v11M4.5 10h11",
  refresh: "M15.5 9A5.5 5.5 0 0 0 5 6.5M4.5 11A5.5 5.5 0 0 0 15 13.5M5 3.5v3h3M15 16.5v-3h-3",
  copy: "M7.5 7.5h8v8h-8zM12.5 7.5V4.5h-8v8h3",
  external: "M11.5 4.5h4v4M15.5 4.5 9 11M8.5 5.5h-4v10h10v-4",
  sun: "M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4",
  moon: "M16.2 12.6A6.6 6.6 0 0 1 7.4 3.8a6.6 6.6 0 1 0 8.8 8.8Z",
  monitor: "M3 4h14v10H3zM7 17h6M10 14v3",
  user: "M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM4.5 16c.8-3 2.6-4.5 5.5-4.5s4.7 1.5 5.5 4.5",
  signOut: "M8 4H4.5v12H8M12.5 6.5 16 10l-3.5 3.5M7 10h9",
  alert: "M10 3.5 17 16H3l7-12.5ZM10 8.5v3M10 14h.01",
  clock: "M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM10 6.5V10l2.5 1.5",
  filter: "M3.5 5h13M6 10h8M8.5 15h3",
  sidebar: "M3.5 4h13v12h-13zM8 4v12",
  play: "M7 5.5v9l7-4.5-7-4.5Z",
  arrowRight: "M4.5 10h11M11 5.5l4.5 4.5-4.5 4.5",
  database: "M10 7c3.6 0 6.5-1.1 6.5-2.5S13.6 2 10 2 3.5 3.1 3.5 4.5 6.4 7 10 7ZM3.5 4.5v11C3.5 16.9 6.4 18 10 18s6.5-1.1 6.5-2.5v-11M3.5 10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5",
  command: "M7 7V5.5A1.5 1.5 0 1 0 5.5 7H7Zm0 0h6M7 7v6m6-6V5.5A1.5 1.5 0 1 1 14.5 7H13Zm0 0v6m0 0v1.5a1.5 1.5 0 1 0 1.5-1.5H13Zm0 0H7m0 0v1.5A1.5 1.5 0 1 1 5.5 13H7Z",
  inbox: "M3.5 11.5 5.5 4h9l2 7.5v4.5h-13v-4.5ZM3.5 11.5h4l1 2h3l1-2h4",
} as const;

export type IconName = keyof typeof ICON_PATHS;

// Size is a prop rather than a className because `cn` does not run tailwind-merge: a caller's
// `size-3` next to a default `size-4` would leave stylesheet order to pick the winner.
const ICON_SIZES = new Map<IconSize, string>([
  ["xs", "size-3"],
  ["sm", "size-3.5"],
  ["md", "size-4"],
  ["lg", "size-5"],
]);
export type IconSize = "xs" | "sm" | "md" | "lg";

export function Icon({ name, size = "md", className, strokeWidth = 1.6 }: { name: IconName, size?: IconSize, className?: string, strokeWidth?: number }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={cn("shrink-0 fill-none stroke-current", ICON_SIZES.get(size) ?? throwErr(`No icon size class for ${size}`), className)}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
