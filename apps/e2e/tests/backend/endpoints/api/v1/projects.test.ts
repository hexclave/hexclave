import { isBase64Url } from "@hexclave/shared/dist/utils/bytes";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { it } from "../../../../helpers";
import { Auth, InternalApiKey, InternalProjectKeys, Project, backendContext, niceBackendFetch } from "../../../backend-helpers";


// TODO some of the tests here test /api/v1/projects/current, the others test /api/v1/internal/projects/current. We should split them into different test files

it("should not have access to the project without project keys", async ({ expect }) => {
  backendContext.set({
    projectKeys: 'no-project'
  });
  const response = await niceBackendFetch("/api/v1/internal/projects/current", { accessType: "client" });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "ACCESS_TYPE_WITHOUT_PROJECT_ID",
        "details": { "request_type": "client" },
        "error": deindent\`
          The x-hexclave-access-type header was 'client', but the x-hexclave-project-id header was not provided. (The legacy x-stack-access-type and x-stack-project-id headers are also accepted.)
          
          For more information, see the docs on REST API authentication: https://docs.hexclave.com/api/overview#authentication
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "ACCESS_TYPE_WITHOUT_PROJECT_ID",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("gets current project (internal)", async ({ expect }) => {
  backendContext.set({ projectKeys: InternalProjectKeys });
  const response = await niceBackendFetch("/api/v1/projects/current", { accessType: "client" });
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
          "client_team_creation_enabled": true,
          "client_user_deletion_enabled": false,
          "credential_enabled": true,
          "domains": [],
          "enabled_oauth_providers": [
            { "id": "github" },
            { "id": "google" },
            { "id": "microsoft" },
            { "id": "spotify" },
          ],
          "magic_link_enabled": true,
          "passkey_enabled": false,
          "sign_up_enabled": true,
        },
        "config_warnings": [],
        "display_name": "Hexclave Dashboard",
        "id": "internal",
        "is_development_environment": false,
        "pushed_config_error": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("creates and updates the basic project information of a project", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const { updateProjectResponse: response } = await Project.updateCurrent(adminAccessToken, {
    display_name: "Updated Project",
    description: "Updated description",
    is_production_mode: true,
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

it("updates the basic project configuration", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const { updateProjectResponse: response } = await Project.updateCurrent(adminAccessToken, {
    config: {
      allow_localhost: false,
      sign_up_enabled: false,
      credential_enabled: false,
      magic_link_enabled: true,
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "config": {
          "allow_localhost": false,
          "allow_promo_codes": false,
          "allow_stacking_promo_codes": false,
          "allow_team_api_keys": false,
          "allow_user_api_keys": false,
          "client_team_creation_enabled": false,
          "client_user_deletion_enabled": false,
          "create_team_on_sign_up": false,
          "credential_enabled": false,
          "domains": [],
          "email_config": { "type": "shared" },
          "email_theme": "<stripped UUID>",
          "enabled_oauth_providers": [],
          "magic_link_enabled": true,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": false,
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

it("updates the project domains configuration", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const { updateProjectResponse: response1 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      domains: [{
        domain: 'https://trusted-domain.stack-test.example.com',
        handler_path: '/handler'
      }]
    },
  });
  expect(response1).toMatchInlineSnapshot(`
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
          "domains": [
            {
              "domain": "https://trusted-domain.stack-test.example.com",
              "handler_path": "/handler",
            },
          ],
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

  const { updateProjectResponse: response2 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      domains: [
        {
          domain: 'https://trusted-domain2.stack-test.example.com',
          handler_path: '/handler'
        },
        {
          domain: 'https://trusted-domain3.stack-test.example.com',
          handler_path: '/handler2'
        }
      ]
    },
  });
  expect(response2).toMatchInlineSnapshot(`
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
          "domains": [
            {
              "domain": "https://trusted-domain2.stack-test.example.com",
              "handler_path": "/handler",
            },
            {
              "domain": "https://trusted-domain3.stack-test.example.com",
              "handler_path": "/handler2",
            },
          ],
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

it("should allow insecure HTTP connections if insecureHttp is true", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const { updateProjectResponse: response } = await Project.updateCurrent(adminAccessToken, {
    config: {
      domains: [{
        domain: 'http://insecure-domain.stack-test.example.com',
        handler_path: '/handler'
      }]
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
          "domains": [
            {
              "domain": "http://insecure-domain.stack-test.example.com",
              "handler_path": "/handler",
            },
          ],
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

it("should not allow protocols other than http(s) in trusted domains", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const { updateProjectResponse: response } = await Project.updateCurrent(adminAccessToken, {
    config: {
      domains: [{
        domain: 'whatever://disallowed-domain.stack-test.example.com',
        handler_path: '/handler'
      }]
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on PATCH /api/v1/internal/projects/current:
              - URL must start with http:// or https://
          \`,
        },
        "error": deindent\`
          Request validation failed on PATCH /api/v1/internal/projects/current:
            - URL must start with http:// or https://
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("updates the project email configuration", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const { updateProjectResponse: response1 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      email_config: {
        type: "standard",
        host: "smtp.example.com",
        port: 587,
        username: "test username",
        password: "test password",
        sender_name: "Test Sender",
        sender_email: "test@email.com",
      },
    },
  });
  expect(response1).toMatchInlineSnapshot(`
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
            "password": "test password",
            "port": <stripped field 'port'>,
            "sender_email": "test@email.com",
            "sender_name": "Test Sender",
            "type": "standard",
            "username": "test username",
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

  // update standard email config again
  const { updateProjectResponse: response2 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      email_config: {
        type: "standard",
        host: "smtp.example2.com",
        port: 587,
        username: "test username2",
        password: "test password2",
        sender_name: "Test Sender2",
        sender_email: "test@email.com2",
      },
    },
  });
  expect(response2).toMatchInlineSnapshot(`
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
            "host": "smtp.example2.com",
            "password": "test password2",
            "port": <stripped field 'port'>,
            "sender_email": "test@email.com2",
            "sender_name": "Test Sender2",
            "type": "standard",
            "username": "test username2",
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

  // switch back to shared email config
  const { updateProjectResponse: response3 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      email_config: {
        type: "shared",
      },
    },
  });
  expect(response3).toMatchInlineSnapshot(`
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

  // update to shared again
  const { updateProjectResponse: response4 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      email_config: {
        type: "shared",
      },
    },
  });
  expect(response4).toMatchInlineSnapshot(`
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

  // check if the second project still has the same email config
  const { updateProjectResponse: response2p2 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      email_config: {
        type: "standard",
        host: "smtp.control-group.com",
        port: 587,
        username: "control group",
        password: "control group",
        sender_name: "Control Group",
        sender_email: "control-group@email.com",
      },
    },
  });
  expect(response2p2).toMatchInlineSnapshot(`
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
            "host": "smtp.control-group.com",
            "password": "control group",
            "port": <stripped field 'port'>,
            "sender_email": "control-group@email.com",
            "sender_name": "Control Group",
            "type": "standard",
            "username": "control group",
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

it("does not update project email config to empty host", async ({ expect }) => {
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const { updateProjectResponse: response } = await Project.updateCurrent(adminAccessToken, {
    config: {
      email_config: {
        type: "standard",
        host: "",
        port: 587,
        username: "test username",
        password: "test password",
        sender_name: "Test Sender",
        sender_email: "test@email.com",
      },
    },
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on PATCH /api/v1/internal/projects/current:
              - body.config.email_config.host must not be empty
          \`,
        },
        "error": deindent\`
          Request validation failed on PATCH /api/v1/internal/projects/current:
            - body.config.email_config.host must not be empty
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("updates the project email configuration with invalid parameters", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  const { updateProjectResponse: response1 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      email_config: {
        type: "shared",
        client_id: "client_id",
      } as any,
    },
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on PATCH /api/v1/internal/projects/current:
              - body.config.email_config contains unknown properties: client_id
          \`,
        },
        "error": deindent\`
          Request validation failed on PATCH /api/v1/internal/projects/current:
            - body.config.email_config contains unknown properties: client_id
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);

  const response2 = await Project.updateCurrent(adminAccessToken, {
    config: {
      email_config: {
        type: "standard",
      },
    },
  });
  expect(response2).toMatchInlineSnapshot(`
    {
      "updateProjectResponse": NiceResponse {
        "status": 400,
        "body": {
          "code": "SCHEMA_ERROR",
          "details": {
            "message": deindent\`
              Request validation failed on PATCH /api/v1/internal/projects/current:
                - body.config.email_config.host must be defined
                - body.config.email_config.port must be defined
                - body.config.email_config.username must be defined
                - body.config.email_config.password must be defined
                - body.config.email_config.sender_name must be defined
                - body.config.email_config.sender_email must be defined
            \`,
          },
          "error": deindent\`
            Request validation failed on PATCH /api/v1/internal/projects/current:
              - body.config.email_config.host must be defined
              - body.config.email_config.port must be defined
              - body.config.email_config.username must be defined
              - body.config.email_config.password must be defined
              - body.config.email_config.sender_name must be defined
              - body.config.email_config.sender_email must be defined
          \`,
        },
        "headers": Headers {
          "x-stack-known-error": "SCHEMA_ERROR",
          <some fields may have been hidden>,
        },
      },
    }
  `);
});

it("updates the project oauth configuration", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();
  // create google oauth provider with shared type
  const { updateProjectResponse: response1 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      oauth_providers: [{
        id: "google",
        type: "shared",
      }]
    },
  });
  expect(response1).toMatchInlineSnapshot(`
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
          "enabled_oauth_providers": [{ "id": "google" }],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [
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

  // update google oauth provider with shared type again
  const { updateProjectResponse: response2 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      oauth_providers: [{
        id: "google",
        type: "shared",
      }]
    },
  });
  expect(response2).toMatchInlineSnapshot(`
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
          "enabled_oauth_providers": [{ "id": "google" }],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [
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

  // switch to standard type
  const { updateProjectResponse: response3 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      oauth_providers: [{
        id: "google",
        type: "standard",
        client_id: "client_id",
        client_secret: "client_secret",
      }]
    },
  });
  expect(response3).toMatchInlineSnapshot(`
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
          "enabled_oauth_providers": [{ "id": "google" }],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [
            {
              "client_id": "client_id",
              "client_secret": "client_secret",
              "id": "google",
              "provider_config_id": "google",
              "type": "standard",
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

  const { updateProjectResponse: response4 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      oauth_providers: [{
        id: "spotify",
        type: "shared",
      }]
    },
  });
  expect(response4).toMatchInlineSnapshot(`
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
          "enabled_oauth_providers": [{ "id": "spotify" }],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [
            {
              "id": "spotify",
              "provider_config_id": "spotify",
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

  // add another oauth provider
  const { updateProjectResponse: response5 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      oauth_providers: [
        {
          id: "spotify",
          type: "shared",
        },
        {
          id: "google",
          type: "shared",
        }
      ]
    },
  });
  expect(response5).toMatchInlineSnapshot(`
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
            { "id": "google" },
            { "id": "spotify" },
          ],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [
            {
              "id": "google",
              "provider_config_id": "google",
              "type": "shared",
            },
            {
              "id": "spotify",
              "provider_config_id": "spotify",
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

  // disable one of the oauth providers
  const { updateProjectResponse: response6 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      oauth_providers: [
        {
          id: "spotify",
          type: "shared",
        },
        {
          id: "google",
          type: "shared",
        }
      ]
    },
  });
  expect(response6).toMatchInlineSnapshot(`
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
            { "id": "google" },
            { "id": "spotify" },
          ],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [
            {
              "id": "google",
              "provider_config_id": "google",
              "type": "shared",
            },
            {
              "id": "spotify",
              "provider_config_id": "spotify",
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

it("fails when trying to update OAuth provider with empty client_secret", async ({ expect }) => {
  await Project.createAndSwitch();
  const response = await niceBackendFetch(`/api/v1/internal/projects/current`, {
    accessType: "admin",
    method: "PATCH",
    body: {
      config: {
        oauth_providers: [{
          id: "google",
          type: "standard",
          client_id: "client_id",
          client_secret: ""
        }]
      }
    }
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on PATCH /api/v1/internal/projects/current:
              - client_secret is required for standard providers, unless the provider is apple with all Apple key credentials set
          \`,
        },
        "error": deindent\`
          Request validation failed on PATCH /api/v1/internal/projects/current:
            - client_secret is required for standard providers, unless the provider is apple with all Apple key credentials set
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("deletes a project with admin access", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();

  // Delete the project
  const deleteResponse = await niceBackendFetch(`/api/v1/internal/projects/current`, {
    accessType: "admin",
    method: "DELETE",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    }
  });

  expect(deleteResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("deletes a project with server access", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();

  // Delete the project
  const deleteResponse = await niceBackendFetch(`/api/v1/internal/projects/current`, {
    accessType: "server",
    method: "DELETE",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    }
  });

  expect(deleteResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "INSUFFICIENT_ACCESS_TYPE",
        "details": {
          "actual_access_type": "server",
          "allowed_access_types": ["admin"],
        },
        "error": "The x-hexclave-access-type header must be 'admin', but was 'server'. (The legacy x-stack-access-type header is also accepted.)",
      },
      "headers": Headers {
        "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("deletes a project with users, teams, and permissions", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken, createProjectResponse } = await Project.createAndGetAdminToken({
    config: {
      magic_link_enabled: true,
      oauth_providers: [
        {
          id: "google",
          type: "shared",
        },
        {
          id: "spotify",
          type: "standard",
          client_id: "client_id",
          client_secret: "client_secret",
        }
      ]
    }
  });

  // Create a user
  const userResponse = await niceBackendFetch(`/api/v1/users`, {
    accessType: "server",
    method: "POST",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    },
    body: {
      primary_email: "test@test.com",
      password: "testing",
      primary_email_auth_enabled: true,
    }
  });
  expect(userResponse.status).toBe(201);

  // Create a team
  const teamResponse = await niceBackendFetch(`/api/v1/teams`, {
    accessType: "server",
    method: "POST",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    },
    body: {
      display_name: "Test Team",
    }
  });
  expect(teamResponse.status).toBe(201);

  // create a team permission
  const teamPermissionResponse = await niceBackendFetch(`/api/v1/team-permission-definitions`, {
    accessType: "admin",
    method: "POST",
    body: {
      id: 'p1'
    },
    headers: {
      'x-stack-admin-access-token': adminAccessToken
    },
  });
  expect(teamPermissionResponse.status).toBe(201);

  // Delete the project
  const deleteResponse = await niceBackendFetch(`/api/v1/internal/projects/current`, {
    accessType: "admin",
    method: "DELETE",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    }
  });

  expect(deleteResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // make sure that the project no longer exists
  const getProjectResponse = await niceBackendFetch(`/api/v1/projects/current`, {
    accessType: "admin",
    method: "GET",
  });
  expect(getProjectResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "CURRENT_PROJECT_NOT_FOUND",
        "details": { "project_id": "<stripped UUID>" },
        "error": "The current project with ID <stripped UUID> was not found. Please check the value of the x-hexclave-project-id header. (The legacy x-stack-project-id header is also accepted.)",
      },
      "headers": Headers {
        "x-stack-known-error": "CURRENT_PROJECT_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("does not allow accessing a current project that doesn't exist", async ({ expect }) => {
  backendContext.set({
    projectKeys: {
      projectId: "does-not-exist",
    },
  });
  const response = await niceBackendFetch(`/api/v1/projects/current`, {
    accessType: "admin",
    method: "GET",
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "CURRENT_PROJECT_NOT_FOUND",
        "details": { "project_id": "does-not-exist" },
        "error": "The current project with ID does-not-exist was not found. Please check the value of the x-hexclave-project-id header. (The legacy x-stack-project-id header is also accepted.)",
      },
      "headers": Headers {
        "x-stack-known-error": "CURRENT_PROJECT_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("does not allow accessing a project with the wrong API keys", async ({ expect }) => {
  await Project.createAndSwitch();
  await InternalApiKey.createAndSetProjectKeys();
  backendContext.set({
    projectKeys: {
      projectId: (backendContext.value.projectKeys as any).projectId,
      publishableClientKey: "fake publishable client key",
      secretServerKey: "fake secret server key",
      superSecretAdminKey: "fake admin key",
    }
  });
  const response = await niceBackendFetch(`/api/v1/projects/current`, {
    accessType: "admin",
    method: "GET",
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "INVALID_SUPER_SECRET_ADMIN_KEY",
        "details": { "project_id": "<stripped UUID>" },
        "error": "The super secret admin key is not valid for the project \\"<stripped UUID>\\". Does the project and/or the key exist?",
      },
      "headers": Headers {
        "x-stack-known-error": "INVALID_SUPER_SECRET_ADMIN_KEY",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("does not allow accessing a project without a project ID header", async ({ expect }) => {
  backendContext.set({ projectKeys: "no-project" });
  const response = await niceBackendFetch(`/api/v1/projects/current`, {
    accessType: "admin",
    method: "GET",
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "ACCESS_TYPE_WITHOUT_PROJECT_ID",
        "details": { "request_type": "admin" },
        "error": deindent\`
          The x-hexclave-access-type header was 'admin', but the x-hexclave-project-id header was not provided. (The legacy x-stack-access-type and x-stack-project-id headers are also accepted.)
          
          For more information, see the docs on REST API authentication: https://docs.hexclave.com/api/overview#authentication
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "ACCESS_TYPE_WITHOUT_PROJECT_ID",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("makes sure users own the correct projects after creating a project", async ({ expect }) => {
  backendContext.set({ projectKeys: InternalProjectKeys });
  const { creatorUserId, projectId, adminAccessToken } = await Project.createAndGetAdminToken();

  backendContext.set({ projectKeys: InternalProjectKeys });
  const userResponse = await niceBackendFetch(`/api/v1/users/${creatorUserId}`, {
    accessType: "server",
    method: "GET",
  });
  backendContext.set({ projectKeys: { projectId, adminAccessToken } });
  const projectResponse = await niceBackendFetch(`/api/v1/internal/projects/current`, {
    accessType: "admin",
    method: "GET",
  });
  expect(projectResponse.body.owner_team_id).toBe(userResponse.body.selected_team.id);
});

it("removes a deleted project from a user", async ({ expect }) => {
  backendContext.set({ projectKeys: InternalProjectKeys });
  await Auth.fastSignUp();
  const adminAccessToken = backendContext.value.userAuth?.accessToken;
  const { projectId } = await Project.create();

  const projectResponse = await niceBackendFetch(`/api/v1/internal/projects`, {
    accessType: "client",
  });
  expect(projectResponse.body.items.length).toBe(1);

  // Delete the project
  backendContext.set({ projectKeys: { projectId, adminAccessToken }, userAuth: null });
  const deleteResponse = await niceBackendFetch(`/api/v1/internal/projects/current`, {
    accessType: "admin",
    method: "DELETE",
  });

  expect(deleteResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const projectResponse2 = await niceBackendFetch(`/api/v1/internal/projects`, {
    accessType: "admin",
  });
  expect(projectResponse2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "CURRENT_PROJECT_NOT_FOUND",
        "details": { "project_id": "<stripped UUID>" },
        "error": "The current project with ID <stripped UUID> was not found. Please check the value of the x-hexclave-project-id header. (The legacy x-stack-project-id header is also accepted.)",
      },
      "headers": Headers {
        "x-stack-known-error": "CURRENT_PROJECT_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("makes sure other users are not affected by project deletion", async ({ expect }) => {
  backendContext.set({ projectKeys: InternalProjectKeys });
  await Auth.fastSignUp();
  const user1Auth = backendContext.value.userAuth;
  const { projectId } = await Project.create();

  backendContext.set({ projectKeys: InternalProjectKeys });
  const { adminAccessToken } = await Project.createAndGetAdminToken();

  // Delete the project
  await niceBackendFetch(`/api/v1/internal/projects/current`, {
    accessType: "admin",
    method: "DELETE",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    }
  });

  backendContext.set({ projectKeys: InternalProjectKeys, userAuth: user1Auth });
  const projectResponse = await niceBackendFetch(`/api/v1/internal/projects`, {
    accessType: "client",
  });

  expect(projectResponse.body.items.length).toBe(1);
  expect(projectResponse.body.items[0].id).toBe(projectId);
});

it("has a correctly formatted JWKS endpoint", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/projects/internal/.well-known/jwks.json");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).includes("application/json");
  expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  expect(response.body).toEqual({
    keys: [
      {
        alg: "ES256",
        crv: "P-256",
        kid: expect.any(String),
        kty: "EC",
        x: expect.toSatisfy(isBase64Url),
        y: expect.toSatisfy(isBase64Url),
      },
      {
        alg: "ES256",
        crv: "P-256",
        kid: expect.any(String),
        kty: "EC",
        x: expect.toSatisfy(isBase64Url),
        y: expect.toSatisfy(isBase64Url),
      },
    ],
  });
});

it("should increment and decrement userCount when a user is added to a project", async ({ expect }) => {
  await Project.createAndSwitch({
    config: {
      magic_link_enabled: true,
    }
  });
  const initialProjectResponse = await niceBackendFetch("/api/v1/internal/metrics", { accessType: "admin" });
  expect(initialProjectResponse.status).toBe(200);
  expect(initialProjectResponse.body.total_users).toBe(0);


  // Create a new user in the project
  await Auth.Password.signUpWithEmail();

  // The metrics endpoint reads from ClickHouse (eventual consistency).
  // Poll until the new user is visible.
  const incrementStart = performance.now();
  while (true) {
    const updatedProjectResponse = await niceBackendFetch("/api/v1/internal/metrics", { accessType: "admin" });
    expect(updatedProjectResponse.status).toBe(200);
    if (updatedProjectResponse.body.total_users === 1) {
      break;
    }
    if (performance.now() - incrementStart > 30_000) {
      expect(updatedProjectResponse.body.total_users).toBe(1);
    }
    await wait(500);
  }

  // Delete the user
  const deleteRes = await niceBackendFetch("/api/v1/users/me", {
    accessType: "admin",
    method: "DELETE",
  });
  expect(deleteRes.status).toBe(200);

  // The metrics endpoint now reads from ClickHouse, which has eventual
  // consistency. Poll until the delete has propagated.
  const startedAt = performance.now();
  while (true) {
    const finalProjectResponse = await niceBackendFetch("/api/v1/internal/metrics", { accessType: "admin" });
    expect(finalProjectResponse.status).toBe(200);
    if (finalProjectResponse.body.total_users === 0) {
      break;
    }
    if (performance.now() - startedAt > 30_000) {
      expect(finalProjectResponse.body.total_users).toBe(0);
    }
    await wait(500);
  }

});

it("should preserve API Keys app enabled state when updating allowUserApiKeys config", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();

  // Enable the API Keys app
  const enableAppResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
    accessType: "admin",
    method: "PATCH",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    },
    body: {
      config_override_string: JSON.stringify({
        'apps.installed.api-keys': {
          enabled: true,
        },
      }),
    },
  });
  expect(enableAppResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": { "success": true },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Verify the API Keys app is enabled
  const getConfigResponse1 = await niceBackendFetch("/api/v1/internal/config", {
    accessType: "admin",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    },
  });
  expect(getConfigResponse1.status).toBe(200);
  expect(JSON.parse(getConfigResponse1.body.config_string).apps.installed["api-keys"]).toMatchInlineSnapshot(`
    { "enabled": true }
  `);

  // Update allowUserApiKeys using the old project update endpoint
  const { updateProjectResponse } = await Project.updateCurrent(adminAccessToken, {
    config: {
      allow_user_api_keys: true,
    },
  });
  expect(updateProjectResponse.status).toBe(200);
  expect(updateProjectResponse.body.config.allow_user_api_keys).toBe(true);

  // Verify the API Keys app is still enabled after the update
  const getConfigResponse2 = await niceBackendFetch("/api/v1/internal/config", {
    accessType: "admin",
    headers: {
      'x-stack-admin-access-token': adminAccessToken,
    },
  });
  expect(getConfigResponse2.status).toBe(200);
  expect(JSON.parse(getConfigResponse2.body.config_string).apps.installed["api-keys"]).toMatchInlineSnapshot(`
    { "enabled": true }
  `);
});
