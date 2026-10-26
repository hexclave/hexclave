import { getRenderedBranchConfigQuery } from "@/lib/config";
import { globalPrismaClient, rawQuery } from "@/prisma-client";
import { DEFAULT_BRANCH_ID } from "@/lib/tenancies";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { tool } from "ai";
import { z } from "zod";

export const READ_CONFIG_RESULT_MAX_CHARS = 50_000;

/**
 * Resolves the project/branch whose config should be read. Only an explicit
 * `targetProjectId` is accepted: the route verifies it via `assertProjectAccess`
 * before tools are built. There is deliberately no fallback to the caller's own
 * project, since the AI endpoint accepts client-level auth and the rendered
 * config contains secrets (OAuth client secrets, email server passwords, etc.).
 */
function resolveConfigTarget(
  targetProjectId?: string | null,
): { projectId: string, branchId: string } | null {
  if (targetProjectId != null) {
    return { projectId: targetProjectId, branchId: DEFAULT_BRANCH_ID };
  }
  return null;
}

/**
 * Creates a tool that returns the rendered branch config object — the same
 * configuration that is usually stored in the project's `hexclave.config.ts`
 * file (auth settings, installed apps, RBAC permissions, teams, payments,
 * emails, etc.). Returns `null` when there is no project context to read from.
 */
export function readConfigTool(targetProjectId?: string | null) {
  const target = resolveConfigTarget(targetProjectId);
  if (target == null) {
    return null;
  }

  return tool({
    description: "Read the current Hexclave branch config object for this project. This is the resolved configuration that is usually stored in the project's `hexclave.config.ts` file — it includes settings such as installed apps (`apps`), authentication and sign-up behavior (`auth`), API keys (`apiKeys`), RBAC permissions (`rbac`), teams (`teams`), users (`users`), onboarding, emails, and payments. Use this whenever you need to know how the project is currently configured.",
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const config = await rawQuery(globalPrismaClient, getRenderedBranchConfigQuery(target));
        const serialized = JSON.stringify(config);
        if (serialized.length > READ_CONFIG_RESULT_MAX_CHARS) {
          return {
            success: false as const,
            error:
              `The project config is too large to return in full (${serialized.length} characters, limit ${READ_CONFIG_RESULT_MAX_CHARS}). ` +
              `Ask the user about the specific part of the configuration you need (eg. apps, auth, rbac, teams, payments) so it can be inspected directly instead.`,
          };
        }
        return {
          success: true as const,
          config,
        };
      } catch (error) {
        captureError("ai-tool-read-config", error);
        return {
          success: false as const,
          error: "Failed to read the project config. Please try again.",
        };
      }
    },
  });
}
