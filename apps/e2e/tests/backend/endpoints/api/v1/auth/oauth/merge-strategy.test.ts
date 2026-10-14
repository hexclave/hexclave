import { it, updateCookiesFromResponse } from "../../../../../../helpers";
import { Auth, ContactChannels, InternalApiKey, Project, backendContext, niceBackendFetch } from "../../../../../backend-helpers";

const getOAuthErrorRedirectLocationUrl = (location: string | null) => {
  if (location == null) {
    throw new Error("OAuth callback error redirect location is missing");
  }
  return new URL(location);
};

const expectOAuthErrorRedirect = (
  locationUrl: URL,
  { expectedErrorCode, expectedDescription }: { expectedErrorCode: string, expectedDescription: string },
  expectFn: (input: unknown) => { toBe: (value: unknown) => void },
) => {
  expectFn(locationUrl.origin).toBe("http://stack-test.localhost");
  expectFn(locationUrl.pathname).toBe("/some-callback-url");
  expectFn(locationUrl.searchParams.get("error")).toBe("server_error");
  expectFn(locationUrl.searchParams.get("errorCode")).toBe(expectedErrorCode);
  expectFn(locationUrl.searchParams.get("error_description")).toBe(expectedDescription);
  expectFn(locationUrl.searchParams.get("message")).toBe(expectedDescription);
};

it("should allow duplicates, if the merge strategy is set to allow_duplicates", async ({ expect }) => {
  const proj = await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
      oauth_account_merge_strategy: "allow_duplicates",
      oauth_providers: [{
        id: "spotify",
        type: "shared",
      }],
    }
  });
  await InternalApiKey.createAndSetProjectKeys(proj.adminAccessToken);

  await Auth.Otp.signIn();
  const cc = await ContactChannels.getTheOnlyContactChannel();
  expect(cc.is_verified).toBe(true);
  expect(cc.used_for_auth).toBe(true);

  await Auth.OAuth.signIn();
  const cc2 = await ContactChannels.getTheOnlyContactChannel();
  expect(cc2.value).toBe(cc.value);
  expect(cc2.is_verified).toBe(true);
  expect(cc2.used_for_auth).toBe(false);

  expect(cc.id).not.toBe(cc2.id);
});

it("should not allow duplicates, if the merge strategy set to raise_error", async ({ expect }) => {
  const proj = await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
      oauth_account_merge_strategy: "raise_error",
      oauth_providers: [{
        id: "spotify",
        type: "shared",
      }],
    }
  });
  await InternalApiKey.createAndSetProjectKeys(proj.adminAccessToken);

  await Auth.Otp.signIn();
  const cc = await ContactChannels.getTheOnlyContactChannel();
  expect(cc.is_verified).toBe(true);
  expect(cc.used_for_auth).toBe(true);

  const { response } = await Auth.OAuth.getMaybeFailingAuthorizationCode();
  expect(response.status).toBe(307);
  const locationUrl = getOAuthErrorRedirectLocationUrl(response.headers.get("location"));
  expectOAuthErrorRedirect(locationUrl, {
    expectedErrorCode: "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
    expectedDescription: `This email "(${cc.value})" is already used for authentication by another account.`,
  }, expect);
  expect(response.headers.get("set-cookie")).toMatch(/stack-oauth-inner-/);
});

it("should merge accounts, if the merge strategy set to link_method", async ({ expect }) => {
  const proj = await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
      oauth_account_merge_strategy: "link_method",
      oauth_providers: [{
        id: "spotify",
        type: "shared",
      }],
    }
  });
  await InternalApiKey.createAndSetProjectKeys(proj.adminAccessToken);

  await Auth.Otp.signIn();
  const cc = await ContactChannels.getTheOnlyContactChannel();
  expect(cc.is_verified).toBe(true);
  expect(cc.used_for_auth).toBe(true);

  await Auth.OAuth.signIn();
  const cc2 = await ContactChannels.getTheOnlyContactChannel();
  expect(cc2.value).toBe(cc.value);
  expect(cc2.is_verified).toBe(true);
  expect(cc2.used_for_auth).toBe(true);

  expect(cc.id).toBe(cc2.id);
});

it("should not merge accounts if the merge strategy is set to link_method, but the old account was not verified", async ({ expect }) => {
  const proj = await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
      oauth_account_merge_strategy: "link_method",
      oauth_providers: [{
        id: "spotify",
        type: "shared",
      }],
    }
  });
  await InternalApiKey.createAndSetProjectKeys(proj.adminAccessToken);

  await Auth.Password.signUpWithEmail();
  const cc = await ContactChannels.getTheOnlyContactChannel();
  expect(cc.is_verified).toBe(false);
  expect(cc.used_for_auth).toBe(true);

  const { response } = await Auth.OAuth.getMaybeFailingAuthorizationCode();
  expect(response.status).toBe(307);
  const locationUrl = getOAuthErrorRedirectLocationUrl(response.headers.get("location"));
  expectOAuthErrorRedirect(locationUrl, {
    expectedErrorCode: "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
    expectedDescription: `This email "(${cc.value})" is already used for authentication by another account but the email is not verified. Please login to your existing account with the method you used to sign up, and then verify your email to sign in with this login method.`,
  }, expect);
  expect(response.headers.get("set-cookie")).toMatch(/stack-oauth-inner-/);
});

it("should allow OAuth login with manually created account when sign-ups are disabled", async ({ expect }) => {
  // Create a project with sign-ups disabled and OAuth provider configured
  const proj = await Project.createAndSwitch({
    config: {
      sign_up_enabled: false,
      oauth_account_merge_strategy: "link_method",
      oauth_providers: [{
        id: "spotify",
        type: "shared",
      }],
    },
  });
  await InternalApiKey.createAndSetProjectKeys(proj.adminAccessToken);

  // Get the default mailbox email that will be used by mock OAuth
  const spotifyMockEmail = backendContext.value.mailbox.emailAddress;

  // Manually create a user account with that email address with auth enabled
  const createUserResponse = await niceBackendFetch("/api/v1/users", {
    method: "POST",
    accessType: "admin",
    body: {
      primary_email: spotifyMockEmail,
      primary_email_verified: true,
      primary_email_auth_enabled: true,
      display_name: "Manual User",
    },
  });

  expect(createUserResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "auth_with_email": false,
        "client_metadata": null,
        "client_read_only_metadata": null,
        "country_code": null,
        "display_name": "Manual User",
        "external_auth_providers": [],
        "has_password": false,
        "id": "<stripped UUID>",
        "is_anonymous": false,
        "is_restricted": false,
        "last_active_at_millis": <stripped field 'last_active_at_millis'>,
        "oauth_providers": [],
        "otp_auth_enabled": false,
        "passkey_auth_enabled": false,
        "primary_email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
        "primary_email_auth_enabled": true,
        "primary_email_verified": true,
        "profile_image_url": null,
        "requires_totp_mfa": false,
        "restricted_by_admin": false,
        "restricted_by_admin_private_details": null,
        "restricted_by_admin_reason": null,
        "restricted_reason": null,
        "risk_scores": {
          "sign_up": {
            "bot": 0,
            "free_trial_abuse": 0,
          },
        },
        "selected_team": null,
        "selected_team_id": null,
        "server_metadata": null,
        "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const createdUserId = createUserResponse.body.id;

  // Now try to sign in via OAuth with the same email
  // This should succeed even though sign-ups are disabled
  // because we're linking to an existing account with matching email
  const { authorizeResponse, innerCallbackUrl } = await Auth.OAuth.getInnerCallbackUrl();
  const cookie = updateCookiesFromResponse("", authorizeResponse);

  const oauthCallbackResponse = await niceBackendFetch(innerCallbackUrl.toString(), {
    redirect: "manual",
    headers: {
      cookie,
    },
  });

  const { tokenResponse } = await Auth.OAuth.signIn();
  expect(tokenResponse.body.is_new_user).toBe(false);

  const getUserResponse = await niceBackendFetch(`/api/v1/users/${createdUserId}`, {
    method: "GET",
    accessType: "admin",
  });
  expect(getUserResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "auth_with_email": false,
        "client_metadata": null,
        "client_read_only_metadata": null,
        "country_code": null,
        "display_name": "Manual User",
        "external_auth_providers": [],
        "has_password": false,
        "id": "<stripped UUID>",
        "is_anonymous": false,
        "is_restricted": false,
        "last_active_at_millis": <stripped field 'last_active_at_millis'>,
        "oauth_providers": [
          {
            "account_id": "default-mailbox--<stripped UUID>@stack-generated.example.com",
            "email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
            "id": "spotify",
          },
        ],
        "otp_auth_enabled": false,
        "passkey_auth_enabled": false,
        "primary_email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
        "primary_email_auth_enabled": true,
        "primary_email_verified": true,
        "profile_image_url": null,
        "requires_totp_mfa": false,
        "restricted_by_admin": false,
        "restricted_by_admin_private_details": null,
        "restricted_by_admin_reason": null,
        "restricted_reason": null,
        "risk_scores": {
          "sign_up": {
            "bot": 0,
            "free_trial_abuse": 0,
          },
        },
        "selected_team": null,
        "selected_team_id": null,
        "server_metadata": null,
        "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});
