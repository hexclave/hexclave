import { it } from "../../../../../helpers";
import { Auth, InternalProjectClientKeys, InternalProjectKeys, Project, backendContext, niceBackendFetch } from "../../../../backend-helpers";


it("should not have have access to the project", async ({ expect }) => {
  backendContext.set({ projectKeys: 'no-project' });
  const response1 = await niceBackendFetch("/api/v1/internal/projects", { accessType: "client" });
  expect(response1).toMatchInlineSnapshot(`
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


it("is not allowed to list all current projects without signing in", async ({ expect }) => {
  const response = await niceBackendFetch("/api/v1/internal/projects", { accessType: "client" });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "USER_AUTHENTICATION_REQUIRED",
        "error": "User authentication required for this endpoint.",
      },
      "headers": Headers {
        "x-stack-known-error": "USER_AUTHENTICATION_REQUIRED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("is not allowed to list internal projects from a non-internal project context", async ({ expect }) => {
  await Project.createAndSwitch();
  await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/v1/internal/projects", { accessType: "admin" });
  expect(response.status).toBe(401);
  expect(response.headers.get("x-stack-known-error")).toBe("EXPECTED_INTERNAL_PROJECT");
  expect(response.body).toMatchObject({
    code: "EXPECTED_INTERNAL_PROJECT",
    error: "The project ID is expected to be internal.",
  });
});

it("lists all current projects (empty list)", async ({ expect }) => {
  await Auth.fastSignUp();
  const response = await niceBackendFetch("/api/v1/internal/projects", { accessType: "client" });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("creates a new project", async ({ expect }) => {
  backendContext.set({ projectKeys: InternalProjectKeys });
  await Auth.fastSignUp();
  backendContext.set({ projectKeys: InternalProjectClientKeys });
  const result = await Project.createAndGetAdminToken({
    display_name: "Test Project",
  });
  expect(result.createProjectResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "config": {
          "allow_localhost": true,
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
        "display_name": "Test Project",
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

it("updates onboarding status and state together without modifying config", async ({ expect }) => {
  await Project.createAndSwitch();
  const beforeResponse = await niceBackendFetch("/api/v1/internal/projects/current", {
    accessType: "admin",
  });
  expect(beforeResponse.status).toBe(200);

  const onboardingState = {
    selected_config_choice: "create-new" as const,
    selected_apps: ["authentication", "emails", "payments"] as const,
    selected_sign_in_methods: ["credential", "magicLink"] as const,
    selected_email_theme_id: "a0172b5d-cff0-463b-83bb-85124697373a",
    selected_payments_country: "US" as const,
  };

  const patchResponse = await niceBackendFetch("/api/v1/internal/projects/current", {
    accessType: "admin",
    method: "PATCH",
    body: {
      onboarding_status: "auth_setup",
      onboarding_state: onboardingState,
    },
  });
  expect(patchResponse.status).toBe(200);
  expect(patchResponse.body.onboarding_status).toBe("auth_setup");
  expect(patchResponse.body.onboarding_state).toEqual(onboardingState);
  expect(patchResponse.body.config).toEqual(beforeResponse.body.config);

  const afterResponse = await niceBackendFetch("/api/v1/internal/projects/current", {
    accessType: "admin",
  });
  expect(afterResponse.status).toBe(200);
  expect(afterResponse.body.onboarding_status).toBe("auth_setup");
  expect(afterResponse.body.onboarding_state).toEqual(onboardingState);
  expect(afterResponse.body.config).toEqual(beforeResponse.body.config);
});

it("persists versioned cloud onboarding progress without modifying config", async ({ expect }) => {
  await Project.createAndSwitch();
  const beforeResponse = await niceBackendFetch("/api/v1/internal/projects/current", {
    accessType: "admin",
  });
  expect(beforeResponse.status).toBe(200);

  const onboardingState = {
    version: 1 as const,
    step: "setup-github-workflow" as const,
    journey: "add" as const,
    primary_app_id: "authentication" as const,
    additional_app_ids: [] as const,
    selected_apps: ["authentication", "analytics"] as const,
    selected_sign_in_methods: ["credential", "github"] as const,
    selected_email_theme_id: "a0172b5d-cff0-463b-83bb-85124697373a",
    project_location: "github" as const,
  };

  const patchResponse = await niceBackendFetch("/api/v1/internal/projects/current", {
    accessType: "admin",
    method: "PATCH",
    body: {
      onboarding_status: "config_choice",
      onboarding_state: onboardingState,
    },
  });
  expect(patchResponse.status).toBe(200);
  expect(patchResponse.body.onboarding_status).toBe("config_choice");
  expect(patchResponse.body.onboarding_state).toEqual(onboardingState);
  expect(patchResponse.body.config).toEqual(beforeResponse.body.config);

  const afterResponse = await niceBackendFetch("/api/v1/internal/projects/current", {
    accessType: "admin",
  });
  expect(afterResponse.status).toBe(200);
  expect(afterResponse.body.onboarding_state).toEqual(onboardingState);
  expect(afterResponse.body.config).toEqual(beforeResponse.body.config);
});

it("creates a new project with different configurations", async ({ expect }) => {
  backendContext.set({ projectKeys: InternalProjectKeys });
  await Auth.fastSignUp();
  backendContext.set({ projectKeys: InternalProjectClientKeys });
  const { createProjectResponse: response1 } = await Project.create({
    display_name: "Test Project",
    description: "Test description",
    is_production_mode: true,
    config: {
      allow_localhost: false,
      sign_up_enabled: false,
      credential_enabled: false,
      magic_link_enabled: true,
    },
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "config": {
          "allow_localhost": false,
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
        "description": "Test description",
        "display_name": "Test Project",
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

  // create with oauth providers
  const { createProjectResponse: response2 } = await Project.create({
    display_name: "Test Project",
    config: {
      oauth_providers: [
        {
          id: "google",
          type: "shared",
        }
      ]
    },
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "config": {
          "allow_localhost": true,
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
        "display_name": "Test Project",
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

  // create with shared email config
  const { createProjectResponse: response3 } = await Project.create({
    display_name: "Test Project",
    config: {
      email_config: {
        type: "shared",
      },
    },
  });
  expect(response3).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "config": {
          "allow_localhost": true,
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
        "display_name": "Test Project",
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

  // create with standard email config
  const { createProjectResponse: response4 } = await Project.create({
    display_name: "Test Project",
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
  expect(response4).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "config": {
          "allow_localhost": true,
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
        "display_name": "Test Project",
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

  // create with domains
  const { createProjectResponse: response5 } = await Project.create({
    display_name: "Test Project",
    config: {
      domains: [
        {
          domain: 'https://domain1.com',
          handler_path: '/handler1'
        },
        {
          domain: 'https://domain2.com',
          handler_path: '/handler2'
        }
      ]
    },
  });
  expect(response5).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "config": {
          "allow_localhost": true,
          "allow_team_api_keys": false,
          "allow_user_api_keys": false,
          "client_team_creation_enabled": false,
          "client_user_deletion_enabled": false,
          "create_team_on_sign_up": false,
          "credential_enabled": true,
          "domains": [
            {
              "domain": "https://domain1.com",
              "handler_path": "/handler1",
            },
            {
              "domain": "https://domain2.com",
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
        "display_name": "Test Project",
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

it("lists the current projects after creating a new project", async ({ expect }) => {
  await Auth.fastSignUp();
  await Project.create();
  const response = await niceBackendFetch("/api/v1/internal/projects", { accessType: "client" });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "config": {
              "allow_localhost": true,
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
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("verifies email_theme update persists", async ({ expect }) => {
  await Project.createAndSwitch();
  const patchResponse = await niceBackendFetch("/api/v1/internal/projects/current", {
    method: "PATCH",
    accessType: "admin",
    body: {
      config: {
        email_theme: "a0172b5d-cff0-463b-83bb-85124697373a" // default-dark
      }
    }
  });
  expect(patchResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "config": {
          "allow_localhost": true,
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

  const response = await niceBackendFetch("/api/v1/internal/projects/current", {
    accessType: "admin"
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "config": {
          "allow_localhost": true,
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
  expect(response.body.config.email_theme).toBe("a0172b5d-cff0-463b-83bb-85124697373a"); // default-dark
});

it("updates trusted domains without modifying allow_localhost", async ({ expect }) => {
  await Project.createAndSwitch();
  const response1 = await niceBackendFetch("/api/v1/internal/projects/current", {
    method: "PATCH",
    accessType: "admin",
    body: {
      config: {
        allow_localhost: false,
      },
    },
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "config": {
          "allow_localhost": false,
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

  const response2 = await niceBackendFetch("/api/v1/internal/projects/current", {
    method: "PATCH",
    accessType: "admin",
    body: {
      config: {
        domains: [
          { domain: "https://example.com", handler_path: "/handler" },
        ],
      },
    },
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "config": {
          "allow_localhost": false,
          "allow_team_api_keys": false,
          "allow_user_api_keys": false,
          "client_team_creation_enabled": false,
          "client_user_deletion_enabled": false,
          "create_team_on_sign_up": false,
          "credential_enabled": true,
          "domains": [
            {
              "domain": "https://example.com",
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

it("gives an error when updating email_theme with an invalid value", async ({ expect }) => {
  await Project.createAndSwitch();

  const response = await niceBackendFetch("/api/v1/internal/projects/current", {
    method: "PATCH",
    accessType: "admin",
    body: {
      config: {
        email_theme: "some-invalid-theme",
      }
    }
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Invalid email theme",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("lets user update logo_url to a valid image", async ({ expect }) => {
  await Project.createAndSwitch();
  // 1x1 png
  const logo_url = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAD0lEQVR4AQEEAPv/ALHBwQRaAjRgT7lCAAAAAElFTkSuQmCC`;
  const response = await niceBackendFetch("/api/v1/internal/projects/current", {
    method: "PATCH",
    accessType: "admin",
    body: {
      logo_url,
    }
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "config": {
          "allow_localhost": true,
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
        "logo_url": "http://localhost:<$NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX>21/stack-storage/project-logos/<stripped UUID>.png",
        "onboarding_status": "completed",
        "owner_team_id": "<stripped UUID>",
        "pushed_config_error": null,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});
