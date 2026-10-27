import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "./errors.js";
import { listAllTeams, resolveTeam, type ResolveTeamItem } from "./resolve-team.js";

function makeTeam(id: string, displayName: string) {
  return { id, displayName };
}

/**
 * Mimics the SDK: `listTeams()` returns only the first `pageSize` teams with a `nextCursor`, while `getTeam` finds any
 * of the user's teams.
 */
function teamSource<T extends ResolveTeamItem>(teams: T[], pageSize = 200) {
  const page = (offset: number, limit: number) => Object.assign(teams.slice(offset, offset + limit), {
    nextCursor: offset + limit < teams.length ? teams[offset + limit - 1].id : null,
  });
  return {
    getTeam: vi.fn(async (teamId: string) => teams.find((team) => team.id === teamId) ?? null),
    listTeams: vi.fn(async (options?: { limit: number, cursor: string | undefined }) => {
      const offset = options?.cursor == null ? 0 : teams.findIndex((team) => team.id === options.cursor) + 1;
      return page(offset, Math.min(options?.limit ?? pageSize, pageSize));
    }),
  };
}

const savedCi = process.env.CI;
const savedGithubActions = process.env.GITHUB_ACTIONS;
const savedNoninteractive = process.env.NONINTERACTIVE;

afterEach(() => {
  if (savedCi === undefined) delete process.env.CI;
  else process.env.CI = savedCi;
  if (savedGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = savedGithubActions;
  if (savedNoninteractive === undefined) delete process.env.NONINTERACTIVE;
  else process.env.NONINTERACTIVE = savedNoninteractive;
});

describe("resolveTeam", () => {
  it("returns the explicitly requested team id", async () => {
    const teams = [makeTeam("team-1", "Acme"), makeTeam("team-2", "Beta")];

    await expect(resolveTeam(teamSource(teams), { teamId: "team-2" })).resolves.toBe(teams[1]);
  });

  it("finds an explicitly requested team that is past the first page", async () => {
    const teams = Array.from({ length: 5 }, (_, i) => makeTeam(`team-${i}`, `Team ${i}`));
    const source = teamSource(teams, 2);

    await expect(resolveTeam(source, { teamId: "team-4" })).resolves.toBe(teams[4]);
    expect(source.listTeams).not.toHaveBeenCalled();
  });

  it("throws when an explicit team id does not exist", async () => {
    const teams = [makeTeam("team-1", "Acme")];

    await expect(resolveTeam(teamSource(teams), { teamId: "missing-team" })).rejects.toSatisfy((error: unknown) => (
      error instanceof CliError && error.message === "Team 'missing-team' was not found on your account."
    ));
  });

  it("auto-picks the only team without prompting", async () => {
    const team = makeTeam("team-1", "Acme");

    await expect(resolveTeam(teamSource([team]))).resolves.toBe(team);
  });

  it("rejects multi-team resolution in non-interactive environments", async () => {
    process.env.CI = "1";

    await expect(resolveTeam(teamSource([makeTeam("team-1", "Acme"), makeTeam("team-2", "Beta")]))).rejects.toSatisfy((error: unknown) => (
      error instanceof CliError && error.message === "--team-id is required in non-interactive environments (CI)."
    ));
  });

  it("rejects zero-team resolution in non-interactive environments", async () => {
    process.env.CI = "1";

    await expect(resolveTeam(teamSource([]), { createTeam: async () => makeTeam("team-1", "Acme") })).rejects.toSatisfy((error: unknown) => (
      error instanceof CliError && error.message === "No teams found. Run `hexclave team create` first, or pass --team-id."
    ));
  });
});

describe("listAllTeams", () => {
  it("follows cursors until every team is loaded", async () => {
    const teams = Array.from({ length: 450 }, (_, i) => makeTeam(`team-${i}`, `Team ${i}`));
    const source = teamSource(teams);

    await expect(listAllTeams(source)).resolves.toEqual(teams);
    expect(source.listTeams.mock.calls.map(([options]) => options)).toMatchInlineSnapshot(`
      [
        {
          "cursor": undefined,
          "limit": 200,
        },
        {
          "cursor": "team-199",
          "limit": 200,
        },
        {
          "cursor": "team-399",
          "limit": 200,
        },
      ]
    `);
  });

  it("makes a single request when there are no teams", async () => {
    const source = teamSource([]);

    await expect(listAllTeams(source)).resolves.toEqual([]);
    expect(source.listTeams).toHaveBeenCalledTimes(1);
  });
});
