import { BUNDLED_DASHBOARD_UI_TYPES, BUNDLED_TYPE_DEFINITIONS } from "@/generated/bundled-type-definitions";
import { ALL_APPS_FRONTEND, type AppId, getItemPath, hasNavigationItems } from "@/lib/apps-frontend";
import type { CurrentUser } from "@/lib/api-headers";

export type DashboardMessagePart = {
  type: "text",
  text: string,
  providerOptions?: Record<string, unknown>,
};
export type DashboardMessage = {
  role: string,
  content: string | DashboardMessagePart[],
};

/**
 * Builds a formatted list of available dashboard routes based on enabled apps.
 * This is injected into the AI context so it only generates links to pages that exist.
 */
export function buildAvailableRoutes(enabledAppIds: AppId[]): string {
  const routes: Array<{ path: string, label: string }> = [];

  // Static routes that are always available
  routes.push({ path: "/", label: "Overview" });
  routes.push({ path: "/dashboards", label: "Dashboards" });
  routes.push({ path: "/explore-apps", label: "Explore Apps" });
  routes.push({ path: "/project-keys", label: "Project Keys" });
  routes.push({ path: "/project-settings", label: "Project Settings" });

  // Dynamic routes from enabled apps
  for (const appId of [...enabledAppIds].sort()) {
    const appFrontend = ALL_APPS_FRONTEND[appId as keyof typeof ALL_APPS_FRONTEND];
    if (!hasNavigationItems(appFrontend)) {
      continue;
    }
    for (const item of appFrontend.navigationItems) {
      // Use a placeholder project ID — we only need the path relative to /projects/[id]/
      const fullPath = getItemPath("__PROJECT__", appFrontend, item);
      // Strip /projects/__PROJECT__/ prefix to get the relative path
      const relativePath = fullPath.replace(/^\/projects\/__PROJECT__\//, "/");
      routes.push({ path: relativePath, label: item.displayName });
    }
  }

  const routeList = routes.map(r => `- ${r.path} — ${r.label}`).join("\n");
  return `\nAVAILABLE DASHBOARD ROUTES (use ONLY these with window.dashboardNavigate):\n${routeList}\nDo NOT use any paths not listed above.`;
}

function getAllTypeDefinitionFiles(): string[] {
  return BUNDLED_TYPE_DEFINITIONS.map((f: { path: string }) => f.path);
}

function stripComments(source: string): string {
  // Strip multi-line JSDoc comments (/** ... */)
  let result = source.replace(/\/\*\*[\s\S]*?\*\//g, '');
  // Strip single-line comments (but not inside strings or URLs)
  result = result.replace(/^(\s*)\/\/(?!#region|#endregion).*$/gm, '');
  // Collapse consecutive blank lines
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

export function loadSelectedTypeDefinitions(selectedFiles: string[]): string {
  const fileContents = selectedFiles.map((relativePath: string) => {
    const file = BUNDLED_TYPE_DEFINITIONS.find((f: { path: string }) => f.path === relativePath);
    if (!file) {
      throw new Error(`Type definition file not found in bundle: ${relativePath}`);
    }
    return `
=== ${relativePath} ===
${stripComments(file.content)}
`;
  });

  return `
Complete Hexclave SDK Type Definitions (Selected Files):
These files show the available methods, types, and interfaces for the Hexclave SDK.
${fileContents.join('\n')}
  `.trim();
}

export function buildDashboardMessages(
  _backendBaseUrl: string,
  _currentUser: CurrentUser | undefined,
  _messages: Array<{ role: string, content: unknown }>,
  currentSource?: string,
  enabledAppIds?: AppId[],
): Promise<DashboardMessage[]> {
  const typeDefinitions = loadSelectedTypeDefinitions(getAllTypeDefinitionFiles());
  const availableRoutes = enabledAppIds ? buildAvailableRoutes(enabledAppIds) : "";

  const dashboardUiDocsHeader = [
    "DashboardUI component documentation (READ THIS BEFORE USING ANY COMPONENT):",
    "",
    "The block below is not just TypeScript types — each component carries a JSDoc block",
    "with its mental model, canonical pattern, prop rules, runnable examples, and common",
    "mistakes. Before you write code against DataGrid, AnalyticsChart, DesignMetricCard,",
    "DesignCard, DesignBadge, DesignButton, or any other DashboardUI.* component, read the",
    "JSDoc on that specific component in the block below. The JSDoc is load-bearing — the",
    "bare type signatures are NOT enough to use the components correctly.",
  ].join("\n");

  const cachedText = `Here are the type definitions for the Hexclave SDK:\n${typeDefinitions}\n\n${dashboardUiDocsHeader}\n${BUNDLED_DASHBOARD_UI_TYPES}`;
  const contextMessages: DashboardMessage[] = [];

  contextMessages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: cachedText,
        providerOptions: {
          openrouter: { cacheControl: { type: "ephemeral" } },
        },
      },
    ],
  });
  contextMessages.push({
    role: "assistant",
    content: "I have the SDK reference material and UI component types. What dashboard would you like me to create or edit?",
  });

  const tailParts: string[] = [];
  if (availableRoutes) {
    tailParts.push(availableRoutes.trimStart());
  }
  if (currentSource != null && currentSource.length > 0) {
    tailParts.push(`Here is the current dashboard source code:\n\`\`\`tsx\n${currentSource}\n\`\`\``);
  }
  if (tailParts.length > 0) {
    contextMessages.push({
      role: "user",
      content: tailParts.join("\n\n"),
    });
    contextMessages.push({
      role: "assistant",
      content: "Got it. What changes would you like me to make?",
    });
  }

  return Promise.resolve(contextMessages);
}

export { BUNDLED_DASHBOARD_UI_TYPES };
