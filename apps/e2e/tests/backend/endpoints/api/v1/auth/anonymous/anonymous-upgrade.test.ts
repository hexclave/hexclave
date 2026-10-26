import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { it } from "../../../../../../helpers";
import { Auth, Project, backendContext, bumpEmailAddress, niceBackendFetch } from "../../../../../backend-helpers";

it("anonymous user can upgrade to regular user via password sign-up", async ({ expect }) => {
  await Project.createAndSwitch();

  // Create an anonymous user
  const anonSignUp = await Auth.Anonymous.signUp();
  const anonUserId = anonSignUp.userId;
  const anonAccessToken = anonSignUp.accessToken;

  // Verify the user is anonymous
  const anonMeRes = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": anonAccessToken,
    },
  });
  expect(anonMeRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "auth_with_email": false,
        "client_metadata": null,
        "client_read_only_metadata": null,
        "display_name": null,
        "external_auth_providers": [],
        "has_password": false,
        "id": "<stripped UUID>",
        "is_anonymous": true,
        "is_restricted": true,
        "oauth_providers": [],
        "otp_auth_enabled": false,
        "passkey_auth_enabled": false,
        "primary_email": null,
        "primary_email_verified": false,
        "profile_image_url": null,
        "requires_totp_mfa": false,
        "restricted_by_admin": false,
        "restricted_by_admin_reason": null,
        "restricted_reason": { "type": "anonymous" },
        "selected_team": null,
        "selected_team_id": null,
        "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Upgrade the user via password sign-up while logged in as anonymous
  const { signUpResponse: upgradeRes } = await Auth.Password.signUpWithEmail();

  expect(upgradeRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "access_token": <stripped field 'access_token'>,
        "refresh_token": <stripped field 'refresh_token'>,
        "user_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(upgradeRes.body.user_id).toBe(anonUserId);

  // Verify the user is no longer anonymous
  const upgradedMeRes = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": upgradeRes.body.access_token,
    },
  });
  expect(upgradedMeRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "auth_with_email": true,
        "client_metadata": null,
        "client_read_only_metadata": null,
        "display_name": null,
        "external_auth_providers": [],
        "has_password": true,
        "id": "<stripped UUID>",
        "is_anonymous": false,
        "is_restricted": false,
        "oauth_providers": [],
        "otp_auth_enabled": false,
        "passkey_auth_enabled": false,
        "primary_email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
        "primary_email_verified": false,
        "profile_image_url": null,
        "requires_totp_mfa": false,
        "restricted_by_admin": false,
        "restricted_by_admin_reason": null,
        "restricted_reason": null,
        "selected_team": null,
        "selected_team_id": null,
        "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  // Anonymous users already have a signup timestamp; upgrading should keep it
  // valid and must not move it backwards.
  expect(anonMeRes.body.signed_up_at_millis).toBeGreaterThan(0);
  expect(upgradedMeRes.body.signed_up_at_millis).toBeGreaterThanOrEqual(anonMeRes.body.signed_up_at_millis);

  // Old anonymous token should still work
  backendContext.set({
    userAuth: null,
  });
  const oldTokenRes = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": anonAccessToken,
    },
  });
  expect(oldTokenRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "auth_with_email": true,
        "client_metadata": null,
        "client_read_only_metadata": null,
        "display_name": null,
        "external_auth_providers": [],
        "has_password": true,
        "id": "<stripped UUID>",
        "is_anonymous": false,
        "is_restricted": false,
        "oauth_providers": [],
        "otp_auth_enabled": false,
        "passkey_auth_enabled": false,
        "primary_email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
        "primary_email_verified": false,
        "profile_image_url": null,
        "requires_totp_mfa": false,
        "restricted_by_admin": false,
        "restricted_by_admin_reason": null,
        "restricted_reason": null,
        "selected_team": null,
        "selected_team_id": null,
        "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("non-anonymous user sign-up creates new account (does not upgrade)", async ({ expect }) => {
  await Project.createAndSwitch();

  // Create a regular user
  const firstUser = await Auth.Password.signUpWithEmail();
  const firstUserId = firstUser.userId;
  const firstAccessToken = firstUser.signUpResponse.body.access_token;

  // Sign up again while logged in as non-anonymous user (creates new account)
  const secondSignUpRes = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    headers: {
      "x-stack-access-token": firstAccessToken,
    },
    body: {
      email: "second@example.com",
      password: "TestPassword123!",
      verification_callback_url: "http://localhost:3000/callback",
    },
  });

  expect(secondSignUpRes.status).toBe(200);
  const secondUserId = secondSignUpRes.body.user_id;

  // Should be different user IDs
  expect(secondUserId).not.toBe(firstUserId);

  // Verify the new user was created
  const secondUserRes = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": secondSignUpRes.body.access_token,
    },
  });

  expect(secondUserRes.status).toBe(200);
  expect(secondUserRes.body.id).toBe(secondUserId);
  expect(secondUserRes.body.primary_email).toBe("second@example.com");

  // Original user still exists and is unchanged
  const firstUserRes = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": firstAccessToken,
    },
  });

  expect(firstUserRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "auth_with_email": true,
        "client_metadata": null,
        "client_read_only_metadata": null,
        "display_name": null,
        "external_auth_providers": [],
        "has_password": true,
        "id": "<stripped UUID>",
        "is_anonymous": false,
        "is_restricted": false,
        "oauth_providers": [],
        "otp_auth_enabled": false,
        "passkey_auth_enabled": false,
        "primary_email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
        "primary_email_verified": false,
        "profile_image_url": null,
        "requires_totp_mfa": false,
        "restricted_by_admin": false,
        "restricted_by_admin_reason": null,
        "restricted_reason": null,
        "selected_team": null,
        "selected_team_id": null,
        "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("signing in to an existing account while logged in as anonymous does not upgrade the user", async ({ expect }) => {
  const password = "TestPassword123!";
  const { userId: existingUserId } = await Auth.Password.signUpWithEmail({ password });
  await Auth.signOut();

  const { accessToken: anonAccessToken, userId: anonUserId } = await Auth.Anonymous.signUp();

  // Sign in to an existing account while logged in as anonymous
  const signInRes = await niceBackendFetch("/api/v1/auth/password/sign-in", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      password,
    },
    headers: {
      "x-stack-access-token": anonAccessToken,
    },
  });
  expect(signInRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "access_token": <stripped field 'access_token'>,
        "refresh_token": <stripped field 'refresh_token'>,
        "user_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(signInRes.body.user_id).toBe(existingUserId);
  expect(signInRes.body.user_id).not.toBe(anonUserId);
});

it("anonymous user can upgrade via OTP sign-in", async ({ expect }) => {
  // Create an anonymous user
  const anonSignUp = await Auth.Anonymous.signUp();
  const anonUserId = anonSignUp.userId;
  const anonAccessToken = anonSignUp.accessToken;

  // Create mailbox for OTP
  await bumpEmailAddress();
  const mailbox = backendContext.value.mailbox;

  const { signInResponse: verifyRes } = await Auth.Otp.signIn();
  expect(verifyRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "access_token": <stripped field 'access_token'>,
        "is_new_user": true,
        "refresh_token": <stripped field 'refresh_token'>,
        "user_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Verify the user is no longer anonymous
  const upgradedMeRes = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
  });
  expect(upgradedMeRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "auth_with_email": true,
        "client_metadata": null,
        "client_read_only_metadata": null,
        "display_name": null,
        "external_auth_providers": [],
        "has_password": false,
        "id": "<stripped UUID>",
        "is_anonymous": false,
        "is_restricted": false,
        "oauth_providers": [],
        "otp_auth_enabled": true,
        "passkey_auth_enabled": false,
        "primary_email": "mailbox-1--<stripped UUID>@stack-generated.example.com",
        "primary_email_verified": true,
        "profile_image_url": null,
        "requires_totp_mfa": false,
        "restricted_by_admin": false,
        "restricted_by_admin_reason": null,
        "restricted_reason": null,
        "selected_team": {
          "client_metadata": null,
          "client_read_only_metadata": null,
          "display_name": "mailbox-1--<stripped UUID>@stack-generated.example.com's Team",
          "id": "<stripped UUID>",
          "profile_image_url": null,
        },
        "selected_team_id": "<stripped UUID>",
        "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(upgradedMeRes.body.id).toBe(anonUserId);
});

it("anonymous user can upgrade via OAuth sign-in if ?token is set on the authorize endpoint", async ({ expect }) => {
  // Create an anonymous user
  const { userId: anonUserId, accessToken: anonAccessToken } = await Auth.Anonymous.signUp();

  await Auth.OAuth.signIn();

  // Verify that the OAuth providers exist
  const oauthProvidersRes = await niceBackendFetch("/api/v1/oauth-providers?user_id=me", {
    accessType: "client",
  });
  expect(oauthProvidersRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "allow_connected_accounts": true,
            "allow_sign_in": true,
            "email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
            "id": "<stripped UUID>",
            "provider_config_id": "spotify",
            "type": "spotify",
            "user_id": "<stripped UUID>",
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const upgradedMeRes = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": anonAccessToken,
    },
  });
  expect(upgradedMeRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "auth_with_email": false,
        "client_metadata": null,
        "client_read_only_metadata": null,
        "display_name": null,
        "external_auth_providers": [],
        "has_password": false,
        "id": "<stripped UUID>",
        "is_anonymous": false,
        "is_restricted": false,
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
        "primary_email_verified": true,
        "profile_image_url": null,
        "requires_totp_mfa": false,
        "restricted_by_admin": false,
        "restricted_by_admin_reason": null,
        "restricted_reason": null,
        "selected_team": {
          "client_metadata": null,
          "client_read_only_metadata": null,
          "display_name": "default-mailbox--<stripped UUID>@stack-generated.example.com's Team",
          "id": "<stripped UUID>",
          "profile_image_url": null,
        },
        "selected_team_id": "<stripped UUID>",
        "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(upgradedMeRes.body.oauth_providers).toHaveLength(1);
  expect(upgradedMeRes.body.is_anonymous).toBe(false);
  expect(upgradedMeRes.body.id).toBe(anonUserId);
});

it.todo("anonymous user does not upgrade via OAuth when access token headers are passed on the authorize endpoint, but ?token is not set");

it("anonymous user preserves metadata when upgrading", async ({ expect }) => {
  await Project.createAndSwitch();

  // Create an anonymous user
  const anonSignUp = await Auth.Anonymous.signUp();
  const anonUserId = anonSignUp.userId;

  // Set some metadata on the anonymous user
  await niceBackendFetch(`/api/v1/users/${anonUserId}`, {
    method: "PATCH",
    accessType: "server",
    body: {
      display_name: "Test User",
      client_metadata: { preference: "dark-mode" },
      server_metadata: { internal_id: "123" },
    },
  });

  // Upgrade the user
  const upgradeRes = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    headers: {
      "x-stack-access-token": anonSignUp.accessToken,
    },
    body: {
      email: "preserved@example.com",
      password: "TestPassword123!",
      verification_callback_url: "http://localhost:3000/callback",
    },
  });

  expect(upgradeRes.status).toBe(200);

  // Check that metadata was preserved
  const upgradedUser = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": upgradeRes.body.access_token,
    },
  });

  expect(upgradedUser.body.display_name).toBe("Test User");
  expect(upgradedUser.body.client_metadata).toEqual({ preference: "dark-mode" });

  // Check server metadata via server API
  const serverUser = await niceBackendFetch(urlString`/api/v1/users/${anonUserId}?include_anonymous=true`, {
    accessType: "server",
  });
  expect(serverUser.body.server_metadata).toEqual({ internal_id: "123" });
});

it("anonymous user preserves a pre-set country code when upgrading without request geo", async ({ expect }) => {
  await Project.createAndSwitch();

  const anonSignUp = await Auth.Anonymous.signUp();

  await niceBackendFetch(`/api/v1/users/${anonSignUp.userId}`, {
    method: "PATCH",
    accessType: "server",
    body: {
      country_code: "FR",
    },
  });

  backendContext.set({
    ipData: undefined,
  });

  const upgradeRes = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    headers: {
      "x-stack-access-token": anonSignUp.accessToken,
    },
    body: {
      email: "country-preserved@example.com",
      password: "TestPassword123!",
      verification_callback_url: "http://localhost:3000/callback",
    },
  });

  expect(upgradeRes.status).toBe(200);

  const upgradedUser = await niceBackendFetch(`/api/v1/users/${anonSignUp.userId}`, {
    accessType: "server",
  });
  expect(upgradedUser.status).toBe(200);
  expect(upgradedUser.body.country_code).toBe("FR");
});

it("cannot upgrade anonymous user to email that already exists", async ({ expect }) => {
  await Project.createAndSwitch();

  // Create a regular user with an email
  await bumpEmailAddress();
  const existingEmail = backendContext.value.mailbox.emailAddress;
  await Auth.Password.signUpWithEmail();

  // Create an anonymous user
  const anonSignUp = await Auth.Anonymous.signUp();

  // Try to upgrade to the same email
  const upgradeRes = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    headers: {
      "x-stack-access-token": anonSignUp.accessToken,
    },
    body: {
      email: existingEmail,
      password: "TestPassword123!",
      verification_callback_url: "http://localhost:3000/callback",
    },
  });

  expect(upgradeRes.status).toMatchInlineSnapshot(`409`);
});

it("updates the personal team display name when upgrading from anonymous", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      create_team_on_sign_up: true,
    },
  });

  // Create an anonymous user
  const anonSignUp = await Auth.Anonymous.signUp();

  // Get the personal team
  const personalTeamResponse = await niceBackendFetch("/api/v1/teams?user_id=me", {
    accessType: "client",
  });
  expect(personalTeamResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Upgrade the user
  const upgradeRes = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    headers: {
      "x-stack-access-token": anonSignUp.accessToken,
    },
    body: {
      email: "preserved@example.com",
      password: "TestPassword123!",
      verification_callback_url: "http://localhost:3000/callback",
    },
  });
  expect(upgradeRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "access_token": <stripped field 'access_token'>,
        "refresh_token": <stripped field 'refresh_token'>,
        "user_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Verify the personal team display name was updated
  const personalTeamResponse2 = await niceBackendFetch("/api/v1/teams?user_id=me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": upgradeRes.body.access_token,
    },
  });
  expect(personalTeamResponse2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "preserved@example.com's Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(personalTeamResponse2.body.items[0].id).toBe(personalTeamResponse.body.items[0].id);
});

it("does not update the personal team display name when upgrading an anonymous user after changing the personal team display name already", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      create_team_on_sign_up: true,
    },
  });

  // Create an anonymous user
  const anonSignUp = await Auth.Anonymous.signUp();

  // Get the personal team
  const personalTeamResponse = await niceBackendFetch("/api/v1/teams?user_id=me", {
    accessType: "client",
  });
  expect(personalTeamResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Update the personal team display name
  const updatePersonalTeamRes = await niceBackendFetch(urlString`/api/v1/teams/me?team_id=${personalTeamResponse.body.items[0].id}`, {
    method: "PATCH",
    accessType: "client",
    body: {
      display_name: "Custom Team Name",
    },
  });
  expect(updatePersonalTeamRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on PATCH /api/v1/teams/me:
              - params.team_id must be a valid UUID
              - query contains unknown properties: team_id
          \`,
        },
        "error": deindent\`
          Request validation failed on PATCH /api/v1/teams/me:
            - params.team_id must be a valid UUID
            - query contains unknown properties: team_id
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);

  // Upgrade the user
  const upgradeRes = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    headers: {
      "x-stack-access-token": anonSignUp.accessToken,
    },
    body: {
      email: "preserved@example.com",
      password: "TestPassword123!",
      verification_callback_url: "http://localhost:3000/callback",
    },
  });
  expect(upgradeRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "access_token": <stripped field 'access_token'>,
        "refresh_token": <stripped field 'refresh_token'>,
        "user_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Verify the personal team display name was updated
  const personalTeamResponse2 = await niceBackendFetch("/api/v1/teams?user_id=me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": upgradeRes.body.access_token,
    },
  });
  expect(personalTeamResponse2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "preserved@example.com's Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(personalTeamResponse2.body.items[0].id).toBe(personalTeamResponse.body.items[0].id);
});

it("should not allow upgrading account if sign ups are disabled", async ({ expect }) => {
  await Project.createAndSwitch({ config: { sign_up_enabled: false, credential_enabled: true } });
  const res = await niceBackendFetch("/api/v1/auth/anonymous/sign-up", {
    accessType: "client",
    method: "POST",
  });
  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "access_token": <stripped field 'access_token'>,
        "refresh_token": <stripped field 'refresh_token'>,
        "user_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const res2 = await niceBackendFetch("/api/v1/auth/password/sign-up", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      password: generateSecureRandomString(),
      verification_callback_url: "http://localhost:12345/some-callback-url",
    },
  });
  expect(res2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SIGN_UP_NOT_ENABLED",
        "error": "Creation of new accounts is not enabled for this project. Please ask the project owner to enable it.",
      },
      "headers": Headers {
        "x-stack-known-error": "SIGN_UP_NOT_ENABLED",
        <some fields may have been hidden>,
      },
    }
  `);
});
