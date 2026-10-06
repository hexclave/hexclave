import { it } from "../../../../../../helpers";
import { Auth, Project, bumpEmailAddress, niceBackendFetch } from "../../../../../backend-helpers";

it("anonymous users can sign up on any project now", async ({ expect }) => {
  await Project.createAndSwitch();
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
});

it("anonymous JWT has different kid and role", async ({ expect }) => {
  await Project.createAndSwitch();
  const signUpRes = await niceBackendFetch("/api/v1/auth/anonymous/sign-up", {
    accessType: "client",
    method: "POST",
  });

  const accessToken = signUpRes.body.access_token;

  // Decode the JWT to check the role
  const [header, payload] = accessToken.split('.').slice(0, 2).map((part: string) =>
    JSON.parse(Buffer.from(part, 'base64url').toString())
  );

  expect(payload.role).toBe('authenticated');
  expect(payload.is_anonymous).toBe(true);
  expect(header.kid).toBeTruthy();

  // The kid should be different from regular users
  const regularSignUp = await Auth.Password.signUpWithEmail();
  const regularToken = regularSignUp.signUpResponse.body.access_token;
  const [regularHeader] = regularToken.split('.').slice(0, 1).map((part: string) =>
    JSON.parse(Buffer.from(part, 'base64url').toString())
  );

  expect(header.kid).not.toBe(regularHeader.kid);
});

it("JWKS endpoint includes anonymous/restricted keys when requested", async ({ expect }) => {
  const project = await Project.createAndSwitch();

  // Regular JWKS request - should not include anonymous key
  const regularJwks = await niceBackendFetch(`/api/v1/projects/${project.projectId}/.well-known/jwks.json`, {
    method: "GET",
    accessType: null,
  });
  expect(regularJwks.status).toBe(200);
  const regularKeys = regularJwks.body.keys;
  expect(regularKeys).toHaveLength(2);

  // JWKS request with include_restricted - should include restricted, but not anonymous keys
  const restrictedJwks = await niceBackendFetch(`/api/v1/projects/${project.projectId}/.well-known/jwks.json?include_restricted=true`, {
    method: "GET",
    accessType: null,
  });
  expect(restrictedJwks.status).toBe(200);
  const restrictedKeys = restrictedJwks.body.keys;
  expect(restrictedKeys).toHaveLength(4);

  // Check that the kids are different
  const restrictedKids = restrictedKeys.map((key: any) => key.kid);
  expect(new Set(restrictedKids).size).toBe(4);

  // JWKS request with include_anonymous - should include all keys
  const anonymousJwks = await niceBackendFetch(`/api/v1/projects/${project.projectId}/.well-known/jwks.json?include_anonymous=true`, {
    method: "GET",
    accessType: null,
  });
  expect(anonymousJwks.status).toBe(200);
  const allKeys = anonymousJwks.body.keys;
  expect(allKeys).toHaveLength(6);

  // The anonymous issuer has no query parameters, so consumers can resolve its
  // issuer-relative JWKS alias and still receive the anonymous and restricted keys.
  const anonymousIssuerJwks = await niceBackendFetch(`/api/v1/projects-anonymous-users/${project.projectId}/.well-known/jwks.json`, {
    method: "GET",
    accessType: null,
  });
  expect(anonymousIssuerJwks.status).toBe(200);
  expect(anonymousIssuerJwks.body).toEqual(anonymousJwks.body);

  // Check that the kids are different
  const kids = allKeys.map((key: any) => key.kid);
  expect(new Set(kids).size).toBe(6);
});

it("anonymous users are rejected without X-Stack-Allow-Anonymous-User header", async ({ expect }) => {
  await Project.createAndSwitch();
  const signUpRes = await niceBackendFetch("/api/v1/auth/anonymous/sign-up", {
    accessType: "client",
    method: "POST",
  });

  const accessToken = signUpRes.body.access_token;

  // Try to access an endpoint without the header (niceBackendFetch adds it by default unless explicitly set to false)
  const res = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": accessToken,
      "x-stack-allow-anonymous-user": "false",
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "ANONYMOUS_AUTHENTICATION_NOT_ALLOWED",
        "error": "X-Stack-Access-Token is for an anonymous user, but anonymous users are not enabled. Set the X-Stack-Allow-Anonymous-User header of this request to 'true' to allow anonymous users.",
      },
      "headers": Headers {
        "x-stack-known-error": "ANONYMOUS_AUTHENTICATION_NOT_ALLOWED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("anonymous users are accepted with X-Stack-Allow-Anonymous-User header", async ({ expect }) => {
  await Project.createAndSwitch();
  const signUpRes = await niceBackendFetch("/api/v1/auth/anonymous/sign-up", {
    accessType: "client",
    method: "POST",
  });

  const accessToken = signUpRes.body.access_token;

  // Access with the header set to true
  const res = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-access-token": accessToken,
      "x-stack-allow-anonymous-user": "true",
    },
  });

  expect(res.status).toBe(200);
  expect(res.body.is_anonymous).toBe(true);
});

it("list users excludes anonymous users by default", async ({ expect }) => {
  await Project.createAndSwitch();

  // Create an anonymous user
  await Auth.Anonymous.signUp();

  // Create a regular user
  // Email delivery is queue-driven and can take tens of seconds in dev/CI; this test only needs the user record.
  await Auth.Password.signUpWithEmail();

  // List users without include_anonymous
  const listRes = await niceBackendFetch("/api/v1/users", {
    accessType: "server",
  });

  expect(listRes.status).toBe(200);
  const users = listRes.body.items;

  // Should only include the regular user
  expect(users).toHaveLength(1);
  expect(users[0].is_anonymous).toBe(false);
});

it("list users includes anonymous users when requested", async ({ expect }) => {
  await Project.createAndSwitch();

  // Create an anonymous user
  await Auth.Anonymous.signUp();

  // Create a regular user
  await bumpEmailAddress();
  // Email delivery is queue-driven and can take tens of seconds in dev/CI; this test only needs the user record.
  await Auth.Password.signUpWithEmail();

  // List users with include_anonymous=true
  const listRes = await niceBackendFetch("/api/v1/users?include_anonymous=true", {
    accessType: "server",
  });

  expect(listRes.status).toBe(200);
  const users = listRes.body.items;

  // Should include both users
  expect(users).toMatchInlineSnapshot(`
    [
      {
        "auth_with_email": true,
        "client_metadata": null,
        "client_read_only_metadata": null,
        "country_code": null,
        "display_name": null,
        "external_auth_providers": [],
        "has_password": true,
        "id": "<stripped UUID>",
        "is_anonymous": false,
        "is_restricted": false,
        "last_active_at_millis": <stripped field 'last_active_at_millis'>,
        "oauth_providers": [],
        "otp_auth_enabled": false,
        "passkey_auth_enabled": false,
        "primary_email": "mailbox-1--<stripped UUID>@stack-generated.example.com",
        "primary_email_auth_enabled": true,
        "primary_email_verified": false,
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
    ]
  `);
});

it("get user by id includes anonymous users when requested", async ({ expect }) => {
  await Project.createAndSwitch();

  // Create an anonymous user
  const anonSignUp = await Auth.Anonymous.signUp();
  const anonUserId = anonSignUp.userId;

  // Get the anonymous user with include_anonymous=true
  const res = await niceBackendFetch(`/api/v1/users/${anonUserId}?include_anonymous=true`, {
    accessType: "server",
  });

  expect(res.status).toBe(200);
  expect(res.body.id).toBe(anonUserId);
  expect(res.body.is_anonymous).toBe(true);
});

it("search users excludes anonymous users by default", async ({ expect }) => {
  await Project.createAndSwitch();

  // Create an anonymous user with a specific display name
  const anonSignUp = await Auth.Anonymous.signUp();

  // Update anonymous user's display name
  await niceBackendFetch(`/api/v1/users/${anonSignUp.userId}`, {
    accessType: "server",
    method: "PATCH",
    body: {
      display_name: "Unique Anonymous Name",
    },
  });

  // Create a regular user
  await Auth.signOut();
  await Auth.Password.signUpWithEmail();

  // Search for users with query matching anonymous user
  const searchRes = await niceBackendFetch("/api/v1/users?query=Unique", {
    accessType: "server",
  });

  expect(searchRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Search with include_anonymous=true
  const searchWithAnonRes = await niceBackendFetch("/api/v1/users?query=Unique&include_anonymous=true", {
    accessType: "server",
  });

  expect(searchWithAnonRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": true,
        "items": [
          {
            "auth_with_email": false,
            "client_metadata": null,
            "client_read_only_metadata": null,
            "country_code": null,
            "display_name": "Unique Anonymous Name",
            "external_auth_providers": [],
            "has_password": false,
            "id": "<stripped UUID>",
            "is_anonymous": true,
            "is_restricted": true,
            "last_active_at_millis": <stripped field 'last_active_at_millis'>,
            "oauth_providers": [],
            "otp_auth_enabled": false,
            "passkey_auth_enabled": false,
            "primary_email": null,
            "primary_email_auth_enabled": false,
            "primary_email_verified": false,
            "profile_image_url": null,
            "requires_totp_mfa": false,
            "restricted_by_admin": false,
            "restricted_by_admin_private_details": null,
            "restricted_by_admin_reason": null,
            "restricted_reason": { "type": "anonymous" },
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
        ],
        "pagination": { "next_cursor": null },
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});
