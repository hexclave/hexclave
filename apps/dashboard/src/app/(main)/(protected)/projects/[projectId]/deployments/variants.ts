// Visual configuration for the Deployments board.
//
// The board's look (canvas grid, node surface, how connection lines are drawn)
// is captured in a single config object, kept separate from the data / drag /
// right-pane logic. Today there is one look — "Blueprint" — but keeping it as a
// config object means the styling knobs stay in one place.

import type { ConnectorStyle } from "./connections";

export type GridStyle = "dots" | "blueprint" | "none";

export type VariantConfig = {
  gridStyle: GridStyle,
  connectorStyle: ConnectorStyle,
  connectorDashed: boolean,
  // Extra classes for the scrollable board surface (background wash, etc.).
  boardClassName: string,
  // Node surface. `selected` toggles the active ring/elevation.
  nodeClassName: string,
  nodeSelectedClassName: string,
  nodeRadiusClassName: string,
  // Whether the node shows a colored accent strip down its left edge.
  showAccentBar: boolean,
  // Use a monospaced treatment for node names / metadata (blueprint feel).
  mono: boolean,
};

export const BLUEPRINT_VARIANT: VariantConfig = {
  gridStyle: "blueprint",
  connectorStyle: "orthogonal",
  connectorDashed: true,
  boardClassName: "bg-[#f7f8fa] dark:bg-[#0b1220]",
  nodeClassName:
    "bg-white/95 dark:bg-[#0f1830]/80 backdrop-blur-md ring-1 ring-blue-500/20 dark:ring-cyan-300/20 shadow-sm hover:ring-blue-500/40 dark:hover:ring-cyan-300/35",
  nodeSelectedClassName:
    "ring-2 ring-blue-500/70 dark:ring-cyan-300/60 shadow-md",
  nodeRadiusClassName: "rounded-lg",
  showAccentBar: false,
  mono: true,
};

// Node/edge colours. "purple" is reserved for the managed Hexclave node; the
// rest are the palette deployment sources are assigned from (see
// accentForDeploymentSource), which is what tells two repositories' services
// apart on one map.
export type Accent = "purple" | "cyan" | "green" | "amber" | "rose" | "blue" | "indigo";

export type AccentClasses = {
  // Icon chip inside the node header.
  chip: string,
  // Left accent bar.
  bar: string,
  // Connection line stroke (uses text color + currentColor on the SVG path).
  stroke: string,
};

export const ACCENT_CLASSES = new Map<Accent, AccentClasses>([
  ["purple", {
    chip: "bg-purple-500/12 text-purple-600 dark:bg-purple-400/15 dark:text-purple-300",
    bar: "bg-purple-500/70 dark:bg-purple-400/70",
    stroke: "text-purple-500/70 dark:text-purple-400/70",
  }],
  ["cyan", {
    chip: "bg-cyan-500/12 text-cyan-600 dark:bg-cyan-400/15 dark:text-cyan-300",
    bar: "bg-cyan-500/70 dark:bg-cyan-400/70",
    stroke: "text-cyan-500/70 dark:text-cyan-400/70",
  }],
  ["green", {
    chip: "bg-emerald-500/12 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300",
    bar: "bg-emerald-500/70 dark:bg-emerald-400/70",
    stroke: "text-emerald-500/70 dark:text-emerald-400/70",
  }],
  ["amber", {
    chip: "bg-amber-500/12 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300",
    bar: "bg-amber-500/70 dark:bg-amber-400/70",
    stroke: "text-amber-500/70 dark:text-amber-400/70",
  }],
  ["rose", {
    chip: "bg-rose-500/12 text-rose-600 dark:bg-rose-400/15 dark:text-rose-300",
    bar: "bg-rose-500/70 dark:bg-rose-400/70",
    stroke: "text-rose-500/70 dark:text-rose-400/70",
  }],
  ["blue", {
    chip: "bg-blue-500/12 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300",
    bar: "bg-blue-500/70 dark:bg-blue-400/70",
    stroke: "text-blue-500/70 dark:text-blue-400/70",
  }],
  ["indigo", {
    chip: "bg-indigo-500/12 text-indigo-600 dark:bg-indigo-400/15 dark:text-indigo-300",
    bar: "bg-indigo-500/70 dark:bg-indigo-400/70",
    stroke: "text-indigo-500/70 dark:text-indigo-400/70",
  }],
]);

export function getAccentClasses(accent: Accent): AccentClasses {
  const classes = ACCENT_CLASSES.get(accent);
  if (!classes) throw new Error(`Unknown accent: ${accent}`);
  return classes;
}

export const STATUS_META = new Map<string, { label: string, color: "green" | "cyan" | "orange" | "red" }>([
  ["deployed", { label: "Deployed", color: "green" }],
  ["building", { label: "Building", color: "cyan" }],
  ["not_deployed", { label: "Not deployed", color: "orange" }],
  ["canceled", { label: "Cancelled", color: "orange" }],
  ["crashed", { label: "Failed", color: "red" }],
  // Planned by the deploy but never reached, because something it depends on
  // (or the build) failed first. Labelled "Build failed" rather than "Skipped":
  // one deploy is one build, so the overwhelmingly common way a service ends up
  // here is a build failure, and naming the cause is what a reader needs.
  ["skipped", { label: "Build failed", color: "orange" }],
]);
