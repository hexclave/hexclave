import { it } from "../../../../../../../helpers";
import { Auth, Project, niceBackendFetch } from "../../../../../../backend-helpers";


it("get project details", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const response = await niceBackendFetch("/api/v1/integrations/neon/projects/current", {
    accessType: "admin",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    },
  });
  expect(response).toMatchInlineSnapshot(`
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
          "enabled_oauth_providers": [],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "config_warnings": [],
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "",
        "display_name": "New Project",
        "id": "<stripped UUID>",
        "is_development_environment": false,
        "is_production_mode": false,
        "logo_dark_mode_url": null,
        "logo_full_dark_mode_url": null,
        "logo_full_url": null,
        "logo_url": null,
        "onboarding_status": "completed",
        "owner_team_id": "<stripped UUID>",
        "pushed_config_error": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("creates and updates the basic project information of a project", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const response = await niceBackendFetch("/api/v1/integrations/neon/projects/current", {
    accessType: "admin",
    method: "PATCH",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    },
    body: {
      display_name: "Updated Project",
      description: "Updated description",
      is_production_mode: true,
    },
  });

  expect(response).toMatchInlineSnapshot(`
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
          "enabled_oauth_providers": [],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "config_warnings": [],
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "Updated description",
        "display_name": "Updated Project",
        "id": "<stripped UUID>",
        "is_development_environment": false,
        "is_production_mode": true,
        "logo_dark_mode_url": null,
        "logo_full_dark_mode_url": null,
        "logo_full_url": null,
        "logo_url": null,
        "onboarding_status": "completed",
        "owner_team_id": "<stripped UUID>",
        "pushed_config_error": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("creates and updates the email config of a project", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const response = await niceBackendFetch("/api/v1/integrations/neon/projects/current", {
    accessType: "admin",
    method: "PATCH",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    },
    body: {
      config: {
        email_config: {
          "host": "smtp.example.com",
          "port": 587,
          "username": "username",
          "password": "this-is-a-placeholder-password",
          "sender_email": "from@example.com",
          "sender_name": "Test Sender",
          "type": "standard",
        },
      },
    },
  });

  expect(response).toMatchInlineSnapshot(`
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
          "email_config": {
            "host": "smtp.example.com",
            "password": "this-is-a-placeholder-password",
            "port": <stripped field 'port'>,
            "sender_email": "from@example.com",
            "sender_name": "Test Sender",
            "type": "standard",
            "username": "username",
          },
          "email_theme": "<stripped UUID>",
          "enabled_oauth_providers": [],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [],
        },
        "config_warnings": [],
        "created_at_millis": <stripped field 'created_at_millis'>,
        "description": "",
        "display_name": "New Project",
        "id": "<stripped UUID>",
        "is_development_environment": false,
        "is_production_mode": false,
        "logo_dark_mode_url": null,
        "logo_full_dark_mode_url": null,
        "logo_full_url": null,
        "logo_url": null,
        "onboarding_status": "completed",
        "owner_team_id": "<stripped UUID>",
        "pushed_config_error": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});
