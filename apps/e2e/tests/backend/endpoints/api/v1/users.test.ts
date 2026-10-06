import { generateSecureRandomString } from "@hexclave/shared/dist/utils/crypto";
import { describe } from "vitest";
import { STACK_BACKEND_BASE_URL, it } from "../../../../helpers";
import { localhostUrl } from "../../../../helpers/ports";
import { Auth, InternalProjectKeys, Project, Team, Webhook, backendContext, bumpEmailAddress, createMailbox, niceBackendFetch } from "../../../backend-helpers";

describe("without project access", () => {
  backendContext.set({
    projectKeys: "no-project",
  });

  it("should not be able to read own user", async ({ expect }) => {
    await backendContext.with({
      projectKeys: InternalProjectKeys,
    }, async () => {
      await Auth.fastSignUp();
    });
    const response = await niceBackendFetch("/api/v1/users/me");
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "ACCESS_TYPE_REQUIRED",
          "error": deindent\`
            You must specify an access level for this Hexclave project. Make sure project API keys are provided (eg. x-hexclave-publishable-client-key) and you set the x-hexclave-access-type header to 'client', 'server', or 'admin'. (The legacy x-stack-* equivalents are also accepted.)
            
            For more information, see the docs on REST API authentication: https://docs.hexclave.com/api/overview#authentication
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "ACCESS_TYPE_REQUIRED",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should not be able to list users", async ({ expect }) => {
    await Project.createAndSwitch();
    const response = await niceBackendFetch("/api/v1/users");
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "ACCESS_TYPE_REQUIRED",
          "error": deindent\`
            You must specify an access level for this Hexclave project. Make sure project API keys are provided (eg. x-hexclave-publishable-client-key) and you set the x-hexclave-access-type header to 'client', 'server', or 'admin'. (The legacy x-stack-* equivalents are also accepted.)
            
            For more information, see the docs on REST API authentication: https://docs.hexclave.com/api/overview#authentication
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "ACCESS_TYPE_REQUIRED",
          <some fields may have been hidden>,
        },
      }
    `);
  });
});

describe("with client access", () => {
  it("should not be able to read own user if not signed in", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "CANNOT_GET_OWN_USER_WITHOUT_USER",
          "error": "You have specified 'me' as a userId, but did not provide authentication for a user.",
        },
        "headers": Headers {
          "x-stack-known-error": "CANNOT_GET_OWN_USER_WITHOUT_USER",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it.todo("should not be able to read own user if access token uses an incorrect signature", async ({ expect }) => {
    // TODO we should hardcode an access token generated with a different signature here
    backendContext.set({ userAuth: { accessToken: "replace this with an access token that uses a different signature" } });
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": {
          "code": "UNPARSABLE_ACCESS_TOKEN",
          "error": "Access token is not parsable.",
        },
        "headers": Headers {
          "x-stack-known-error": "UNPARSABLE_ACCESS_TOKEN",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it.todo("should not be able to read own user if access token is expired", async ({ expect }) => {
    // TODO instead of hardcoding an access token here, we should generate one that is short-lived and wait for it to expire
    // this test will fail in some environments because the signature is incorrect
    backendContext.set({ userAuth: { ...backendContext.value.userAuth, accessToken: "eyJhbGciOiJFUzI1NiIsImtpZCI6IkVYVkNzT01NRkpBMiJ9.eyJzdWIiOiIzM2U3YzA0My1kMmQxLTQxODctYWNkMy1mOTFiNWVkNjRiNDYiLCJpc3MiOiJodHRwczovL2FjY2Vzcy10b2tlbi5qd3Qtc2lnbmF0dXJlLnN0YWNrLWF1dGguY29tIiwiaWF0IjoxNzM4Mzc0OTU4LCJhdWQiOiJpbnRlcm5hbCIsImV4cCI6MTczODM3NDk4OH0.8USE-ELS4IYjFbzA5yNppNKKQGhdNQ0cUUBW7DMG8xHSfqEGw0Bm19u5uUZV6j0tGZypxRbIftgGaVdBRAOCig" } });
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": {
          "code": "ACCESS_TOKEN_EXPIRED",
          "details": { "expired_at_millis": 1738374988000 },
          "error": deindent\`
            Access token has expired. Please refresh it and try again. (The access token expired at 2025-02-01T01:56:28.000Z.) Project ID: 1234567890. User ID: 1234567890. Refresh token ID: 1234567890.

            Debug info: Most likely, you fetched the access token before it expired (for example, in a server component, pre-rendered page, or on page load), but then didn't refresh it before it expired. If this is the case, and you're using the SDK, make sure you call getAccessToken() every time you need to use the access token. If you're not using the SDK, make sure you refresh the access token with the refresh endpoint.
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "ACCESS_TOKEN_EXPIRED",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should be able to read own user if signed in", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
    });
    expect(response).toMatchInlineSnapshot(`
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
          "oauth_providers": [],
          "otp_auth_enabled": false,
          "passkey_auth_enabled": false,
          "primary_email": null,
          "primary_email_verified": false,
          "profile_image_url": null,
          "requires_totp_mfa": false,
          "restricted_by_admin": false,
          "restricted_by_admin_reason": null,
          "restricted_reason": null,
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
          "selected_team_id": "<stripped UUID>",
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to read own user if signed in even without refresh token", async ({ expect }) => {
    await Auth.fastSignUp();
    backendContext.set({ userAuth: { ...backendContext.value.userAuth, refreshToken: undefined } });
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
    });
    expect(response).toMatchInlineSnapshot(`
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
          "oauth_providers": [],
          "otp_auth_enabled": false,
          "passkey_auth_enabled": false,
          "primary_email": null,
          "primary_email_verified": false,
          "profile_image_url": null,
          "requires_totp_mfa": false,
          "restricted_by_admin": false,
          "restricted_by_admin_reason": null,
          "restricted_reason": null,
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
          "selected_team_id": "<stripped UUID>",
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should not be able to read own user without access token even if refresh token is given", async ({ expect }) => {
    await Auth.fastSignUp();
    backendContext.set({ userAuth: { ...backendContext.value.userAuth, accessToken: undefined } });
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "CANNOT_GET_OWN_USER_WITHOUT_USER",
          "error": "You have specified 'me' as a userId, but did not provide authentication for a user.",
        },
        "headers": Headers {
          "x-stack-known-error": "CANNOT_GET_OWN_USER_WITHOUT_USER",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should return access token invalid error when reading own user with invalid access token", async ({ expect }) => {
    await Auth.fastSignUp();
    backendContext.set({ userAuth: { ...backendContext.value.userAuth, accessToken: "12341234" } });
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": {
          "code": "UNPARSABLE_ACCESS_TOKEN",
          "error": "Access token is not parsable.",
        },
        "headers": Headers {
          "x-stack-known-error": "UNPARSABLE_ACCESS_TOKEN",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should be able to update own user", async ({ expect }) => {
    await Auth.fastSignUp();
    const response1 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        display_name: "John Doe",
      },
    });
    expect(response1).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "display_name": "John Doe",
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
          "oauth_providers": [],
          "otp_auth_enabled": false,
          "passkey_auth_enabled": false,
          "primary_email": null,
          "primary_email_verified": false,
          "profile_image_url": null,
          "requires_totp_mfa": false,
          "restricted_by_admin": false,
          "restricted_by_admin_reason": null,
          "restricted_reason": null,
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
          "selected_team_id": "<stripped UUID>",
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const response2 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        client_metadata: { key: "value" },
      },
    });
    expect(response2).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": { "key": "value" },
          "client_read_only_metadata": null,
          "display_name": "John Doe",
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
          "oauth_providers": [],
          "otp_auth_enabled": false,
          "passkey_auth_enabled": false,
          "primary_email": null,
          "primary_email_verified": false,
          "profile_image_url": null,
          "requires_totp_mfa": false,
          "restricted_by_admin": false,
          "restricted_by_admin_reason": null,
          "restricted_reason": null,
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
          "selected_team_id": "<stripped UUID>",
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it.todo("should be able to set own profile image URL with an image HTTP URL, and the new profile image URL should be a different HTTP URL on our storage service");

  it.todo("should be able to set own profile image URL with a base64 data URL, and the new profile image URL should be a different HTTP URL on our storage service");

  it.todo("should not be able to set own profile image URL with a file: protocol URL");

  it.todo("should not be able to set own profile image URL to a localhost/non-public URL");

  it("should not be able to set own server_metadata", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        display_name: "Johnny Doe",
        server_metadata: { "key": "value" },
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "SCHEMA_ERROR",
          "details": {
            "message": deindent\`
              Request validation failed on PATCH /api/v1/users/me:
                - body contains unknown properties: server_metadata
            \`,
          },
          "error": deindent\`
            Request validation failed on PATCH /api/v1/users/me:
              - body contains unknown properties: server_metadata
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "SCHEMA_ERROR",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should not be able to delete own user if project is not configured to allow it", async ({ expect }) => {
    await Project.createAndSwitch({
      config: {
        client_user_deletion_enabled: false,
      },
    });

    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "DELETE",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "Client user deletion is not enabled for this project",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to delete own user if project is configured to allow it", async ({ expect }) => {
    await Project.createAndSwitch({
      config: {
        client_user_deletion_enabled: true,
      },
    });

    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "DELETE",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "success": true },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should not be able to create a user", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "client",
      method: "POST",
      body: {},
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": {
          "code": "INSUFFICIENT_ACCESS_TYPE",
          "details": {
            "actual_access_type": "client",
            "allowed_access_types": [
              "server",
              "admin",
            ],
          },
          "error": "The x-hexclave-access-type header must be 'server' or 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
        },
        "headers": Headers {
          "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should set own display name to null when set to the empty string", async ({ expect }) => {
    await Auth.fastSignUp();
    const response1 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        display_name: "John Doe",
      },
    });
    expect(response1).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "display_name": "John Doe",
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
          "oauth_providers": [],
          "otp_auth_enabled": false,
          "passkey_auth_enabled": false,
          "primary_email": null,
          "primary_email_verified": false,
          "profile_image_url": null,
          "requires_totp_mfa": false,
          "restricted_by_admin": false,
          "restricted_by_admin_reason": null,
          "restricted_reason": null,
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
          "selected_team_id": "<stripped UUID>",
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const response2 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        display_name: "",
      },
    });
    expect(response2).toMatchInlineSnapshot(`
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
          "oauth_providers": [],
          "otp_auth_enabled": false,
          "passkey_auth_enabled": false,
          "primary_email": null,
          "primary_email_verified": false,
          "profile_image_url": null,
          "requires_totp_mfa": false,
          "restricted_by_admin": false,
          "restricted_by_admin_reason": null,
          "restricted_reason": null,
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
          "selected_team_id": "<stripped UUID>",
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to update totp_secret_base64 to valid base64", async ({ expect }) => {
    await Auth.fastSignUp();
    const secret = generateSecureRandomString(32);
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        totp_secret_base64: "ZXhhbXBsZSB2YWx1ZQ==",
      },
    });
    expect(response.status).toEqual(200);
  });

  it("should not be able to update totp_secret_base64 to invalid base64", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        totp_secret_base64: "not-valid-base64",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "SCHEMA_ERROR",
          "details": {
            "message": deindent\`
              Request validation failed on PATCH /api/v1/users/me:
                - body.totp_secret_base64 is not valid base64
            \`,
          },
          "error": deindent\`
            Request validation failed on PATCH /api/v1/users/me:
              - body.totp_secret_base64 is not valid base64
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "SCHEMA_ERROR",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should not be able to list users", async ({ expect }) => {
    await Project.createAndSwitch();
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "client",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": {
          "code": "INSUFFICIENT_ACCESS_TYPE",
          "details": {
            "actual_access_type": "client",
            "allowed_access_types": [
              "server",
              "admin",
            ],
          },
          "error": "The x-hexclave-access-type header must be 'server' or 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
        },
        "headers": Headers {
          "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should not be able to read a user", async ({ expect }) => {
    await Auth.fastSignUp();
    backendContext.set({
      userAuth: null,
    });
    const response = await niceBackendFetch("/api/v1/users/123", {
      accessType: "client",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": {
          "code": "INSUFFICIENT_ACCESS_TYPE",
          "details": {
            "actual_access_type": "client",
            "allowed_access_types": [
              "server",
              "admin",
            ],
          },
          "error": "The x-hexclave-access-type header must be 'server' or 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
        },
        "headers": Headers {
          "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should be able to update own client metadata", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        client_metadata: { key: "value" },
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": { "key": "value" },
          "client_read_only_metadata": null,
          "display_name": null,
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
          "oauth_providers": [],
          "otp_auth_enabled": false,
          "passkey_auth_enabled": false,
          "primary_email": null,
          "primary_email_verified": false,
          "profile_image_url": null,
          "requires_totp_mfa": false,
          "restricted_by_admin": false,
          "restricted_by_admin_reason": null,
          "restricted_reason": null,
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
          },
          "selected_team_id": "<stripped UUID>",
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should not be able to update own client read-only metadata", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        client_read_only_metadata: { key: "value" },
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "SCHEMA_ERROR",
          "details": {
            "message": deindent\`
              Request validation failed on PATCH /api/v1/users/me:
                - body contains unknown properties: client_read_only_metadata
            \`,
          },
          "error": deindent\`
            Request validation failed on PATCH /api/v1/users/me:
              - body contains unknown properties: client_read_only_metadata
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "SCHEMA_ERROR",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should not be able to update profile image url", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        profile_image_url: localhostUrl("01", "/open-graph-image.png"),
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "Invalid profile image URL",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to update profile image url with base64", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        profile_image_url: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
      },
    });
    expect(response.body.profile_image_url).toMatchInlineSnapshot(`"http://localhost:<$NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX>21/stack-storage/user-profile-images/<stripped UUID>.gif"`);
  });

  it("should not be able to update profile image url with invalid base64", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        profile_image_url: "data:image/not-valid;base64,test",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "Invalid profile image URL",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to update selected team", async ({ expect }) => {
    await Project.createAndSwitch();
    await Auth.fastSignUp();
    const { teamId: team1Id } = await Team.createWithCurrentAsCreator({});
    const { teamId: team2Id } = await Team.createWithCurrentAsCreator({});
    const response1 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
    });
    expect(response1.body.selected_team_id).toEqual(null);
    const response2 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        selected_team_id: team1Id,
      },
    });
    expect(response2.body.selected_team_id).toEqual(team1Id);
    const response3 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        selected_team_id: team2Id,
      },
    });
    expect(response3.body.selected_team_id).toEqual(team2Id);
    const response4 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "client",
      method: "PATCH",
      body: {
        selected_team_id: null,
      },
    });
    expect(response4.body.selected_team_id).toEqual(null);
  });
});

describe("with server access", () => {
  it("should be able to read own user", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": null,
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
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
          "restricted_reason": null,
          "risk_scores": {
            "sign_up": {
              "bot": 0,
              "free_trial_abuse": 0,
            },
          },
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": null,
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to update own user", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        display_name: "John Doe",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": "John Doe",
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
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
          "restricted_reason": null,
          "risk_scores": {
            "sign_up": {
              "bot": 0,
              "free_trial_abuse": 0,
            },
          },
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": null,
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to delete own user", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "DELETE",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "success": true },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to list users", async ({ expect }) => {
    await Project.createAndSwitch({ config: { magic_link_enabled: true } });
    await Auth.fastSignUp();

    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
    });
    expect(response).toMatchInlineSnapshot(`
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
              "display_name": null,
              "external_auth_providers": [],
              "has_password": false,
              "id": "<stripped UUID>",
              "is_anonymous": false,
              "is_restricted": false,
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
          ],
          "pagination": { "next_cursor": null },
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should require include_anonymous=true when only_anonymous=true", async ({ expect }) => {
    await Project.createAndSwitch();
    await Auth.fastSignUp();

    const response = await niceBackendFetch("/api/v1/users?only_anonymous=true", {
      accessType: "server",
    });

    expect(response.status).toBe(400);
    expect(response.body).toBe("only_anonymous=true requires include_anonymous=true");
  });

  it("lists users excluding exact primary email domains", async ({ expect }) => {
    await Project.createAndSwitch();

    const blockedResponse = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: "blocked@example.com",
        primary_email_verified: true,
      },
    });
    const secondaryMatchResponse = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: "keeper@work.example",
        primary_email_verified: true,
      },
    });
    const noEmailResponse = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        display_name: "No Email",
      },
    });
    await niceBackendFetch("/api/v1/contact-channels", {
      accessType: "server",
      method: "POST",
      body: {
        user_id: secondaryMatchResponse.body.id,
        type: "email",
        value: "secondary@gmail.com",
        is_verified: true,
        used_for_auth: false,
      },
    });

    const response = await niceBackendFetch("/api/v1/users?include_restricted=true&excluded_email_domains=@EXAMPLE.com,gmail.com", {
      accessType: "server",
    });

    const userIds = response.body.items.map((user: { id: string }) => user.id);
    expect(userIds).not.toContain(blockedResponse.body.id);
    expect(userIds).toContain(secondaryMatchResponse.body.id);
    expect(userIds).toContain(noEmailResponse.body.id);
  });

  it("rejects invalid excluded email domains", async ({ expect }) => {
    await Project.createAndSwitch();

    const response = await niceBackendFetch("/api/v1/users?excluded_email_domains=*.gmail.com", {
      accessType: "server",
    });

    expect(response.status).toBe(400);
    expect(response.body).toBe("excluded_email_domains must be a comma-separated list of valid domains");
  });

  it("treats empty excluded email domains as omitted", async ({ expect }) => {
    await Project.createAndSwitch();
    const userResponse = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: "included@example.com",
        primary_email_verified: true,
      },
    });

    const emptyResponse = await niceBackendFetch("/api/v1/users?excluded_email_domains=", {
      accessType: "server",
    });
    const trailingCommaResponse = await niceBackendFetch("/api/v1/users?excluded_email_domains=,", {
      accessType: "server",
    });

    expect(emptyResponse.status).toBe(200);
    expect(trailingCommaResponse.status).toBe(200);
    expect(emptyResponse.body.items.map((user: { id: string }) => user.id)).toContain(userResponse.body.id);
    expect(trailingCommaResponse.body.items.map((user: { id: string }) => user.id)).toContain(userResponse.body.id);
  });

  it("lists users with pagination", async ({ expect }) => {
    await Project.createAndSwitch();
    for (let i = 0; i < 5; i++) {
      await Auth.fastSignUp();
    }
    const allResponse = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
    });

    const response1 = await niceBackendFetch("/api/v1/users?limit=2", {
      accessType: "server",
    });
    expect(response1.body.pagination.next_cursor).toBeDefined();

    const response2 = await niceBackendFetch(`/api/v1/users?limit=3&cursor=${response1.body.pagination.next_cursor}`, {
      accessType: "server",
    });
    expect(response2.body.pagination.next_cursor).toBeDefined();

    // check if response 1 + response 2 = allResponse
    expect(response1.body.items.length + response2.body.items.length).toEqual(allResponse.body.items.length);
    const allUserIds = new Set(allResponse.body.items.map((user: any) => user.id));
    const concatenatedUserIds = new Set([...response1.body.items.map((user: any) => user.id), ...response2.body.items.map((user: any) => user.id)]);
    expect(concatenatedUserIds).toEqual(allUserIds);
  });

  it("should be able to read a user", async ({ expect }) => {
    await Auth.fastSignUpWithEmail();
    const signedInResponse = (await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
    }));
    const userId = signedInResponse.body.id;
    backendContext.set({
      userAuth: null,
    });
    const response = await niceBackendFetch("/api/v1/users/" + userId, {
      accessType: "server",
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": null,
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
          "primary_email_auth_enabled": false,
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
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "default-mailbox--<stripped UUID>@stack-generated.example.com's Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": null,
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    expect(response.body.primary_email).toEqual(backendContext.value.mailbox.emailAddress);
  });

  it("should be able to create a user", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {},
    });
    expect(response).toMatchInlineSnapshot(`
                NiceResponse {
                  "status": 201,
                  "body": {
                    "auth_with_email": false,
                    "client_metadata": null,
                    "client_read_only_metadata": null,
                    "country_code": null,
                    "display_name": null,
                    "external_auth_providers": [],
                    "has_password": false,
                    "id": "<stripped UUID>",
                    "is_anonymous": false,
                    "is_restricted": false,
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

  it("should be able to create a user with email auth enabled", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_auth_enabled: true,
        display_name: "John Dough",
        server_metadata: "test",
      },
    });
    expect(response).toMatchInlineSnapshot(`
            NiceResponse {
              "status": 201,
              "body": {
                "auth_with_email": false,
                "client_metadata": null,
                "client_read_only_metadata": null,
                "country_code": null,
                "display_name": "John Dough",
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
                "server_metadata": "test",
                "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
              },
              "headers": Headers { <some fields may have been hidden> },
            }
          `);
  });

  it("should be able to create a user with an email that doesn't match the strict email schema", async ({ expect }) => {
    // This test is to ensure that we don't break existing users who have an email that doesn't match the strict email
    // schema.
    // The frontend no longer allows those emails, but some users may still have them in their accounts and we should
    // continue to support them.
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: "invalid_email@gmai"
      },
    });
    expect(response).toMatchInlineSnapshot(`
            NiceResponse {
              "status": 201,
              "body": {
                "auth_with_email": false,
                "client_metadata": null,
                "client_read_only_metadata": null,
                "country_code": null,
                "display_name": null,
                "external_auth_providers": [],
                "has_password": false,
                "id": "<stripped UUID>",
                "is_anonymous": false,
                "is_restricted": false,
                "last_active_at_millis": <stripped field 'last_active_at_millis'>,
                "oauth_providers": [],
                "otp_auth_enabled": false,
                "passkey_auth_enabled": false,
                "primary_email": "invalid_email@gmai",
                "primary_email_auth_enabled": false,
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
              "headers": Headers { <some fields may have been hidden> },
            }
          `);
  });

  it("should be able to create a user with a password and sign in with it", async ({ expect }) => {
    const password = generateSecureRandomString();
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_auth_enabled: true,
        password,
      },
    });
    expect(response).toMatchInlineSnapshot(`
            NiceResponse {
              "status": 201,
              "body": {
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
                "primary_email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
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
              "headers": Headers { <some fields may have been hidden> },
            }
          `);
    const signInResponse = await Auth.Password.signInWithEmail({ password });
    expect(signInResponse.signInResponse).toMatchInlineSnapshot(`
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

  it("should be able to create a user with a password hash and sign in with it", async ({ expect }) => {
    const password = "hello-world";
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_auth_enabled: true,
        password_hash: "$2a$13$TVyY/gpw9Db/w1fBeJkCgeNg2Rae2JfNqrPnSAKtj.ufAO5cVF13.",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 201,
        "body": {
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
          "primary_email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
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
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const signInResponse = await Auth.Password.signInWithEmail({ password });
    expect(signInResponse.signInResponse).toMatchInlineSnapshot(`
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

  it("should be able to create an anonymous user", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        is_anonymous: true,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 201,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": null,
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
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to make an anonymous user non-anonymous", async ({ expect }) => {
    await Auth.Anonymous.signUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        is_anonymous: false,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": null,
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
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
          "restricted_reason": null,
          "risk_scores": {
            "sign_up": {
              "bot": 0,
              "free_trial_abuse": 0,
            },
          },
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": null,
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should not be able to make a non-anonymous user anonymous", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {},
    });
    const userId = response.body.id;
    const response2 = await niceBackendFetch("/api/v1/users/" + userId, {
      accessType: "server",
      method: "PATCH",
      body: {
        is_anonymous: true,
      },
    });
    expect(response2).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "SCHEMA_ERROR",
          "details": {
            "message": deindent\`
              Request validation failed on PATCH /api/v1/users/<stripped UUID>:
                - body.is_anonymous must be one of the following values: false
            \`,
          },
          "error": deindent\`
            Request validation failed on PATCH /api/v1/users/<stripped UUID>:
              - body.is_anonymous must be one of the following values: false
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "SCHEMA_ERROR",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should not be able to create a user when both password and password hash are provided", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_auth_enabled: true,
        password: "hello-world",
        password_hash: "$2a$13$TVyY/gpw9Db/w1fBeJkCgeNg2Rae2JfNqrPnSAKtj.ufAO5cVF13.",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "Cannot set both password and password_hash at the same time.",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should not be able to create a user with a password hash that has too many rounds", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_auth_enabled: true,
        password_hash: "$2a$17$VIhIOofSMqGdGlL4wzE//e.77dAQGqNtF/1dT7bqCrVtQuInWy2qi",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "Invalid password hash. Make sure it's a supported algorithm in Modular Crypt Format.",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should not be able to create a user without primary email but with email auth enabled", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email_auth_enabled: true,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "primary_email_auth_enabled cannot be true without primary_email",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should not be able to create a user with email auth enabled if the email already exists with email auth enabled", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_auth_enabled: true,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 201,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": null,
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
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const response2 = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_auth_enabled: true,
      },
    });
    expect(response2).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 409,
        "body": {
          "code": "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
          "details": {
            "contact_channel_value": "default-mailbox--<stripped UUID>@stack-generated.example.com",
            "type": "email",
            "would_work_if_email_was_verified": false,
          },
          "error": "This email \\"(default-mailbox--<stripped UUID>@stack-generated.example.com)\\" is already used for authentication by another account.",
        },
        "headers": Headers {
          "x-stack-known-error": "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should be able to create a user with email auth enabled if the email already exists but without email auth enabled", async ({ expect }) => {
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 201,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": null,
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
          "primary_email_auth_enabled": false,
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
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const password = generateSecureRandomString();
    const response2 = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_auth_enabled: true,
        password: password,
      },
    });
    expect(response2).toMatchInlineSnapshot(`
            NiceResponse {
              "status": 201,
              "body": {
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
                "primary_email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
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
              "headers": Headers { <some fields may have been hidden> },
            }
          `);
    const signInResponse = await Auth.Password.signInWithEmail({ password });
    expect(signInResponse.signInResponse).toMatchInlineSnapshot(`
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

  it("should be able to create a user with email auth disabled even if the email already exists with email auth enabled", async ({ expect }) => {
    const password = generateSecureRandomString();
    const response2 = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_auth_enabled: true,
        password: password,
      },
    });
    expect(response2).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 201,
        "body": {
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
          "primary_email": "default-mailbox--<stripped UUID>@stack-generated.example.com",
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
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const response = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 201,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": null,
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
          "primary_email_auth_enabled": false,
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
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const signInResponse = await Auth.Password.signInWithEmail({ password });
    expect(signInResponse.signInResponse).toMatchInlineSnapshot(`
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

  it("should be able to update a user", async ({ expect }) => {
    await Auth.fastSignUp();
    const signedInResponse = (await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
    }));
    const userId = signedInResponse.body.id;
    backendContext.set({
      userAuth: null,
    });
    const response1 = await niceBackendFetch("/api/v1/users/" + userId, {
      accessType: "server",
      method: "PATCH",
      body: {
        display_name: "John Doe",
        server_metadata: { key: "value" },
      },
    });
    expect(response1).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": "John Doe",
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
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
          "restricted_reason": null,
          "risk_scores": {
            "sign_up": {
              "bot": 0,
              "free_trial_abuse": 0,
            },
          },
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": { "key": "value" },
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const response2 = await niceBackendFetch("/api/v1/users/" + userId, {
      accessType: "server",
    });
    expect(response2).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": "John Doe",
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
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
          "restricted_reason": null,
          "risk_scores": {
            "sign_up": {
              "bot": 0,
              "free_trial_abuse": 0,
            },
          },
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": { "key": "value" },
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to update own user", async ({ expect }) => {
    await Auth.fastSignUp();
    const response1 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        display_name: "John Doe",
        server_metadata: { key: "value" },
      },
    });
    expect(response1).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": "John Doe",
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
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
          "restricted_reason": null,
          "risk_scores": {
            "sign_up": {
              "bot": 0,
              "free_trial_abuse": 0,
            },
          },
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": { "key": "value" },
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to update a user's password, signing them out, and sign in with it again", async ({ expect }) => {
    const password = "this-is-some-password";
    await Auth.Otp.signIn();
    const response1 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        password,
      },
    });
    expect(response1).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
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
          "otp_auth_enabled": true,
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
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "default-mailbox--<stripped UUID>@stack-generated.example.com's Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": null,
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    backendContext.set({
      userAuth: {
        ...backendContext.value.userAuth,
        accessToken: undefined,
      },
    });
    await Auth.expectToBeSignedOut();
    await Auth.Password.signInWithEmail({ password });
    await Auth.expectToBeSignedIn();
  });

  it("should be able to delete a user", async ({ expect }) => {
    await Auth.fastSignUp();
    const signedInResponse = (await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
    }));
    const userId = signedInResponse.body.id;
    backendContext.set({
      userAuth: null,
    });
    const response1 = await niceBackendFetch("/api/v1/users/" + userId, {
      accessType: "server",
      method: "DELETE",
    });
    expect(response1).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "success": true },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
    const response2 = await niceBackendFetch("/api/v1/users/" + userId, {
      accessType: "server",
    });
    expect(response2).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 404,
        "body": {
          "code": "USER_NOT_FOUND",
          "error": "User not found.",
        },
        "headers": Headers {
          "x-stack-known-error": "USER_NOT_FOUND",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should be able to update all metadata fields", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        client_metadata: { key: "client value" },
        client_read_only_metadata: { key: "client read only value" },
        server_metadata: { key: "server value" },
      },
    });

    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": { "key": "client value" },
          "client_read_only_metadata": { "key": "client read only value" },
          "country_code": null,
          "display_name": null,
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
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
          "restricted_reason": null,
          "risk_scores": {
            "sign_up": {
              "bot": 0,
              "free_trial_abuse": 0,
            },
          },
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": { "key": "server value" },
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to update profile image url", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        profile_image_url: localhostUrl("01", "/open-graph-image.png"),
      },
    });
    expect(response.body.profile_image_url).toMatchInlineSnapshot(`"http://localhost:<$NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX>01/open-graph-image.png"`);
  });

  it("should be able to update primary email", async ({ expect }) => {
    await Auth.fastSignUp();
    const mailbox = createMailbox();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        primary_email: mailbox.emailAddress,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": null,
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
          "last_active_at_millis": <stripped field 'last_active_at_millis'>,
          "oauth_providers": [],
          "otp_auth_enabled": false,
          "passkey_auth_enabled": false,
          "primary_email": "mailbox-1--<stripped UUID>@stack-generated.example.com",
          "primary_email_auth_enabled": false,
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
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "Personal Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": null,
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should be able to update primary email and sign-in with the new email", async ({ expect }) => {
    await Auth.Password.signUpWithEmail({ password: "password123" });
    const mailbox = createMailbox();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        primary_email: mailbox.emailAddress,
      },
    });
    expect(response.body.primary_email).toEqual(mailbox.emailAddress);

    backendContext.set({
      mailbox,
    });
    await Auth.Password.signInWithEmail({ password: "password123" });
    expect(response.body.primary_email).toEqual(mailbox.emailAddress);
  });

  it("should be able to remove primary email", async ({ expect }) => {
    await Auth.Otp.signIn();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        primary_email: null,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": true,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": null,
          "external_auth_providers": [],
          "has_password": false,
          "id": "<stripped UUID>",
          "is_anonymous": false,
          "is_restricted": false,
          "last_active_at_millis": <stripped field 'last_active_at_millis'>,
          "oauth_providers": [],
          "otp_auth_enabled": true,
          "passkey_auth_enabled": false,
          "primary_email": null,
          "primary_email_auth_enabled": false,
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
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "default-mailbox--<stripped UUID>@stack-generated.example.com's Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": null,
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("should not be able to update primary email to an email already in use for auth by someone else", async ({ expect }) => {
    await Auth.Otp.signIn();
    const primaryEmail = backendContext.value.mailbox.emailAddress;
    await Auth.signOut();
    await bumpEmailAddress();
    await Auth.Password.signUpWithEmail({ password: "password123" });
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        primary_email: primaryEmail,
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 409,
        "body": {
          "code": "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
          "details": {
            "contact_channel_value": "default-mailbox--<stripped UUID>@stack-generated.example.com",
            "type": "email",
            "would_work_if_email_was_verified": false,
          },
          "error": "This email \\"(default-mailbox--<stripped UUID>@stack-generated.example.com)\\" is already used for authentication by another account.",
        },
        "headers": Headers {
          "x-stack-known-error": "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should not be able to set profile image url to empty string", async ({ expect }) => {
    await Auth.fastSignUp();
    const response = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        profile_image_url: "",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "SCHEMA_ERROR",
          "details": {
            "message": deindent\`
              Request validation failed on PATCH /api/v1/users/me:
                - body.profile_image_url is not a valid URL
            \`,
          },
          "error": deindent\`
            Request validation failed on PATCH /api/v1/users/me:
              - body.profile_image_url is not a valid URL
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "SCHEMA_ERROR",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should not be able to sign up with an email already in use for auth", async ({ expect }) => {
    await Auth.Password.signUpWithEmail({ password: "password123" });
    const response = await niceBackendFetch("/api/v1/auth/password/sign-up", {
      method: "POST",
      accessType: "client",
      body: {
        email: backendContext.value.mailbox.emailAddress,
        password: "password123",
        verification_callback_url: "http://localhost:12345/some-callback-url",
      },
    });
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 409,
        "body": {
          "code": "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
          "details": {
            "contact_channel_value": "default-mailbox--<stripped UUID>@stack-generated.example.com",
            "type": "email",
            "would_work_if_email_was_verified": false,
          },
          "error": "This email \\"(default-mailbox--<stripped UUID>@stack-generated.example.com)\\" is already used for authentication by another account.",
        },
        "headers": Headers {
          "x-stack-known-error": "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should be able to sign up with an email already in use for auth in a different project", async ({ expect }) => {
    await Auth.Password.signUpWithEmail({ password: "password123" });
    await Project.createAndSwitch({});
    const response = await niceBackendFetch("/api/v1/auth/password/sign-up", {
      method: "POST",
      accessType: "client",
      body: {
        email: backendContext.value.mailbox.emailAddress,
        password: "password123",
        verification_callback_url: "http://localhost:12345/some-callback-url",
      },
    });
    expect(response).toMatchInlineSnapshot(`
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


  it("should trigger user webhook when a user is created", async ({ expect }) => {
    const { projectId, svixToken, endpointId } = await Webhook.createProjectWithEndpoint();

    const createUserResponse = await niceBackendFetch(new URL("/api/v1/users", STACK_BACKEND_BASE_URL), {
      method: "POST",
      accessType: "server",
      body: {
        primary_email: "test@example.com",
      },
    });

    expect(createUserResponse.status).toBe(201);

    const attemptResponse = await Webhook.findWebhookAttempt(projectId, endpointId, svixToken, event => true);

    expect(attemptResponse).toMatchInlineSnapshot(`
      {
        "channels": null,
        "eventId": null,
        "eventType": "user.created",
        "id": "<stripped svix message id>",
        "payload": {
          "data": {
            "auth_with_email": false,
            "client_metadata": null,
            "client_read_only_metadata": null,
            "country_code": null,
            "display_name": null,
            "external_auth_providers": [],
            "has_password": false,
            "id": "<stripped UUID>",
            "is_anonymous": false,
            "is_restricted": false,
            "last_active_at_millis": <stripped field 'last_active_at_millis'>,
            "oauth_providers": [],
            "otp_auth_enabled": false,
            "passkey_auth_enabled": false,
            "primary_email": "test@example.com",
            "primary_email_auth_enabled": false,
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
          "type": "user.created",
        },
        "timestamp": <stripped field 'timestamp'>,
      }
    `);
  });

  it("should trigger user webhook when a user is updated", async ({ expect }) => {
    const { projectId, svixToken, endpointId } = await Webhook.createProjectWithEndpoint();

    const createUserResponse = await niceBackendFetch("/api/v1/users", {
      method: "POST",
      accessType: "server",
      body: {
        primary_email: "test@example.com",
      },
    });

    expect(createUserResponse.status).toBe(201);
    const userId = createUserResponse.body.id;

    const updateUserResponse = await niceBackendFetch(`/api/v1/users/${userId}`, {
      method: "PATCH",
      accessType: "server",
      body: {
        display_name: "Test User"
      }
    });

    expect(updateUserResponse.status).toBe(200);

    const userUpdatedEvent = await Webhook.findWebhookAttempt(projectId, endpointId, svixToken, event => event.eventType === "user.updated");

    expect(userUpdatedEvent).toMatchInlineSnapshot(`
      {
        "channels": null,
        "eventId": null,
        "eventType": "user.updated",
        "id": "<stripped svix message id>",
        "payload": {
          "data": {
            "auth_with_email": false,
            "client_metadata": null,
            "client_read_only_metadata": null,
            "country_code": null,
            "display_name": "Test User",
            "external_auth_providers": [],
            "has_password": false,
            "id": "<stripped UUID>",
            "is_anonymous": false,
            "is_restricted": false,
            "last_active_at_millis": <stripped field 'last_active_at_millis'>,
            "oauth_providers": [],
            "otp_auth_enabled": false,
            "passkey_auth_enabled": false,
            "primary_email": "test@example.com",
            "primary_email_auth_enabled": false,
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
          "type": "user.updated",
        },
        "timestamp": <stripped field 'timestamp'>,
      }
    `);
  });

  it("should trigger user webhook when a user is deleted", async ({ expect }) => {
    const { projectId, svixToken, endpointId } = await Webhook.createProjectWithEndpoint();

    const createUserResponse = await niceBackendFetch(new URL("/api/v1/users", STACK_BACKEND_BASE_URL), {
      method: "POST",
      accessType: "server",
      body: {
        primary_email: "test@example.com",
      },
    });

    expect(createUserResponse.status).toBe(201);
    const userId = createUserResponse.body.id;

    const deleteUserResponse = await niceBackendFetch(new URL(`/api/v1/users/${userId}`, STACK_BACKEND_BASE_URL), {
      method: "DELETE",
      accessType: "server",
    });

    expect(deleteUserResponse.status).toBe(200);

    const userDeletedEvent = await Webhook.findWebhookAttempt(projectId, endpointId, svixToken, event => event.eventType === "user.deleted");

    expect(userDeletedEvent).toMatchInlineSnapshot(`
      {
        "channels": null,
        "eventId": null,
        "eventType": "user.deleted",
        "id": "<stripped svix message id>",
        "payload": {
          "data": {
            "id": "<stripped UUID>",
            "teams": [],
          },
          "type": "user.deleted",
        },
        "timestamp": <stripped field 'timestamp'>,
      }
    `);
  });

  it("should be able to properly disable primary_email_auth_enabled", async ({ expect }) => {
    // Test for the fix where primary_email_auth_enabled couldn't be disabled properly
    // due to an OR operator issue that always kept it true

    // Create a user with email auth enabled
    const response1 = await niceBackendFetch("/api/v1/users", {
      accessType: "server",
      method: "POST",
      body: {
        primary_email: backendContext.value.mailbox.emailAddress,
        primary_email_auth_enabled: true,
        display_name: "Test User",
      },
    });
    expect(response1.status).toEqual(201);
    expect(response1.body.primary_email_auth_enabled).toEqual(true);
    const userId = response1.body.id;

    // Update the user to disable email auth
    const response2 = await niceBackendFetch("/api/v1/users/" + userId, {
      accessType: "server",
      method: "PATCH",
      body: {
        primary_email_auth_enabled: false,
      },
    });
    expect(response2).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": {
          "auth_with_email": false,
          "client_metadata": null,
          "client_read_only_metadata": null,
          "country_code": null,
          "display_name": "Test User",
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
          "primary_email_auth_enabled": false,
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
          "selected_team": {
            "client_metadata": null,
            "client_read_only_metadata": null,
            "created_at_millis": <stripped field 'created_at_millis'>,
            "display_name": "Test User's Team",
            "id": "<stripped UUID>",
            "profile_image_url": null,
            "server_metadata": null,
          },
          "selected_team_id": "<stripped UUID>",
          "server_metadata": null,
          "signed_up_at_millis": <stripped field 'signed_up_at_millis'>,
        },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);

    // Verify the change persisted by reading the user again
    const response3 = await niceBackendFetch("/api/v1/users/" + userId, {
      accessType: "server",
    });
    expect(response3.status).toEqual(200);
    expect(response3.body.primary_email_auth_enabled).toEqual(false);
    expect(response3.body.auth_with_email).toEqual(false);

    // Test that we can re-enable it
    const response4 = await niceBackendFetch("/api/v1/users/" + userId, {
      accessType: "server",
      method: "PATCH",
      body: {
        primary_email_auth_enabled: true,
      },
    });
    expect(response4.status).toEqual(200);
    expect(response4.body.primary_email_auth_enabled).toEqual(true);
    expect(response4.body.auth_with_email).toEqual(false); // Still false because no password/otp is set

    // Verify re-enabling persisted
    const response5 = await niceBackendFetch("/api/v1/users/" + userId, {
      accessType: "server",
    });
    expect(response5.status).toEqual(200);
    expect(response5.body.primary_email_auth_enabled).toEqual(true);
  });

  it("should be able to disable primary_email_auth_enabled on current user", async ({ expect }) => {
    // Test the same functionality when updating the current user via /me endpoint
    await Auth.Otp.signIn();

    // First verify the user has email auth enabled (from OTP sign in)
    const initialResponse = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
    });
    expect(initialResponse.status).toEqual(200);
    expect(initialResponse.body.primary_email_auth_enabled).toEqual(true);

    // Disable email auth on current user
    const response1 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        primary_email_auth_enabled: false,
      },
    });
    expect(response1.status).toEqual(200);
    expect(response1.body.primary_email_auth_enabled).toEqual(false);
    expect(response1.body.auth_with_email).toEqual(true); // May still be true due to existing auth methods

    // Verify the change persisted by reading the user again
    const response2 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
    });
    expect(response2.status).toEqual(200);
    expect(response2.body.primary_email_auth_enabled).toEqual(false);

    // Re-enable email auth
    const response3 = await niceBackendFetch("/api/v1/users/me", {
      accessType: "server",
      method: "PATCH",
      body: {
        primary_email_auth_enabled: true,
      },
    });
    expect(response3.status).toEqual(200);
    expect(response3.body.primary_email_auth_enabled).toEqual(true);
  });
});

it.todo("creating a new user with an OAuth provider ID that does not exist should fail");
it.todo("creating a new user with password enabled when password sign in is disabled in the config should fail");
