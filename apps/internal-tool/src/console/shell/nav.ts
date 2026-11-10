import type { IconName } from "../ui/icons";

/**
 * Every page of the console, in navigation order. The sidebar, the command palette and the page
 * headers all read this list, so adding a page here is the only registration it needs.
 */
export const CONSOLE_PAGES = [
  { id: "overview", label: "Overview", href: "/console", icon: "overview", section: null, description: "Health of MCP and Unified AI at a glance" },
  { id: "mcp", label: "MCP Review", href: "/console/mcp", icon: "review", section: "MCP", description: "Review MCP answers, QA verdicts and corrections" },
  { id: "feature-requests", label: "Feature Requests", href: "/console/feature-requests", icon: "lightbulb", section: "MCP", description: "Capability gaps detected by MCP QA reviews" },
  { id: "feedback", label: "Feedback", href: "/console/feedback", icon: "feedback", section: "MCP", description: "Feedback volunteered through give_feedback" },
  { id: "ai-usage", label: "AI Usage", href: "/console/ai-usage", icon: "sparkles", section: "Unified AI", description: "Requests, tokens, cost and latency of the Unified AI endpoint" },
  { id: "knowledge", label: "Knowledge Base", href: "/console/knowledge", icon: "book", section: "Content", description: "Curated Q&A published to /questions" },
  { id: "sql", label: "SQL Console", href: "/console/sql", icon: "terminal", section: "Tools", description: "Read-only SQL over every log" },
] as const satisfies ReadonlyArray<{ id: string, label: string, href: string, icon: IconName, section: string | null, description: string }>;

export type ConsolePage = typeof CONSOLE_PAGES[number];
export type ConsolePageId = ConsolePage["id"];

export function consolePage(id: ConsolePageId): ConsolePage {
  const page = CONSOLE_PAGES.find(candidate => candidate.id === id);
  if (page == null) throw new Error(`Unknown console page: ${id}`);
  return page;
}

/** The page whose route owns `pathname` (the longest matching href wins, so /console stays Overview only). */
export function activeConsolePage(pathname: string): ConsolePage | null {
  const matches = CONSOLE_PAGES.filter(page => pathname === page.href || (page.href !== "/console" && pathname.startsWith(`${page.href}/`)));
  return matches.sort((a, b) => b.href.length - a.href.length).at(0) ?? null;
}

export function navSections(): Array<{ label: string | null, pages: ConsolePage[] }> {
  const sections: Array<{ label: string | null, pages: ConsolePage[] }> = [];
  for (const page of CONSOLE_PAGES) {
    const last = sections.at(-1);
    if (last != null && last.label === page.section) last.pages.push(page);
    else sections.push({ label: page.section, pages: [page] });
  }
  return sections;
}
