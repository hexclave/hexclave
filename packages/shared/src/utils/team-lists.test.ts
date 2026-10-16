import { afterEach, describe, expect, it, vi } from "vitest";
import { findTeamsWithProducts, listAllTeams, type TeamList, type TeamPageRequest } from "./team-lists";

type FakeTeam = {
  id: string,
  listProducts: (options: { limit: number }) => Promise<{ customerType: string }[]>,
};

function createFakeUser(total: number, options: { adminTeamIds?: Set<string>, teamIdsWithProducts?: Set<string> } = {}) {
  const all: FakeTeam[] = Array.from({ length: total }, (_, i) => {
    const id = `team-${String(i).padStart(4, "0")}`;
    return {
      id,
      listProducts: vi.fn(async () => options.teamIdsWithProducts?.has(id) ? [{ customerType: "team" }] : []),
    };
  });
  const page = (cursor: string | undefined): TeamList<FakeTeam> => {
    const start = cursor == null ? 0 : all.findIndex(team => team.id === cursor) + 1;
    const items = all.slice(start, start + 200);
    return Object.assign(items, { nextCursor: start + 200 < all.length ? items[items.length - 1].id : null });
  };
  const listTeams = vi.fn(async (request: TeamPageRequest) => page(request.cursor));
  const hasPermission = vi.fn(async (team: FakeTeam, permissionId: string) => {
    expect(permissionId).toBe("team_admin");
    return options.adminTeamIds?.has(team.id) ?? true;
  });
  return { user: { listTeams, hasPermission }, all, firstPage: page(undefined) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listAllTeams", () => {
  it("follows the cursor from the given first page until the end", async () => {
    const { user, firstPage } = createFakeUser(450);
    const teams = await listAllTeams(user, firstPage);
    expect(teams).toHaveLength(450);
    expect(new Set(teams.map(team => team.id)).size).toBe(450);
    expect(user.listTeams.mock.calls.map(([request]) => request)).toEqual([
      { limit: 200, cursor: "team-0199" },
      { limit: 200, cursor: "team-0399" },
    ]);
  });

  it("makes no requests when the first page is the only one", async () => {
    const { user, firstPage } = createFakeUser(200);
    expect(await listAllTeams(user, firstPage)).toHaveLength(200);
    expect(user.listTeams).not.toHaveBeenCalled();
  });

  it("propagates a failed page instead of returning a partial list", async () => {
    const { user, firstPage } = createFakeUser(450);
    user.listTeams.mockRejectedValueOnce(new Error("network down"));
    await expect(listAllTeams(user, firstPage)).rejects.toThrow("network down");
  });
});

describe("findTeamsWithProducts", () => {
  it("finds admin teams with products on every page, not just the first", async () => {
    const { user, firstPage } = createFakeUser(450, {
      adminTeamIds: new Set(["team-0010", "team-0300", "team-0449", "team-0400"]),
      teamIdsWithProducts: new Set(["team-0010", "team-0300", "team-0449", "team-0420"]),
    });
    const teams = await findTeamsWithProducts(user, firstPage);
    // team-0400 is an admin team without products; team-0420 has products but the user isn't an admin there.
    expect(teams.map(team => team.id)).toEqual(["team-0010", "team-0300", "team-0449"]);
  });

  it("only lists products of teams the user administers", async () => {
    const { user, firstPage, all } = createFakeUser(3, { adminTeamIds: new Set(["team-0001"]) });
    await findTeamsWithProducts(user, firstPage);
    expect(all[0].listProducts).not.toHaveBeenCalled();
    expect(all[1].listProducts).toHaveBeenCalledWith({ limit: 1 });
    expect(all[2].listProducts).not.toHaveBeenCalled();
  });

  it("never has more than 10 team checks in flight", async () => {
    const { user, firstPage } = createFakeUser(450);
    let inFlight = 0;
    let maxInFlight = 0;
    user.hasPermission.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 0));
      inFlight--;
      return false;
    });
    await findTeamsWithProducts(user, firstPage);
    expect(user.hasPermission).toHaveBeenCalledTimes(450);
    expect(maxInFlight).toBe(10);
  });

  it("falls back to the first page (and reports the error) when a later page fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { user, firstPage } = createFakeUser(450, { teamIdsWithProducts: new Set(["team-0005", "team-0300"]) });
    user.listTeams.mockRejectedValueOnce(new Error("network down"));
    const teams = await findTeamsWithProducts(user, firstPage);
    expect(teams.map(team => team.id)).toEqual(["team-0005"]);
    expect(user.hasPermission).toHaveBeenCalledTimes(200);
    expect(consoleError).toHaveBeenCalled();
  });

  it("propagates a failed permission check instead of silently dropping the team", async () => {
    const { user, firstPage } = createFakeUser(5);
    user.hasPermission.mockRejectedValueOnce(new Error("permission check failed"));
    await expect(findTeamsWithProducts(user, firstPage)).rejects.toThrow("permission check failed");
  });
});
