import * as jose from 'jose';
import { describe } from "vitest";
import { it } from "../helpers";
import { createApp } from "./js-helpers";

function decodeAccessToken(token: string) {
  return jose.decodeJwt(token);
}

describe("access token refresh on user property changes", () => {
  describe("displayName changes", () => {
    it("should return a new access token with updated name after setDisplayName", async ({ expect }) => {
      const { clientApp } = await createApp({
        config: {
          credentialEnabled: true,
        },
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      const user = await clientApp.getUser({ or: "throw" });
      const initialToken = await user.getAccessToken();
      const initialRefreshToken = await user.getRefreshToken();
      expect(initialToken).toBeDefined();
      expect(initialRefreshToken).toBeDefined(); // Must have refresh token for token refresh to work

      const initialPayload = decodeAccessToken(initialToken!);
      expect(initialPayload.name).toBeNull();

      // Update display name
      await user.setDisplayName("New Display Name");

      // Verify the display name was updated on the user object
      const userAfterUpdate = await clientApp.getUser({ or: "throw" });
      expect(userAfterUpdate.displayName).toBe("New Display Name");

      // Get a fresh access token - it should have the updated name claim
      const updatedToken = await userAfterUpdate.getAccessToken();
      expect(updatedToken).toBeDefined();

      const updatedPayload = decodeAccessToken(updatedToken!);
      expect(updatedPayload.name).toBe("New Display Name");

      // Token should be different from the initial one since name changed
      expect(updatedToken).not.toBe(initialToken);
    });

    it("should update access token when display name is set to null", async ({ expect }) => {
      const { clientApp } = await createApp({
        config: {
          credentialEnabled: true,
        },
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      const user = await clientApp.getUser({ or: "throw" });

      // Set initial display name
      await user.setDisplayName("Initial Name");

      const tokenWithName = await user.getAccessToken();
      expect(decodeAccessToken(tokenWithName!).name).toBe("Initial Name");

      // Set display name to null
      await user.setDisplayName(null);

      const tokenWithNullName = await user.getAccessToken();
      expect(decodeAccessToken(tokenWithNullName!).name).toBeNull();

      expect(tokenWithNullName).not.toBe(tokenWithName);
    });
  });

  describe("selectedTeam changes", () => {
    it("should return a new access token with updated selected_team_id after setSelectedTeam", async ({ expect }) => {
      const { clientApp, serverApp } = await createApp({
        config: {
          credentialEnabled: true,
          clientTeamCreationEnabled: true,
        },
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      const user = await clientApp.getUser({ or: "throw" });

      // Create a team
      const team = await user.createTeam({ displayName: "Test Team" });

      const initialToken = await user.getAccessToken();
      expect(initialToken).toBeDefined();

      const initialPayload = decodeAccessToken(initialToken!);
      // Initially selected team may be null or different
      const initialTeamId = initialPayload.selected_team_id;

      // Select the new team
      await user.setSelectedTeam(team);

      // Get a fresh access token
      const updatedToken = await user.getAccessToken();
      expect(updatedToken).toBeDefined();

      const updatedPayload = decodeAccessToken(updatedToken!);
      expect(updatedPayload.selected_team_id).toBe(team.id);

      // The token partial user exposes the same claim without a network request
      const partialUser = await clientApp.getPartialUser({ from: "token" });
      expect(partialUser?.selectedTeamId).toBe(team.id);

      // Token should be different if selected team changed
      if (initialTeamId !== team.id) {
        expect(updatedToken).not.toBe(initialToken);
      }
    });

    it("should update access token when setSelectedTeam is called with null", async ({ expect }) => {
      const { clientApp } = await createApp({
        config: {
          credentialEnabled: true,
          clientTeamCreationEnabled: true,
        },
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      const user = await clientApp.getUser({ or: "throw" });

      // Create and select a team
      const team = await user.createTeam({ displayName: "Test Team" });
      await user.setSelectedTeam(team);

      const tokenWithTeam = await user.getAccessToken();
      expect(decodeAccessToken(tokenWithTeam!).selected_team_id).toBe(team.id);

      // Set selected team to null
      await user.setSelectedTeam(null);

      const tokenWithNullTeam = await user.getAccessToken();
      expect(decodeAccessToken(tokenWithNullTeam!).selected_team_id).toBeNull();

      expect(tokenWithNullTeam).not.toBe(tokenWithTeam);
    });
  });

  describe("restrictedness changes", () => {
    it("should return a new access token with updated is_restricted after client-side email verification", async ({ expect }) => {
      const { clientApp, adminApp } = await createApp({
        config: {
          credentialEnabled: true,
        },
      });

      // Enable email verification requirement
      const project = await adminApp.getProject();
      await project.updateConfig({
        "onboarding.requireEmailVerification": true,
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      // Get restricted user
      const restrictedUser = await clientApp.getUser({ includeRestricted: true, or: "throw" });
      expect(restrictedUser.isRestricted).toBe(true);

      const restrictedToken = await restrictedUser.getAccessToken();
      expect(restrictedToken).toBeDefined();

      const restrictedPayload = decodeAccessToken(restrictedToken!);
      expect(restrictedPayload.is_restricted).toBe(true);
      expect(restrictedPayload.restricted_reason).toEqual({ type: "email_not_verified" });

      // Verify the email via admin app (simulating what would happen when user clicks verification link)
      const adminUsers = await adminApp.listUsers({ query: "test@example.com", includeRestricted: true });
      const adminContactChannels = await adminUsers[0].listContactChannels();
      const adminEmailChannel = adminContactChannels.find(c => c.value === "test@example.com");
      await adminEmailChannel!.update({ isVerified: true });

      // Trigger a token refresh by calling update (this is what happens in real flows
      // where the verification code handler calls update on the user)
      await restrictedUser.update({});

      // Get a fresh access token - the SAME user object's getAccessToken() should return updated tokens
      const nonRestrictedToken = await restrictedUser.getAccessToken();
      expect(nonRestrictedToken).toBeDefined();

      const nonRestrictedPayload = decodeAccessToken(nonRestrictedToken!);
      expect(nonRestrictedPayload.is_restricted).toBe(false);
      expect(nonRestrictedPayload.restricted_reason).toBeNull();

      // Token should be different
      expect(nonRestrictedToken).not.toBe(restrictedToken);
    });

    it("should update access token claims when user transitions from anonymous to authenticated", async ({ expect }) => {
      const { clientApp } = await createApp({
        config: {
          credentialEnabled: true,
        },
      });

      // Sign up anonymously using the { or: "anonymous" } option
      const anonUser = await clientApp.getUser({ or: "anonymous" });
      expect(anonUser.isAnonymous).toBe(true);

      const anonToken = await anonUser.getAccessToken();
      expect(anonToken).toBeDefined();

      const anonPayload = decodeAccessToken(anonToken!);
      expect(anonPayload.is_anonymous).toBe(true);
      expect(anonPayload.is_restricted).toBe(true);
      expect(anonPayload.restricted_reason).toEqual({ type: "anonymous" });

      // Upgrade anonymous user to authenticated
      await clientApp.signUpWithCredential({
        email: "upgraded@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      // Get a fresh access token
      const upgradedUser = await clientApp.getUser({ or: "throw" });
      expect(upgradedUser.isAnonymous).toBe(false);

      const upgradedToken = await upgradedUser.getAccessToken();
      expect(upgradedToken).toBeDefined();

      const upgradedPayload = decodeAccessToken(upgradedToken!);
      expect(upgradedPayload.is_anonymous).toBe(false);
      expect(upgradedPayload.is_restricted).toBe(false);
      expect(upgradedPayload.restricted_reason).toBeNull();

      // Token should be different
      expect(upgradedToken).not.toBe(anonToken);
    });
  });

  describe("requires_totp_mfa changes", () => {
    it("should have requires_totp_mfa=false for a new user without MFA", async ({ expect }) => {
      const { clientApp } = await createApp({
        config: {
          credentialEnabled: true,
        },
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      const user = await clientApp.getUser({ or: "throw" });
      const token = await user.getAccessToken();
      expect(token).toBeDefined();

      const payload = decodeAccessToken(token!);
      expect(payload.requires_totp_mfa).toBe(false);
    });

    it("should return a new access token with requires_totp_mfa=true after enabling TOTP MFA", async ({ expect }) => {
      const { clientApp } = await createApp({
        config: {
          credentialEnabled: true,
        },
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      const user = await clientApp.getUser({ or: "throw" });
      const initialToken = await user.getAccessToken();
      expect(decodeAccessToken(initialToken!).requires_totp_mfa).toBe(false);

      const totpSecret = crypto.getRandomValues(new Uint8Array(20));
      await user.update({ totpMultiFactorSecret: totpSecret });

      const updatedToken = await user.getAccessToken();
      expect(updatedToken).toBeDefined();

      const updatedPayload = decodeAccessToken(updatedToken!);
      expect(updatedPayload.requires_totp_mfa).toBe(true);

      expect(updatedToken).not.toBe(initialToken);
    });

    it("should return a new access token with requires_totp_mfa=false after disabling TOTP MFA", async ({ expect }) => {
      const { clientApp } = await createApp({
        config: {
          credentialEnabled: true,
        },
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      const user = await clientApp.getUser({ or: "throw" });

      const totpSecret = crypto.getRandomValues(new Uint8Array(20));
      await user.update({ totpMultiFactorSecret: totpSecret });

      const mfaEnabledToken = await user.getAccessToken();
      expect(decodeAccessToken(mfaEnabledToken!).requires_totp_mfa).toBe(true);

      await user.update({ totpMultiFactorSecret: null });

      const mfaDisabledToken = await user.getAccessToken();
      expect(mfaDisabledToken).toBeDefined();

      const disabledPayload = decodeAccessToken(mfaDisabledToken!);
      expect(disabledPayload.requires_totp_mfa).toBe(false);

      expect(mfaDisabledToken).not.toBe(mfaEnabledToken);
    });

    it("should update requires_totp_mfa in access token when admin enables MFA for a user", async ({ expect }) => {
      const { clientApp, adminApp } = await createApp({
        config: {
          credentialEnabled: true,
        },
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      const user = await clientApp.getUser({ or: "throw" });
      const initialToken = await user.getAccessToken();
      expect(decodeAccessToken(initialToken!).requires_totp_mfa).toBe(false);

      const adminUsers = await adminApp.listUsers({ query: "test@example.com" });
      const totpSecret = crypto.getRandomValues(new Uint8Array(20));
      await adminUsers[0].update({ totpMultiFactorSecret: totpSecret });

      await user.update({});

      const updatedToken = await user.getAccessToken();
      expect(updatedToken).toBeDefined();

      const updatedPayload = decodeAccessToken(updatedToken!);
      expect(updatedPayload.requires_totp_mfa).toBe(true);
    });
  });

  describe("signed_up_at claim", () => {
    it("should include signed_up_at and keep it stable across token refreshes", async ({ expect }) => {
      const { clientApp } = await createApp({
        config: {
          credentialEnabled: true,
        },
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      const user = await clientApp.getUser({ or: "throw" });
      const initialToken = await user.getAccessToken();
      expect(initialToken).toBeDefined();

      const initialPayload = decodeAccessToken(initialToken!);
      const signedUpAtSeconds = Math.floor(user.signedUpAt.getTime() / 1000);
      expect(initialPayload.signed_up_at).toBe(signedUpAtSeconds);

      await user.setDisplayName("Updated display name");

      const refreshedToken = await user.getAccessToken();
      expect(refreshedToken).toBeDefined();

      const refreshedPayload = decodeAccessToken(refreshedToken!);
      expect(refreshedPayload.signed_up_at).toBe(signedUpAtSeconds);
    });
  });

  describe("getAccessToken reflects current state", () => {
    it("should always return a token reflecting the current user state", async ({ expect }) => {
      const { clientApp, serverApp } = await createApp({
        config: {
          credentialEnabled: true,
          clientTeamCreationEnabled: true,
        },
      });

      await clientApp.signUpWithCredential({
        email: "test@example.com",
        password: "password123",
        noVerificationCallback: true,
      });

      const user = await clientApp.getUser({ or: "throw" });

      // Make multiple changes and verify each change is reflected in the token
      const changes = [
        { action: () => user.setDisplayName("Name 1"), check: (p: any) => p.name === "Name 1" },
        { action: () => user.setDisplayName("Name 2"), check: (p: any) => p.name === "Name 2" },
        { action: () => user.setDisplayName(null as any), check: (p: any) => p.name === null },
      ];

      for (const { action, check } of changes) {
        await action();
        const token = await user.getAccessToken();
        expect(token).toBeDefined();
        const payload = decodeAccessToken(token!);
        expect(check(payload)).toBe(true);
      }
    });
  });
});
