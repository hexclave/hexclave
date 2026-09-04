import { BUNDLED_DASHBOARD_UI_TYPES, BUNDLED_TYPE_DEFINITIONS } from "@/generated/bundled-type-definitions";
import { ALL_APPS_FRONTEND, type AppId, getItemPath, hasNavigationItems } from "@/lib/apps-frontend";
import { buildHexclaveHeaders, type CurrentUser } from "@/lib/api-headers";
import { parseResponseJson } from "@hexclave/shared/dist/utils/http";
import { parseJson } from "@hexclave/shared/dist/utils/json";

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
  for (const appId of enabledAppIds) {
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

export async function selectRelevantFiles(
  prompt: string,
  backendBaseUrl: string,
  currentUser?: CurrentUser,
): Promise<string[]> {
  const availableFiles = BUNDLED_TYPE_DEFINITIONS.map((f: { path: string }) => f.path);

  const systemPromptText = `You are a code assistant helping to generate dashboard code for Hexclave.

Your task is to select which Hexclave SDK type definition files you'll need to generate the requested dashboard.

IMPORTANT GUIDELINES:
- DO NOT be conservative in file selection - when in doubt, INCLUDE the file
- If a file might be relevant to the dashboard, SELECT IT
- For user/team dashboards: select users and/or teams files
- For project info: select projects files
- Always select server-app.ts as it contains the main SDK interface
- It's better to include extra files than to miss necessary types

Available files:
${availableFiles.map(f => `- ${f}`).join('\n')}

Respond with ONLY a JSON object: { "selectedFiles": ["file1.ts", "file2.ts"] }
No markdown, no explanation — just the JSON.`;

  try {
    const authHeaders = await buildHexclaveHeaders(currentUser);
    const response = await fetch(`${backendBaseUrl}/api/latest/ai/query/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        quality: "dumb",
        speed: "fast",
        systemPrompt: "command-center-ask-ai",
        tools: [],
        messages: [{
          role: "user",
          content: `${systemPromptText}\n\nDashboard request: "${prompt}"\n\nWhich type definition files do you need? When uncertain, err on the side of INCLUDING more files rather than fewer.`,
        }],
      }),
    });

    const result = await parseResponseJson<{ content?: Array<{ type: string, text?: string }> }>(response);
    const content = Array.isArray(result.content) ? result.content : [];
    const textBlock = content.find((b) => b.type === "text");
    const responseText = textBlock?.text;

    if (!responseText) {
      return availableFiles;
    }

    const jsonMatch = responseText.match(/\{[\s\S]*"selectedFiles"[\s\S]*\}/);
    if (!jsonMatch) {
      return availableFiles;
    }

    const parsed = parseJson(jsonMatch[0]);
    if (parsed.status === "error" || typeof parsed.data !== "object" || parsed.data === null || Array.isArray(parsed.data)) {
      return availableFiles;
    }
    const selectedFiles = Array.isArray(parsed.data.selectedFiles)
      ? parsed.data.selectedFiles.filter((file): file is string => typeof file === "string")
      : [];
    if (selectedFiles.length === 0) {
      return availableFiles;
    }

    const selected = selectedFiles.filter((f) => availableFiles.includes(f));

    return selected;
  } catch (e) {
    console.log("[selectRelevantFiles] failed, returning all files:", e);
    return availableFiles;
  }
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

function extractUserPromptText(messages: Array<{ role: string, content: unknown }>): string {
  const lastUserMessage = [...messages].reverse().find(m => m.role === "user");
  if (typeof lastUserMessage?.content === "string") {
    return lastUserMessage.content;
  }
  if (Array.isArray(lastUserMessage?.content)) {
    const textPart = (lastUserMessage.content as Array<{ type: string, text?: string }>).find(c => c.type === "text");
    return textPart?.text ?? "dashboard";
  }
  return "dashboard";
}

export async function buildDashboardMessages(
  backendBaseUrl: string,
  currentUser: CurrentUser | undefined,
  messages: Array<{ role: string, content: unknown }>,
  currentSource?: string,
  enabledAppIds?: AppId[],
): Promise<Array<{ role: string, content: string }>> {
  const promptForFileSelection = extractUserPromptText(messages);
  const selectedFiles = await selectRelevantFiles(promptForFileSelection, backendBaseUrl, currentUser);
  const typeDefinitions = loadSelectedTypeDefinitions(selectedFiles);

  const availableRoutes = enabledAppIds ? buildAvailableRoutes(enabledAppIds) : "";

  const contextMessages: Array<{ role: string, content: string }> = [];

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

  if (currentSource != null && currentSource.length > 0) {
    contextMessages.push({
      role: "user",
      content: `Here is the current dashboard source code:\n\`\`\`tsx\n${currentSource}\n\`\`\`\n\nHere are the type definitions:\n${typeDefinitions}\n\n${dashboardUiDocsHeader}\n${BUNDLED_DASHBOARD_UI_TYPES}${availableRoutes}`,
    });
    contextMessages.push({
      role: "assistant",
      content: "I understand the current dashboard code, type definitions, and available routes. I've also read the JSDoc on every DashboardUI component I plan to use and will follow each component's canonical pattern. What changes would you like to make?",
    });
  } else {
    contextMessages.push({
      role: "user",
      content: `Here are the type definitions for the Hexclave SDK:\n${typeDefinitions}\n\n${dashboardUiDocsHeader}\n${BUNDLED_DASHBOARD_UI_TYPES}${availableRoutes}`,
    });
    contextMessages.push({
      role: "assistant",
      content: "I have the type definitions and available routes. I've also read the JSDoc on every DashboardUI component I plan to use and will follow each component's canonical pattern. What dashboard would you like me to create?",
    });
  }

  return contextMessages;
}

export { BUNDLED_DASHBOARD_UI_TYPES };
