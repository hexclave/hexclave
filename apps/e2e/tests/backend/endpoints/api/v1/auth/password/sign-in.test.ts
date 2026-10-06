import { it } from "../../../../../../helpers";
import { Auth, backendContext, niceBackendFetch } from "../../../../../backend-helpers";

it("should allow signing in to existing accounts", async ({ expect }) => {
  const res = await Auth.Password.signUpWithEmail();
  backendContext.set({ userAuth: null });
  await Auth.expectToBeSignedOut();
  const res2 = await Auth.Password.signInWithEmail({ password: res.password });
  expect(res2.signInResponse).toMatchInlineSnapshot(`
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
  const response = await niceBackendFetch("/api/v1/users/me", { accessType: "client" });
  expect(response).toMatchInlineSnapshot(`
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
});
// TODO: check auth methods

it("should not allow signing in with an e-mail that never signed up", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/auth/password/sign-in", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      password: "some-password",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "EMAIL_PASSWORD_MISMATCH",
        "error": "Wrong e-mail or password.",
      },
      "headers": Headers {
        "x-stack-known-error": "EMAIL_PASSWORD_MISMATCH",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should not allow signing in with an incorrect password", async ({ expect }) => {
  const res = await Auth.Password.signUpWithEmail();
  const response = await niceBackendFetch("/api/v1/auth/password/sign-in", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      password: "wrong-password",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "EMAIL_PASSWORD_MISMATCH",
        "error": "Wrong e-mail or password.",
      },
      "headers": Headers {
        "x-stack-known-error": "EMAIL_PASSWORD_MISMATCH",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should not allow signing in when MFA is required", async ({ expect }) => {
  const res = await Auth.Password.signUpWithEmail();
  await Auth.Mfa.setupTotpMfa();
  await Auth.signOut();

  const response = await niceBackendFetch("/api/v1/auth/password/sign-in", {
    method: "POST",
    accessType: "client",
    body: {
      email: backendContext.value.mailbox.emailAddress,
      password: res.password,
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "MULTI_FACTOR_AUTHENTICATION_REQUIRED",
        "details": { "attempt_code": <stripped field 'attempt_code'> },
        "error": "Multi-factor authentication is required for this user.",
      },
      "headers": Headers {
        "x-stack-known-error": "MULTI_FACTOR_AUTHENTICATION_REQUIRED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("should return a schema error for empty e-mail address", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/auth/password/sign-in", {
    method: "POST",
    accessType: "client",
    body: {
      email: "",
      password: "some-password",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/auth/password/sign-in:
              - body.email must not be empty
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/auth/password/sign-in:
            - body.email must not be empty
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});
