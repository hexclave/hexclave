import { KnownErrors } from "@hexclave/shared";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { it } from "../helpers";
import { createApp } from "./js-helpers";

it("allows a client team member with permission to remove another member", { timeout: 60_000 }, async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({ config: { clientTeamCreationEnabled: true } });

  await clientApp.signUpWithCredential({
    email: "membership-owner@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  await clientApp.signInWithCredential({
    email: "membership-owner@test.com",
    password: "password",
  });
  const owner = await clientApp.getUser({ or: "throw" });
  const team = await owner.createTeam({ displayName: "Membership Team" });

  await clientApp.signUpWithCredential({
    email: "membership-member@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  const member = await clientApp.getUser({ or: "throw" });
  const serverTeam = await serverApp.getTeam(team.id);
  if (!serverTeam) throw new Error("Team not found on server");
  await serverTeam.addUser(member.id);

  await clientApp.signInWithCredential({
    email: "membership-owner@test.com",
    password: "password",
  });
  const ownerAgain = await clientApp.getUser({ or: "throw" });
  const clientTeam = await ownerAgain.getTeam(team.id);
  if (!clientTeam) throw new Error("Team not found for client user");

  await clientTeam.removeUser(member.id);

  const remainingMembers = await serverTeam.listUsers();
  expect(remainingMembers.some((teamMember) => teamMember.id === member.id)).toBe(false);
});

it("rejects client team member removal without the remove-members permission", { timeout: 60_000 }, async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({ config: { clientTeamCreationEnabled: true } });

  await clientApp.signUpWithCredential({
    email: "membership-owner-no-permission@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  await clientApp.signInWithCredential({
    email: "membership-owner-no-permission@test.com",
    password: "password",
  });
  const owner = await clientApp.getUser({ or: "throw" });
  const team = await owner.createTeam({ displayName: "Permission Team" });

  await clientApp.signUpWithCredential({
    email: "membership-member-no-permission@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  const member = await clientApp.getUser({ or: "throw" });
  const serverTeam = await serverApp.getTeam(team.id);
  if (!serverTeam) throw new Error("Team not found on server");
  await serverTeam.addUser(member.id);

  const memberTeam = await member.getTeam(team.id);
  if (!memberTeam) throw new Error("Team not found for client member");
  await expect(memberTeam.removeUser(owner.id)).rejects.toSatisfy((error: unknown) => (
    KnownErrors.TeamPermissionRequired.isInstance(error)
  ));
});

it("refreshes the current user after removing themselves from a team", { timeout: 60_000 }, async ({ expect }) => {
  const { clientApp } = await createApp({ config: { clientTeamCreationEnabled: true } });

  await clientApp.signUpWithCredential({
    email: "membership-leave@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  const user = await clientApp.getUser({ or: "throw" });
  const team = await user.createTeam({ displayName: "Leave Team" });
  const userWithTeam = await clientApp.getUser({ or: "throw" });

  expect((await userWithTeam.listTeams()).some((candidate) => candidate.id === team.id)).toBe(true);
  expect(userWithTeam.selectedTeam?.id).toBe(team.id);

  const clientTeam = await userWithTeam.getTeam(team.id);
  if (!clientTeam) throw new Error("Team not found for client user");
  await clientTeam.removeUser(userWithTeam.id);

  expect((await userWithTeam.listTeams()).some((candidate) => candidate.id === team.id)).toBe(false);
  const refreshedUser = await clientApp.getUser({ or: "throw" });
  expect(refreshedUser.selectedTeam).toBeNull();
});

it("refreshes the current user after leaving a team", { timeout: 60_000 }, async ({ expect }) => {
  const { clientApp } = await createApp({ config: { clientTeamCreationEnabled: true } });

  await clientApp.signUpWithCredential({
    email: "membership-leave-team@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  const user = await clientApp.getUser({ or: "throw" });
  const team = await user.createTeam({ displayName: "Leave Team" });
  const userWithTeam = await clientApp.getUser({ or: "throw" });

  await userWithTeam.leaveTeam(team);

  expect((await userWithTeam.listTeams()).some((candidate) => candidate.id === team.id)).toBe(false);
  const refreshedUser = await clientApp.getUser({ or: "throw" });
  expect(refreshedUser.selectedTeam).toBeNull();
});

it("returns null from getTeam after leaving the team", { timeout: 60_000 }, async ({ expect }) => {
  const { clientApp } = await createApp({ config: { clientTeamCreationEnabled: true } });

  await clientApp.signUpWithCredential({
    email: "membership-get-team-after-leave@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  const user = await clientApp.getUser({ or: "throw" });
  const team = await user.createTeam({ displayName: "Leave Team" });

  expect((await user.getTeam(team.id))?.id).toBe(team.id);
  await user.leaveTeam(team);
  expect(await user.getTeam(team.id)).toBeNull();
});

it("paginates and searches the current user's teams on the client", { timeout: 60_000 }, async ({ expect }) => {
  const { clientApp } = await createApp({ config: { clientTeamCreationEnabled: true } });

  await clientApp.signUpWithCredential({
    email: "membership-paginate-teams@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  const user = await clientApp.getUser({ or: "throw" });
  const created = [];
  for (const displayName of ["Alpha", "Beta", "Gamma"]) {
    created.push(await user.createTeam({ displayName }));
  }

  const all = await user.listTeams();
  expect(all.map((team) => team.displayName)).toEqual(["Alpha", "Beta", "Gamma"]);
  expect(all.nextCursor).toBeNull();

  const page1 = await user.listTeams({ limit: 2 });
  expect(page1.map((team) => team.displayName)).toEqual(["Alpha", "Beta"]);
  expect(page1.nextCursor).toMatch(new RegExp(`_${created[1].id}$`));
  const page2 = await user.listTeams({ limit: 2, cursor: page1.nextCursor ?? throwErr("expected a next cursor") });
  expect(page2.map((team) => team.displayName)).toEqual(["Gamma"]);
  expect(page2.nextCursor).toBeNull();

  // The cursor encodes a position, so the next page can still be loaded (and refreshed) after its anchor team is gone.
  await created[1].delete();
  await created[2].update({ displayName: "Gamma renamed" });
  const page2AfterDelete = await user.listTeams({ limit: 2, cursor: page1.nextCursor ?? throwErr("expected a next cursor") });
  expect(page2AfterDelete.map((team) => team.displayName)).toEqual(["Gamma renamed"]);

  const newestFirst = await user.listTeams({ orderBy: "createdAt", desc: true });
  expect(newestFirst.map((team) => team.displayName)).toEqual(["Gamma renamed", "Alpha"]);

  const searched = await user.listTeams({ query: "amm" });
  expect(searched.map((team) => team.displayName)).toEqual(["Gamma renamed"]);
});

it("finds a user's team with getTeam even when the user is in more than 200 teams", { timeout: 300_000 }, async ({ expect }) => {
  const { clientApp, serverApp } = await createApp();

  await clientApp.signUpWithCredential({
    email: "membership-many-teams@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  const user = await clientApp.getUser({ or: "throw" });

  const teams = [];
  for (let batchStart = 0; batchStart < 201; batchStart += 20) {
    teams.push(...await Promise.all(Array.from({ length: Math.min(20, 201 - batchStart) }, () => serverApp.createTeam({
      displayName: "Many Teams",
      creatorUserId: user.id,
    }))));
  }
  const newestTeam = teams[teams.length - 1];

  // Without a limit, the backend returns every team unpaginated (up to 500).
  const listedTeams = await user.listTeams();
  expect(listedTeams).toHaveLength(201);
  expect(listedTeams.nextCursor).toBeNull();

  // Explicit pages of 200 still lead to the newest team through the cursor.
  const firstPage = await user.listTeams({ limit: 200 });
  expect(firstPage).toHaveLength(200);
  expect(firstPage.some((team) => team.id === newestTeam.id)).toBe(false);
  expect(firstPage.nextCursor).toMatch(new RegExp(`_${firstPage[199].id}$`));
  const nextPage = await user.listTeams({ limit: 200, cursor: firstPage.nextCursor ?? throwErr("expected a next cursor") });
  expect(nextPage.map((team) => team.id)).toEqual([newestTeam.id]);
  expect(nextPage.nextCursor).toBeNull();

  expect((await user.getTeam(newestTeam.id))?.id).toBe(newestTeam.id);
  const serverUser = await serverApp.getUser(user.id);
  if (!serverUser) throw new Error("User not found on server");
  expect((await serverUser.getTeam(newestTeam.id))?.id).toBe(newestTeam.id);

  // Still a membership check: a team the user isn't in resolves to null.
  const otherTeam = await serverApp.createTeam({ displayName: "Not My Team" });
  expect(await user.getTeam(otherTeam.id)).toBeNull();
  expect(await serverUser.getTeam(otherTeam.id)).toBeNull();
});

it("exposes the selected team of a server user as a server team", { timeout: 60_000 }, async ({ expect }) => {
  const { clientApp, serverApp } = await createApp({ config: { clientTeamCreationEnabled: true } });

  await clientApp.signUpWithCredential({
    email: "membership-server-selected-team@test.com",
    password: "password",
    noVerificationCallback: true,
  });
  const user = await clientApp.getUser({ or: "throw" });
  const team = await user.createTeam({ displayName: "Server Selected Team" });

  const serverUser = await serverApp.getUser(user.id);
  if (!serverUser?.selectedTeam) throw new Error("Selected team not found on server user");
  expect(serverUser.selectedTeam.id).toBe(team.id);
  expect(serverUser.selectedTeam.createdAt).toBeInstanceOf(Date);

  // Server-only member details are available without fetching the team again
  const members = await serverUser.selectedTeam.listUsers();
  expect(members.map((member) => member.primaryEmail)).toEqual(["membership-server-selected-team@test.com"]);
});
