import { KnownErrors } from "@hexclave/shared";
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
