import { it } from "../../../../../../helpers";
import { Auth, Project, niceBackendFetch } from "../../../../../backend-helpers";

it("allows anonymous users to sign up on the internal project", async ({ expect }) => {
  await Auth.Anonymous.signUp();
  const me = await niceBackendFetch("/api/v1/users/me", {
    accessType: "client",
    headers: {
      "x-stack-allow-anonymous-user": "true",
    },
  });
  expect(me).toMatchInlineSnapshot(`
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

it("allows anonymous users to sign up on newly created projects", async ({ expect }) => {
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

it("can still sign up anonymously even if sign ups are disabled", async ({ expect }) => {
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
});
