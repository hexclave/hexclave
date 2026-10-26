import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTeamCommand } from "./team.js";

type TestTeam = {
  id: string,
  displayName: string,
  listUsers: () => Promise<Array<{ id: string, teamProfile: { displayName: string | null } }>>,
  listInvitations: () => Promise<Array<{
    id: string,
    recipientEmail: string | null,
    expiresAt: Date,
    revoke: () => Promise<void>,
  }>>,
  removeUser: (userId: string) => Promise<void>,
  inviteUser: (options: { email: string }) => Promise<void>,
  update: (options: { displayName?: string }) => Promise<void>,
  delete: () => Promise<void>,
};

type TestUser = {
  getTeam: (teamId: string) => Promise<TestTeam | null>,
  listTeams: () => Promise<TestTeam[] & { nextCursor: string | null }>,
};

function createUser(teams: TestTeam[]) {
  return {
    getTeam: vi.fn(async (teamId: string) => teams.find((team) => team.id === teamId) ?? null),
    listTeams: vi.fn(async () => Object.assign([...teams], { nextCursor: null })),
  };
}

const mockState = vi.hoisted(() => ({
  user: null as TestUser | null,
}));

vi.mock("../lib/app.js", () => ({
  getInternalUser: vi.fn(async () => {
    if (mockState.user == null) {
      throw new Error("Expected test user to be configured.");
    }
    return mockState.user;
  }),
}));

vi.mock("../lib/auth.js", () => ({
  resolveSessionAuth: vi.fn(() => ({})),
}));

function createTeam(id: string, displayName: string): TestTeam {
  return {
    id,
    displayName,
    listUsers: vi.fn(async () => [{ id: "user-2", teamProfile: { displayName: "Member" } }]),
    listInvitations: vi.fn(async () => []),
    removeUser: vi.fn(async () => {}),
    inviteUser: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerTeamCommand(program);
  return program;
}

afterEach(() => {
  mockState.user = null;
  vi.restoreAllMocks();
});

describe("team command parsing", () => {
  it("parses the team id on members remove", async () => {
    const team = createTeam("team-1", "Acme");
    const user = createUser([team]);
    mockState.user = user;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node",
      "hexclave",
      "team",
      "members",
      "remove",
      "--team-id",
      "team-1",
      "--user-id",
      "user-2",
      "--yes",
    ]);

    expect(team.removeUser).toHaveBeenCalledWith("user-2");
    expect(user.getTeam).toHaveBeenCalledWith("team-1");
    expect(user.listTeams).not.toHaveBeenCalled();
    expect(logSpy.mock.calls).toMatchInlineSnapshot(`
      [
        [
          "Removed team member: user-2",
        ],
      ]
    `);
  });

  it("parses the team id on invitations list", async () => {
    const team = createTeam("team-1", "Acme");
    const user = createUser([team]);
    mockState.user = user;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await createProgram().parseAsync([
      "node",
      "hexclave",
      "team",
      "invitations",
      "list",
      "--team-id",
      "team-1",
    ]);

    expect(team.listInvitations).toHaveBeenCalledTimes(1);
    expect(user.listTeams).not.toHaveBeenCalled();
    expect(logSpy.mock.calls).toMatchInlineSnapshot(`
      [
        [
          "No invitations found.",
        ],
      ]
    `);
  });
});
