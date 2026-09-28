import { SmartRequestAuth } from "@/route-handlers/smart-request";
import { HexclaveAssertionError, captureError } from "@hexclave/shared/dist/utils/errors";
import { ToolSet } from "ai";
import { updateDashboardTool } from "./create-dashboard";
import { createEmailDraftTool } from "./create-email-draft";
import { createEmailTemplateTool } from "./create-email-template";
import { createEmailThemeTool } from "./create-email-theme";
import { createDocsTools } from "./docs";
import { readConfigTool } from "./read-config";
import { createSqlQueryTool } from "./sql-query";

export const TOOL_NAMES = [
  "docs",
  "sql-query",
  "read-config",
  "create-email-theme",
  "create-email-template",
  "create-email-draft",
  "update-dashboard"
] as const;
export type ToolName = typeof TOOL_NAMES[number]


export type ToolContext = {
  auth: SmartRequestAuth | null,
  targetProjectId?: string | null,
  mcpToolName?: string | null,
};

export async function getTools(
  toolNames: readonly ToolName[],
  context: ToolContext
): Promise<ToolSet> {
  const tools: ToolSet = {};

  for (const toolName of toolNames) {
    switch (toolName) {
      case "docs": {
        if (context.mcpToolName === "ask_hexclave") {
          break;
        }
        const docsTools = await createDocsTools();
        Object.assign(tools, docsTools);
        break;
      }

      case "sql-query": {
        tools["queryAnalytics"] = createSqlQueryTool(context.auth, context.targetProjectId);
        break;
      }

      case "read-config": {
        const configTool = readConfigTool(context.auth, context.targetProjectId);
        if (configTool != null) {
          tools["readBranchConfig"] = configTool;
        }
        break;
      }

      case "create-email-theme": {
        tools["createEmailTheme"] = createEmailThemeTool(context.auth);
        break;
      }

      case "create-email-template": {
        tools["createEmailTemplate"] = createEmailTemplateTool(context.auth);
        break;
      }

      case "create-email-draft": {
        tools["createEmailDraft"] = createEmailDraftTool(context.auth);
        break;
      }

      case "update-dashboard": {
        tools["updateDashboard"] = updateDashboardTool(context.auth);
        break;
      }

      default: {
        const _exhaustive: never = toolName;
        captureError("ai-tools-getTools", new HexclaveAssertionError(`Unknown tool name: ${_exhaustive as string}`));
      }
    }
  }

  return tools;
}

/**
 * Validates that all requested tool names are valid.
 * Returns false if any tool name is not in `TOOL_NAMES`.
 */
export function validateToolNames(toolNames: unknown): toolNames is ToolName[] {
  if (!Array.isArray(toolNames)) {
    return false;
  }
  return toolNames.every((name): name is ToolName =>
    typeof name === "string" && (TOOL_NAMES as readonly string[]).includes(name)
  );
}
