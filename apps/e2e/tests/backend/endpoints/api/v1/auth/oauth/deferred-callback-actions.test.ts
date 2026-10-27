import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { expect } from "vitest";
import { it, localRedirectUrl } from "../../../../../../helpers";
import { Auth, Project, backendContext, niceBackendFetch } from "../../../../../backend-helpers";

// The OAuth provider leg (/authorize -> provider -> /callback) isn't bound to a browser, so whoever completes it
// at the provider may not be whoever started it with their `token`. Linking a provider account to the token's
// user, or upgrading the token's anonymous user, must therefore only happen once the authorization code is
// redeemed with the PKCE verifier of the flow's initiator — never in /callback itself.

const redeemAuthorizationCode = async (authorizationCode: string, codeVerifier: string) => {
  const projectKeys = backendContext.value.projectKeys;
  if (projectKeys === "no-project") throw new Error("No project keys found in the backend context");
  return await niceBackendFetch("/api/v1/auth/oauth/token", {
    method: "POST",
    accessType: "client",
    body: {
      client_id: projectKeys.projectId,
      client_secret: projectKeys.publishableClientKey,
      code: authorizationCode,
      redirect_uri: localRedirectUrl,
      code_verifier: codeVerifier,
      grant_type: "authorization_code",
    },
  });
};

const getMe = async (accessToken: string) => {
  const response = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": accessToken,
    },
  });
  expect(response.status).toBe(200);
  return response.body;
};

it("link flow does not link the provider account until the authorization code is redeemed with the initiator's PKCE verifier", async ({ expect }) => {
  const { userId } = await Auth.Password.signUpWithEmail();
  const userAccessToken = backendContext.value.userAuth?.accessToken ?? throwErr("Expected the backend context to contain an access token after signing up");

  const { authorizationCode } = await Auth.OAuth.getAuthorizationCode({ type: "link" });

  // The callback succeeded, but whoever completed the provider leg hasn't proven they started the flow yet
  expect((await getMe(userAccessToken)).oauth_providers).toEqual([]);

  const wrongVerifierResponse = await redeemAuthorizationCode(authorizationCode, "not-the-initiators-code-verifier");
  expect(wrongVerifierResponse.status).toBe(400);
  expect(wrongVerifierResponse.body.code).toBe("INVALID_AUTHORIZATION_CODE");
  expect((await getMe(userAccessToken)).oauth_providers).toEqual([]);

  const tokenResponse = await redeemAuthorizationCode(authorizationCode, Auth.OAuth.testCodeVerifier);
  expect(tokenResponse.status).toBe(200);
  const me = await getMe(tokenResponse.body.access_token);
  expect(me.id).toBe(userId);
  expect(me.oauth_providers).toEqual([expect.objectContaining({ id: "spotify" })]);

  // The provider tokens were stored on the linked account, so it works as a connected account
  const connectedAccountTokenResponse = await niceBackendFetch("/api/v1/connected-accounts/me/spotify/access-token", {
    method: "POST",
    accessType: "client",
    headers: {
      "x-stack-access-token": tokenResponse.body.access_token,
    },
    body: {
      scope: "openid",
    },
  });
  expect(connectedAccountTokenResponse.status).toBe(201);

  // Codes are single-use, so the link can't be applied twice
  const replayResponse = await redeemAuthorizationCode(authorizationCode, Auth.OAuth.testCodeVerifier);
  expect(replayResponse.status).toBe(400);
  expect(replayResponse.body.code).toBe("INVALID_AUTHORIZATION_CODE");
});

it("anonymous upgrade via OAuth is not applied until the authorization code is redeemed with the initiator's PKCE verifier", async ({ expect }) => {
  const { userId: anonUserId, accessToken: anonAccessToken } = await Auth.Anonymous.signUp();

  const { authorizationCode } = await Auth.OAuth.getAuthorizationCode();

  const beforeRedeem = await getMe(anonAccessToken);
  expect(beforeRedeem.is_anonymous).toBe(true);
  expect(beforeRedeem.oauth_providers).toEqual([]);
  expect(beforeRedeem.primary_email).toBeNull();

  const wrongVerifierResponse = await redeemAuthorizationCode(authorizationCode, "not-the-initiators-code-verifier");
  expect(wrongVerifierResponse.status).toBe(400);
  expect(wrongVerifierResponse.body.code).toBe("INVALID_AUTHORIZATION_CODE");
  expect((await getMe(anonAccessToken)).is_anonymous).toBe(true);

  const tokenResponse = await redeemAuthorizationCode(authorizationCode, Auth.OAuth.testCodeVerifier);
  expect(tokenResponse.status).toBe(200);
  expect(tokenResponse.body.is_new_user).toBe(true);

  // The freshly issued access token must already reflect the upgrade
  const me = await getMe(tokenResponse.body.access_token);
  expect(me.id).toBe(anonUserId);
  expect(me.is_anonymous).toBe(false);
  expect(me.primary_email).toBe(backendContext.value.mailbox.emailAddress);
  expect(me.oauth_providers).toEqual([expect.objectContaining({ id: "spotify" })]);
});

it("anonymous upgrade via OAuth is rejected by sign-up rules in /callback (with the error redirect), not on redeem", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      oauth_providers: [{ id: "spotify", type: "shared" }],
    },
  });
  await Project.updateConfig({
    "auth.signUpRules.block-oauth": {
      enabled: true,
      displayName: "Block OAuth signups",
      priority: 0,
      condition: 'authMethod == "oauth"',
      action: {
        type: "reject",
        message: "OAuth signups are not allowed",
      },
    },
    "auth.signUpRulesDefaultAction": "allow",
  });
  const { accessToken: anonAccessToken } = await Auth.Anonymous.signUp();

  // SDKs can't surface errors from the code exchange properly, so the rejection must be the callback's error
  // redirect, like for a non-anonymous OAuth sign-up
  const { response } = await Auth.OAuth.getMaybeFailingAuthorizationCode();
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get("location") ?? throwErr("Expected the OAuth callback to redirect"));
  expect(location.searchParams.get("errorCode")).toBe("SIGN_UP_REJECTED");
  expect(location.searchParams.get("code")).toBeNull();

  const me = await getMe(anonAccessToken);
  expect(me.is_anonymous).toBe(true);
  expect(me.oauth_providers).toEqual([]);
});

it("anonymous upgrade via OAuth applies the restriction of a sign-up rule evaluated in /callback on redeem", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      oauth_providers: [{ id: "spotify", type: "shared" }],
    },
  });
  await Project.updateConfig({
    "auth.signUpRules.restrict-oauth": {
      enabled: true,
      displayName: "Restrict OAuth signups",
      priority: 0,
      condition: 'authMethod == "oauth"',
      action: {
        type: "restrict",
      },
    },
    "auth.signUpRulesDefaultAction": "allow",
  });
  const { userId: anonUserId } = await Auth.Anonymous.signUp();

  const { authorizationCode } = await Auth.OAuth.getAuthorizationCode();
  const tokenResponse = await redeemAuthorizationCode(authorizationCode, Auth.OAuth.testCodeVerifier);
  expect(tokenResponse.status).toBe(200);

  const userResponse = await niceBackendFetch(urlString`/api/v1/users/${anonUserId}`, { accessType: "admin" });
  expect(userResponse.status).toBe(200);
  expect(userResponse.body.is_anonymous).toBe(false);
  expect(userResponse.body.restricted_by_admin).toBe(true);
  expect(userResponse.body.restricted_by_admin_private_details).toContain("restrict-oauth");
  expect(userResponse.body.oauth_providers).toEqual([expect.objectContaining({ id: "spotify" })]);
});

it("anonymous upgrade via OAuth fails on redeem if the anonymous user was upgraded in the meantime", async ({ expect }) => {
  await Auth.Anonymous.signUp();

  const { authorizationCode } = await Auth.OAuth.getAuthorizationCode();

  // Upgrade the same anonymous user through another method before the OAuth code is redeemed
  await Auth.Password.signUpWithEmail();

  const tokenResponse = await redeemAuthorizationCode(authorizationCode, Auth.OAuth.testCodeVerifier);
  expect(tokenResponse.status).toBe(409);
});
