import { input, select } from "@inquirer/prompts";
import { teamsPageSize } from "@hexclave/shared/dist/utils/team-lists";
import { CliError } from "./errors.js";
import { isNonInteractiveEnv } from "./interactive.js";

export type ResolveTeamItem = {
  id: string,
  displayName: string,
};

/**
 * Where to look up the user's teams. `listTeams` is only used for the first page (a request is capped at 200 teams),
 * so lookups by ID must go through `getTeam`.
 */
export type ResolveTeamSource<T extends ResolveTeamItem> = {
  getTeam: (teamId: string) => Promise<T | null>,
  listTeams: (options: { limit: number, cursor: string | undefined }) => Promise<T[] & { nextCursor: string | null }>,
};

export type ResolveTeamOptions<T extends ResolveTeamItem> = {
  teamId?: string,
  createTeam?: (displayName: string) => Promise<T>,
};

export async function resolveTeam<T extends ResolveTeamItem>(
  source: ResolveTeamSource<T>,
  options: ResolveTeamOptions<T> = {},
): Promise<T> {
  const teamId = options.teamId?.trim();
  if (teamId) {
    const team = await source.getTeam(teamId);
    if (team == null) {
      throw new CliError(`Team '${teamId}' was not found on your account.`);
    }
    return team;
  }

  const teams = await source.listTeams({ limit: teamsPageSize, cursor: undefined });
  if (teams.length === 0) {
    if (options.createTeam != null) {
      if (isNonInteractiveEnv()) {
        throw new CliError("No teams found. Run `hexclave team create` first, or pass --team-id.");
      }
      const displayName = (await input({
        message: "Team display name:",
        validate: (value) => value.trim().length > 0 || "Display name cannot be empty.",
      })).trim();
      return await options.createTeam(displayName);
    }
    throw new CliError("No teams found. Run `hexclave team create` first.");
  }

  if (teams.length === 1) {
    return teams[0];
  }

  if (isNonInteractiveEnv()) {
    throw new CliError("--team-id is required in non-interactive environments (CI).");
  }

  // Only the first page is offered; a prompt with hundreds of entries isn't usable anyway.
  const selectedTeamId = await select({
    message: teams.nextCursor == null
      ? "Choose a team:"
      : `Choose a team (showing your first ${teams.length} teams; pass --team-id to use another):`,
    choices: teams.map((team) => ({
      name: `${team.displayName || "(unnamed)"} (${team.id})`,
      value: team.id,
    })),
  });
  const selectedTeam = teams.find((team) => team.id === selectedTeamId);
  if (selectedTeam == null) {
    throw new CliError("The selected team was not found.");
  }
  return selectedTeam;
}

/**
 * Pages through all of the user's teams. Only for commands whose output is the full list; anything that just needs
 * one team should use `getTeam` instead.
 */
export async function listAllTeams<T>(user: {
  listTeams: (options: { limit: number, cursor: string | undefined }) => Promise<T[] & { nextCursor: string | null }>,
}): Promise<T[]> {
  const teams: T[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page: T[] & { nextCursor: string | null } = await user.listTeams({ limit: teamsPageSize, cursor });
    teams.push(...page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor != null);
  return teams;
}
