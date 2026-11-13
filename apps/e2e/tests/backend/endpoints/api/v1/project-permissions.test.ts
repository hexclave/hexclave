import { it } from "../../../../helpers";
import { Auth, InternalApiKey, InternalProjectKeys, Project, Webhook, backendContext, niceBackendFetch } from "../../../backend-helpers";

it("is not allowed to list permissions from the other users on the client", async ({ expect }) => {
  await Auth.fastSignUp();

  const response = await niceBackendFetch(`/api/v1/project-permissions`, {
    accessType: "client",
    method: "GET",
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 403,
      "body": "Client can only list permissions for their own user. user_id must be either \\"me\\" or the ID of the current user",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("is not allowed to grant non-existing permission to a user on the server", async ({ expect }) => {
  const { userId } = await Auth.fastSignUp();

  const response = await niceBackendFetch(`/api/v1/project-permissions/${userId}/does_not_exist`, {
    accessType: "server",
    method: "POST",
    body: {},
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "PERMISSION_NOT_FOUND",
        "details": { "permission_id": "does_not_exist" },
        "error": "Permission \\"does_not_exist\\" not found. Make sure you created it on the dashboard.",
      },
      "headers": Headers {
        "x-stack-known-error": "PERMISSION_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("does not grant a team permission to a user", async ({ expect }) => {
  await Project.createAndSwitch();
  const { userId } = await Auth.fastSignUp();

  const teamPermissionDefinitionResponse = await niceBackendFetch(`/api/v1/team-permission-definitions`, {
    accessType: "admin",
    method: "POST",
    body: { id: 't1' },
  });
  expect(teamPermissionDefinitionResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "contained_permission_ids": [],
        "id": "t1",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const response = await niceBackendFetch(`/api/v1/project-permissions/${userId}/t1`, {
    accessType: "server",
    method: "POST",
    body: {},
  });
  expect(response).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "WRONG_PERMISSION_SCOPE",
        "details": {
          "actual_scope": "team",
          "expected_scope": "project",
          "permission_id": "t1",
        },
        "error": "Permission \\"t1\\" not found. (It was found for a different scope \\"team\\", but scope \\"project\\" was expected.)",
      },
      "headers": Headers {
        "x-stack-known-error": "WRONG_PERMISSION_SCOPE",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("can create a new permission and grant it to a user on the server", async ({ expect }) => {
  backendContext.set({ projectKeys: InternalProjectKeys });
  const { adminAccessToken } = await Project.createAndGetAdminToken({ config: { magic_link_enabled: true } });

  // create a permission child
  await niceBackendFetch(`/api/v1/project-permission-definitions`, {
    accessType: "admin",
    method: "POST",
    body: {
      id: 'child',
      description: 'Child permission',
    },
    headers: {
      'x-stack-admin-access-token': adminAccessToken
    },
  });

  // create a permission parent
  await niceBackendFetch(`/api/v1/project-permission-definitions`, {
    accessType: "admin",
    method: "POST",
    body: {
      id: 'parent',
      description: 'Parent permission',
      contained_permission_ids: ['child'],
    },
    headers: {
      'x-stack-admin-access-token': adminAccessToken
    },
  });

  await InternalApiKey.createAndSetProjectKeys(adminAccessToken);

  const { userId } = await Auth.Password.signUpWithEmail({ password: 'test1234' });

  // list current permissions
  const response1 = await niceBackendFetch(`/api/v1/project-permissions?user_id=me`, {
    accessType: "client",
    method: "GET",
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // grant new permission
  const response2 = await niceBackendFetch(`/api/v1/project-permissions/${userId}/parent`, {
    accessType: "server",
    method: "POST",
    body: {},
  });
  expect(response2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "id": "parent",
        "user_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // list current permissions (should have the new permission)
  const response3 = await niceBackendFetch(`/api/v1/project-permissions?user_id=me`, {
    accessType: "client",
    method: "GET",
  });
  expect(response3).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "id": "parent",
            "user_id": "<stripped UUID>",
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("can customize default user permissions", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();

  const response1 = await niceBackendFetch(`/api/v1/project-permission-definitions`, {
    accessType: "admin",
    method: "POST",
    body: {
      id: 'test'
    },
    headers: {
      'x-stack-admin-access-token': adminAccessToken
    },
  });
  expect(response1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "contained_permission_ids": [],
        "id": "test",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const { updateProjectResponse: response2 } = await Project.updateCurrent(adminAccessToken, {
    config: {
      user_default_permissions: [{ id: 'test' }],
    },
  });

  await InternalApiKey.createAndSetProjectKeys(adminAccessToken);

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
          "enabled_oauth_providers": [],
          "magic_link_enabled": false,
          "oauth_account_merge_strategy": "link_method",
          "oauth_providers": [],
          "passkey_enabled": false,
          "sign_up_enabled": true,
          "team_creator_default_permissions": [{ "id": "team_admin" }],
          "team_member_default_permissions": [{ "id": "team_member" }],
          "user_default_permissions": [{ "id": "test" }],
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

  // sign up a new user
  const { userId } = await Auth.Password.signUpWithEmail({ password: 'test1234' });
  // list permissions for the new user
  const response3 = await niceBackendFetch(`/api/v1/project-permissions?user_id=${userId}`, {
    accessType: "client",
    method: "GET",
  });
  expect(response3).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "is_paginated": false,
        "items": [
          {
            "id": "test",
            "user_id": "<stripped UUID>",
          },
        ],
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("should trigger project permission webhook when a permission is granted to a user", async ({ expect }) => {
  const { projectId, svixToken, endpointId } = await Webhook.createProjectWithEndpoint();

  const { userId } = await Auth.fastSignUp();

  await niceBackendFetch(`/api/v1/project-permission-definitions`, {
    accessType: "admin",
    method: "POST",
    body: { id: 'test_permission' },
  });

  const grantPermissionResponse = await niceBackendFetch(`/api/v1/project-permissions/${userId}/test_permission`, {
    accessType: "server",
    method: "POST",
    body: {},
  });

  expect(grantPermissionResponse.status).toBe(201);

  const projectPermissionCreatedEvent = await Webhook.findWebhookAttempt(projectId, endpointId, svixToken, event => event.eventType === "project_permission.created");

  expect(projectPermissionCreatedEvent).toMatchInlineSnapshot(`
    {
      "channels": null,
      "eventId": null,
      "eventType": "project_permission.created",
      "id": "<stripped svix message id>",
      "payload": {
        "data": {
          "id": "test_permission",
          "user_id": "<stripped UUID>",
        },
        "type": "project_permission.created",
      },
      "timestamp": <stripped field 'timestamp'>,
    }
  `);
});

it("should trigger project permission webhook when a permission is revoked from a user", async ({ expect }) => {
  const { projectId, svixToken, endpointId } = await Webhook.createProjectWithEndpoint();

  const { userId } = await Auth.fastSignUp();

  await niceBackendFetch(`/api/v1/project-permission-definitions`, {
    accessType: "admin",
    method: "POST",
    body: { id: 'test_permission' },
  });

  // First grant the permission
  const grantPermissionResponse = await niceBackendFetch(`/api/v1/project-permissions/${userId}/test_permission`, {
    accessType: "server",
    method: "POST",
    body: {},
  });

  expect(grantPermissionResponse.status).toBe(201);

  // Then revoke the permission
  const revokePermissionResponse = await niceBackendFetch(`/api/v1/project-permissions/${userId}/test_permission`, {
    accessType: "server",
    method: "DELETE",
  });

  expect(revokePermissionResponse.status).toBe(200);

  const projectPermissionDeletedEvent = await Webhook.findWebhookAttempt(projectId, endpointId, svixToken, event => event.eventType === "project_permission.deleted");

  expect(projectPermissionDeletedEvent).toMatchInlineSnapshot(`
    {
      "channels": null,
      "eventId": null,
      "eventType": "project_permission.deleted",
      "id": "<stripped svix message id>",
      "payload": {
        "data": {
          "id": "test_permission",
          "user_id": "<stripped UUID>",
        },
        "type": "project_permission.deleted",
      },
      "timestamp": <stripped field 'timestamp'>,
    }
  `);
});

it("should not be able to create a permission with the same name as an existing project permission", async ({ expect }) => {
  await Auth.fastSignUp();
  const { adminAccessToken } = await Project.createAndGetAdminToken();

  // First, create a project permission definition
  const createTeamPermissionResponse = await niceBackendFetch(`/api/v1/project-permission-definitions`, {
    accessType: "admin",
    method: "POST",
    body: {
      id: 'custom_project_permission',
      description: 'A custom project permission',
    },
    headers: {
      'x-stack-admin-access-token': adminAccessToken
    },
  });

  expect(createTeamPermissionResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 201,
      "body": {
        "contained_permission_ids": [],
        "description": "A custom project permission",
        "id": "custom_project_permission",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Try creating another team permission with the same name
  const createAnotherTeamPermissionResponse = await niceBackendFetch(`/api/v1/team-permission-definitions`, {
    accessType: "admin",
    method: "POST",
    body: { id: 'custom_project_permission' },
    headers: { 'x-stack-admin-access-token': adminAccessToken },
  });

  expect(createAnotherTeamPermissionResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PERMISSION_ID_ALREADY_EXISTS",
        "details": { "permission_id": "custom_project_permission" },
        "error": "Permission with ID \\"custom_project_permission\\" already exists. Choose a different ID.",
      },
      "headers": Headers {
        "x-stack-known-error": "PERMISSION_ID_ALREADY_EXISTS",
        <some fields may have been hidden>,
      },
    }
  `);


  // Now try to create a project permission with the same name
  const createProjectPermissionResponse = await niceBackendFetch(`/api/v1/project-permission-definitions`, {
    accessType: "admin",
    method: "POST",
    body: {
      id: 'custom_project_permission',
      description: 'Attempt to create a project permission with same name as team permission',
    },
    headers: {
      'x-stack-admin-access-token': adminAccessToken
    },
  });

  // TODO: P2002 postgres codes should automatically be converted into duplicate key error
  expect(createProjectPermissionResponse).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "PERMISSION_ID_ALREADY_EXISTS",
        "details": { "permission_id": "custom_project_permission" },
        "error": "Permission with ID \\"custom_project_permission\\" already exists. Choose a different ID.",
      },
      "headers": Headers {
        "x-stack-known-error": "PERMISSION_ID_ALREADY_EXISTS",
        <some fields may have been hidden>,
      },
    }
  `);
});
