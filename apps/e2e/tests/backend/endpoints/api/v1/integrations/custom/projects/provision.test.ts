import { it } from "../../../../../../../helpers";
import { backendContext, niceBackendFetch } from "../../../../../../backend-helpers";
import { provisionProject } from "./provision-helpers";

it("should be able to provision a new project if client details are correct", async ({ expect }) => {
  const response = await provisionProject();
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "project_id": "<stripped UUID>",
        "super_secret_admin_key": <stripped field 'super_secret_admin_key'>,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);


  // test API keys
  backendContext.set({
    projectKeys: {
      projectId: response.body.project_id,
      superSecretAdminKey: response.body.super_secret_admin_key,
    },
  });
  const project = await niceBackendFetch(`/api/v1/internal/projects/current`, {
    method: "GET",
    accessType: "admin",
  });
  expect(project).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "config": {
          "allow_localhost": true,
          "allow_promo_codes": false,
          "allow_stacking_promo_codes": false,
          "allow_team_api_keys": false,
          "allow_user_api_keys": false,
          "client_team_creation_enabled": false,
          "client_user_deletion_enabled": false,
          "create_team_on_sign_up": false,
          "credential_enabled": true,
          "domains": [],
          "email_config": { "type": "shared" },
          "email_theme": "<stripped UUID>",
          "enabled_oauth_providers": [
            { "id": "github" },
            { "id": "google" },
          ],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [
            {
              "id": "github",
              "provider_config_id": "github",
              "type": "shared",
            },
            {
              "id": "google",
              "provider_config_id": "google",
              "type": "shared",
            },
          ],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "config_warnings": [],
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "Project created by an external integration",
        "display_name": "Test project",
        "id": "<stripped UUID>",
        "is_development_environment": false,
        "is_production_mode": false,
        "logo_dark_mode_url": null,
        "logo_full_dark_mode_url": null,
        "logo_full_url": null,
        "logo_url": null,
        "onboarding_status": "completed",
        "owner_team_id": null,
        "pushed_config_error": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should fail if the client details are incorrect", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/integrations/custom/projects/provision", {
    method: "POST",
    body: {
      display_name: "Test project",
    },
    headers: {
      "Authorization": "Basic bmVvbi1sb2NhbDpuZW9uLWxvY2FsLXMlY3JldA==",
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/integrations/custom/projects/provision:
              - Invalid client_id:client_secret values; did you use the correct values for the integration?
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/integrations/custom/projects/provision:
            - Invalid client_id:client_secret values; did you use the correct values for the integration?
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});


it("should fail if the neon client details are missing", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/integrations/custom/projects/provision", {
    method: "POST",
    body: {
      display_name: "Test project",
    },
  });
  expect(response).toMatchInlineSnapshot(`
  NiceResponse {
    "status": 400,
    "body": {
      "code": "SCHEMA_ERROR",
      "details": {
        "message": deindent\`
          Request validation failed on POST /api/v1/integrations/custom/projects/provision:
            - headers.authorization must be defined
        \`,
      },
      "error": deindent\`
        Request validation failed on POST /api/v1/integrations/custom/projects/provision:
          - headers.authorization must be defined
      \`,
    },
    "headers": Headers {
      "x-stack-known-error": "SCHEMA_ERROR",
      <some fields may have been hidden>,
    },
  }
`);
});
