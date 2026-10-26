import { input } from "@inquirer/prompts";
import type { CurrentInternalUser } from "@hexclave/js";
import { CliError } from "./errors.js";
import { isNonInteractiveEnv } from "./interactive.js";
import { withProgress } from "./progress.js";
import { resolveTeam } from "./resolve-team.js";

type CreateProjectOptions = {
  displayName?: string,
  teamId?: string,
  defaultDisplayName?: string,
};

export async function createProjectInteractively(
  user: CurrentInternalUser,
  opts: CreateProjectOptions = {},
) {
  let displayName = opts.displayName?.trim();
  if (!displayName) {
    if (isNonInteractiveEnv()) {
      throw new CliError("--display-name is required in non-interactive environments (CI).");
    }
    displayName = (await input({
      message: "Project display name:",
      default: opts.defaultDisplayName,
      validate: (v) => v.trim().length > 0 || "Display name cannot be empty.",
    })).trim();
  }

  const team = await resolveTeam(user, {
    teamId: opts.teamId,
    createTeam: async (teamDisplayName) => await user.createTeam({ displayName: teamDisplayName }),
  });

  return await withProgress("Creating project", async () => await user.createProject({
    displayName,
    teamId: team.id,
  }));
}
