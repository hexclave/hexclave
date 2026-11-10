"use client";

import { ConsoleShell } from "../../console/shell/ConsoleShell";

/**
 * The redesigned console lives under /console, next to the original UI at `/` (unchanged). The
 * shell, and with it every SpacetimeDB subscription, is mounted here once and survives client-side
 * navigation between the pages below.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
