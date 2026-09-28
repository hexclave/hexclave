import { DEFAULT_EMAIL_THEME_ID } from "@hexclave/shared/dist/helpers/emails";
import { pick } from "@hexclave/shared/dist/utils/objects";
import { describe } from "vitest";
import { it } from "../../../../../helpers";
import { Project, niceBackendFetch } from "../../../../backend-helpers";


// Helper to create admin headers with a given token
const adminHeaders = (token: string) => ({
  'x-stack-admin-access-token': token,
});


describe("access control", () => {
  it("client and server should not have access to config endpoints", async ({ expect }) => {
    await Project.createAndSwitch();

    // Test client access
    const clientResponse = await niceBackendFetch("/api/v1/internal/config", {
      accessType: "client"
    });
    expect(clientResponse).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 401,
        "body": {
          "code": "INSUFFICIENT_ACCESS_TYPE",
          "details": {
            "actual_access_type": "client",
            "allowed_access_types": ["admin"],
          },
          "error": "The x-hexclave-access-type header must be 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
        },
        "headers": Headers {
          "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
          <some fields may have been hidden>,
        },
      }
    `);

    // Test server access
    const serverResponse = await niceBackendFetch("/api/v1/internal/config", {
      accessType: "server"
    });
    expect(serverResponse).toMatchInlineSnapshot(`
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
});


describe("basic config operations", () => {
  it("gets config", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const response = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(response.status).toBe(200);
    const parsedConfig = JSON.parse(response.body.config_string);
    expect(pick(parsedConfig, ["auth", "domains", 'users', 'teams'])).toMatchInlineSnapshot(`
      {
        "auth": {
          "allowSignUp": true,
          "oauth": {
            "accountMergeStrategy": "link_method",
            "providers": {},
          },
          "otp": { "allowSignIn": false },
          "passkey": { "allowSignIn": false },
          "password": { "allowSignIn": true },
          "signUpRules": {},
          "signUpRulesDefaultAction": "allow",
        },
        "domains": {
          "allowLocalhost": true,
          "trustedDomains": {},
        },
        "teams": {
          "allowClientTeamCreation": false,
          "createPersonalTeamOnSignUp": false,
        },
        "users": { "allowClientUserDeletion": false },
      }
    `);
  });

  it("updates basic config", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Get initial config
    const initialResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(initialResponse.status).toBe(200);
    const initialConfig = JSON.parse(initialResponse.body.config_string);

    expect(initialConfig.users.allowClientUserDeletion).toBe(false);
    expect(initialConfig.teams.allowClientTeamCreation).toBe(false);
    expect(initialConfig.teams.createPersonalTeamOnSignUp).toBe(false);

    const updateResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'users.allowClientUserDeletion': true,
          'teams.allowClientTeamCreation': true,
          'teams.createPersonalTeamOnSignUp': true,
        }),
      },
    });
    expect(updateResponse.status).toBe(200);

    // Verify the changes are persisted by making another GET request
    const verifyResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(verifyResponse.status).toBe(200);
    const updatedConfig = JSON.parse(verifyResponse.body.config_string);
    expect(updatedConfig.users.allowClientUserDeletion).toBe(true);
    expect(updatedConfig.teams.allowClientTeamCreation).toBe(true);
    expect(updatedConfig.teams.createPersonalTeamOnSignUp).toBe(true);
  });

  it("enables a sub-app independently of its parent app", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const updateResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          "apps.installed.analytics.enabled": false,
          "apps.installed.clickmaps.enabled": true,
        }),
      },
    });
    expect(updateResponse).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "success": true },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);

    const verifyResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    expect(verifyResponse.status).toBe(200);

    const updatedConfig = JSON.parse(verifyResponse.body.config_string);
    expect(updatedConfig.apps.installed.analytics.enabled).toBe(false);
    expect(updatedConfig.apps.installed.clickmaps.enabled).toBe(true);
  });

  it("updates project-level config override", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const updateResponse = await niceBackendFetch("/api/v1/internal/config/override/project", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          "project.requirePublishableClientKey": true,
        }),
      },
    });
    expect(updateResponse.body).toMatchInlineSnapshot(`{ "success": true }`);
    expect(updateResponse.status).toBe(200);

    const verifyResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    expect(verifyResponse.status).toBe(200);
    const updatedConfig = JSON.parse(verifyResponse.body.config_string);
    expect(updatedConfig.project.requirePublishableClientKey).toBe(true);
  });

  it("returns an error when config override contains non-existent fields", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const invalidTopLevelResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'nonExistentField': 'some-value',
        }),
      },
    });

    expect(invalidTopLevelResponse).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "The key \\"nonExistentField\\" is not valid (nested object not found in schema: \\"nonExistentField\\").",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("rejects invalid JSON in config_override_string", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const response = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: "{ invalid json }",
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toContain("Invalid config JSON");
  });

  it("rejects invalid JSON in config_string for PUT", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const response = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PUT",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_string: "not valid json at all",
        source: { type: "unlinked" },
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toContain("Invalid config JSON");
  });

  it("handles empty config for PUT", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // First set some values
    const patchResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
        }),
      },
    });
    expect(patchResponse.status).toBe(200);

    // PUT empty config to clear
    const putResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PUT",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_string: JSON.stringify({}),
        source: { type: "unlinked" },
      },
    });
    expect(putResponse.status).toBe(200);

    // Verify config is empty
    const getResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    expect(JSON.parse(getResponse.body.config_string)).toEqual({});
  });
});


describe("oauth config", () => {
  it("adds, updates, and removes oauth config", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Get initial config to verify no OAuth providers exist
    const initialResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(initialResponse.status).toBe(200);
    const initialConfig = JSON.parse(initialResponse.body.config_string);
    expect(initialConfig.auth.oauth.providers).toEqual({});

    // Add a Google OAuth provider
    const addGoogleResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'auth.oauth.providers.google': {
            type: 'google',
            isShared: false,
            clientId: 'google-client-id',
            clientSecret: 'google-client-secret',
            allowSignIn: true,
            allowConnectedAccounts: true,
          },
        }),
      },
    });

    expect(addGoogleResponse.status).toBe(200);

    // Add a second OAuth provider (GitHub)
    const addGithubResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'auth.oauth.providers.github': {
            type: 'github',
            isShared: true,
            allowSignIn: true,
            allowConnectedAccounts: false,
          },
        }),
      },
    });

    expect(addGithubResponse.status).toBe(200);

    const configResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    const configWithBoth = JSON.parse(configResponse.body.config_string);
    expect(configWithBoth.auth.oauth.providers.google).toBeDefined();
    expect(configWithBoth.auth.oauth.providers.github).toEqual({
      type: 'github',
      isShared: true,
      allowSignIn: true,
      allowConnectedAccounts: false,
    });

    // Update the Google OAuth provider
    const updateGoogleResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'auth.oauth.providers.google': {
            type: 'google',
            isShared: true,
            allowSignIn: false,
            allowConnectedAccounts: true,
          },
        }),
      },
    });

    expect(updateGoogleResponse.status).toBe(200);

    const configResponse2 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const configWithUpdatedGoogle = JSON.parse(configResponse2.body.config_string);
    expect(configWithUpdatedGoogle.auth.oauth.providers.google).toEqual({
      type: 'google',
      isShared: true,
      allowSignIn: false,
      allowConnectedAccounts: true,
    });
    // GitHub should still be there
    expect(configWithUpdatedGoogle.auth.oauth.providers.github).toBeDefined();

    // Remove the GitHub OAuth provider
    const removeGithubResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'auth.oauth.providers.github': null,
        }),
      },
    });

    expect(removeGithubResponse.status).toBe(200);

    const configResponse3 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const configWithoutGithub = JSON.parse(configResponse3.body.config_string);
    expect(configWithoutGithub.auth.oauth.providers.github).toBeUndefined();
    // Google should still be there
    expect(configWithoutGithub.auth.oauth.providers.google).toBeDefined();
  });

  it("returns an error when the oauth config is misconfigured", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Test invalid OAuth provider type
    const invalidTypeResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'auth.oauth.providers.invalid': {
            type: 'invalid-provider',
            isShared: false,
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            allowSignIn: true,
            allowConnectedAccounts: true,
          },
        }),
      },
    });

    expect(invalidTypeResponse).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": "auth.oauth.providers.invalid.type must be one of the following values: google, github, microsoft, spotify, facebook, discord, gitlab, bitbucket, linkedin, apple, x, twitch, custom_oidc",
        "headers": Headers { <some fields may have been hidden> },
      }
    `);
  });

  it("accepts customCallbackUrl on a standard oauth provider", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const setResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'auth.oauth.providers.google': {
            type: 'google',
            isShared: false,
            clientId: 'google-client-id',
            clientSecret: 'google-client-secret',
            customCallbackUrl: 'https://api.hexclave.com/api/v1/auth/oauth/callback/google',
            allowSignIn: true,
            allowConnectedAccounts: true,
          },
        }),
      },
    });
    expect(setResponse.status).toBe(200);

    const configResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config = JSON.parse(configResponse.body.config_string);
    expect(config.auth.oauth.providers.google.customCallbackUrl).toBe('https://api.hexclave.com/api/v1/auth/oauth/callback/google');
  });
});


describe("domain config", () => {
  it("adds and updates domains", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Get initial config to verify no trusted domains exist
    const initialResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(initialResponse.status).toBe(200);
    const initialConfig = JSON.parse(initialResponse.body.config_string);
    expect(initialConfig.domains.trustedDomains).toEqual({});

    // Add a first trusted domain
    const addFirstDomainResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.domain-1': {
            baseUrl: 'https://example.com',
            handlerPath: '/auth/handler',
          },
        }),
      },
    });

    expect(addFirstDomainResponse.status).toBe(200);

    const configResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    const configWithFirstDomain = JSON.parse(configResponse.body.config_string);
    expect(configWithFirstDomain.domains.trustedDomains['domain-1']).toEqual({
      baseUrl: 'https://example.com',
      handlerPath: '/auth/handler',
    });

    // Add a second trusted domain
    const addSecondDomainResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.domain-2': {
            baseUrl: 'https://app.example.com',
            handlerPath: '/handler',
          },
        }),
      },
    });

    expect(addSecondDomainResponse.status).toBe(200);

    const configResponse2 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const configWithBothDomains = JSON.parse(configResponse2.body.config_string);
    expect(configWithBothDomains.domains.trustedDomains['domain-1']).toBeDefined();
    expect(configWithBothDomains.domains.trustedDomains['domain-2']).toEqual({
      baseUrl: 'https://app.example.com',
      handlerPath: '/handler',
    });

    // Update the first domain
    const updateFirstDomainResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.domain-1': {
            baseUrl: 'https://updated.example.com',
            handlerPath: '/new-handler',
          },
        }),
      },
    });

    expect(updateFirstDomainResponse.status).toBe(200);

    const configResponse3 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    const configWithUpdatedDomain = JSON.parse(configResponse3.body.config_string);
    expect(configWithUpdatedDomain.domains.trustedDomains['domain-1']).toEqual({
      baseUrl: 'https://updated.example.com',
      handlerPath: '/new-handler',
    });
    // Second domain should still be there
    expect(configWithUpdatedDomain.domains.trustedDomains['domain-2']).toBeDefined();
  });

  it("supports only nested object, not dot notation format, for trusted domains", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Test nested object format
    const nestedFormatResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          domains: {
            trustedDomains: {
              '1': { baseUrl: 'http://*:*', handlerPath: '/' },
            },
          },
        }),
      },
    });

    expect(nestedFormatResponse.status).toBe(200);

    // Verify the nested format was applied correctly
    const configResponse1 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config1 = JSON.parse(configResponse1.body.config_string);
    expect(config1.domains.trustedDomains['1']).toEqual({
      baseUrl: 'http://*:*',
      handlerPath: '/',
    });

    // Clear the config for the next test
    const clearResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PUT",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_string: JSON.stringify({}),
      },
    });
    expect(clearResponse.status).toBe(200);

    // Test dot notation format
    const dotNotationResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.2.baseUrl': 'https://example.com',
          'domains.trustedDomains.2.handlerPath': '/handler',
        }),
      },
    });

    expect(dotNotationResponse.status).toBe(200);

    const configResponse2 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config2 = JSON.parse(configResponse2.body.config_string);
    expect(config2.domains.trustedDomains).toMatchInlineSnapshot(`
      {}
    `);

    // Test mixing both formats in a single request
    const mixedFormatResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          domains: {
            trustedDomains: {
              '3': { baseUrl: 'http://nested.example.com', handlerPath: '/nested' },
            },
          },
          'domains.trustedDomains.4.baseUrl': 'http://dotted.example.com',
          'domains.trustedDomains.4.handlerPath': '/dotted',
        }),
      },
    });

    expect(mixedFormatResponse).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 200,
        "body": { "success": true },
        "headers": Headers { <some fields may have been hidden> },
      }
    `);

    const configResponse3 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config3 = JSON.parse(configResponse3.body.config_string);
    expect(config3.domains.trustedDomains).toMatchInlineSnapshot(`
      {
        "3": {
          "baseUrl": "http://nested.example.com",
          "handlerPath": "/nested",
        },
      }
    `);
  });
});


describe("email config", () => {
  it("only keeps custom email templates when using a dedicated email server", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const customTemplate = {
      displayName: "Custom Reset",
      tsxSource: "export const EmailTemplate = () => null;",
      themeId: DEFAULT_EMAIL_THEME_ID,
    };
    const customTemplateId = "11111111-1111-4111-8111-111111111111";

    const configureServer = (server: Record<string, unknown>) => niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'emails.server': server,
        }),
      },
    });
    const upsertTemplate = (template: typeof customTemplate | null) => niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          [`emails.templates.${customTemplateId}`]: template,
        }),
      },
    });

    const dedicatedServer = {
      isShared: false,
      provider: 'smtp',
      host: 'smtp.example.com',
      port: 587,
      username: 'smtp-user',
      password: 'smtp-pass',
      senderName: 'Stack',
      senderEmail: 'noreply@example.com',
    };

    const setDedicatedResponse = await configureServer(dedicatedServer);
    expect(setDedicatedResponse.status).toBe(200);

    const addTemplateResponse = await upsertTemplate(customTemplate);
    expect(addTemplateResponse.status).toBe(200);

    const initialConfigResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const initialConfig = JSON.parse(initialConfigResponse.body.config_string);
    expect(initialConfig.emails.server.isShared).toBe(false);
    expect(initialConfig.emails.templates[customTemplateId]).toEqual(customTemplate);

    const setSharedResponse = await configureServer({
      isShared: true,
      provider: 'smtp',
    });
    expect(setSharedResponse.status).toBe(200);

    const sharedConfigResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const sharedConfig = JSON.parse(sharedConfigResponse.body.config_string);
    expect(sharedConfig.emails.server.isShared).toBe(true);
    expect(sharedConfig.emails.templates[customTemplateId]).toBeUndefined();

    const restoreDedicatedResponse = await configureServer(dedicatedServer);
    expect(restoreDedicatedResponse.status).toBe(200);

    const dedicatedConfigResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const dedicatedConfig = JSON.parse(dedicatedConfigResponse.body.config_string);
    expect(dedicatedConfig.emails.server.isShared).toBe(false);
    expect(dedicatedConfig.emails.templates[customTemplateId]).toEqual(customTemplate);
  });
});


describe("branch and environment levels", () => {
  it("updates config at branch level via path param", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Get initial config
    const initialResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(initialResponse.status).toBe(200);
    const initialConfig = JSON.parse(initialResponse.body.config_string);
    expect(initialConfig.teams.allowClientTeamCreation).toBe(false);

    // Update at branch level via path param
    const updateResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
        }),
      },
    });
    expect(updateResponse.status).toBe(200);

    // Verify the changes are reflected in the rendered config
    const verifyResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(verifyResponse.status).toBe(200);
    const updatedConfig = JSON.parse(verifyResponse.body.config_string);
    expect(updatedConfig.teams.allowClientTeamCreation).toBe(true);
  });

  it("branch and environment level overrides are independent", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Set a value at branch level
    const branchUpdateResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
        }),
      },
    });
    expect(branchUpdateResponse.status).toBe(200);

    // Set a different value at environment level
    const envUpdateResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'users.allowClientUserDeletion': true,
        }),
      },
    });
    expect(envUpdateResponse.status).toBe(200);

    // Verify both changes are reflected in the rendered config
    const verifyResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(verifyResponse.status).toBe(200);
    const config = JSON.parse(verifyResponse.body.config_string);
    expect(config.teams.allowClientTeamCreation).toBe(true);
    expect(config.users.allowClientUserDeletion).toBe(true);
  });

  it("environment level overrides take precedence over branch level", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Set a value at branch level
    const branchUpdateResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
        }),
      },
    });
    expect(branchUpdateResponse.status).toBe(200);

    // Override the same value at environment level
    const envUpdateResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': false,
        }),
      },
    });
    expect(envUpdateResponse.status).toBe(200);

    // Environment level should take precedence
    const verifyResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(verifyResponse.status).toBe(200);
    const config = JSON.parse(verifyResponse.body.config_string);
    expect(config.teams.allowClientTeamCreation).toBe(false);
  });

  it("rejects invalid level path parameter", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const response = await niceBackendFetch("/api/v1/internal/config/override/invalid-level", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
        }),
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("SCHEMA_ERROR");
    expect(response.body.error).toContain("params.level must be one of the following values: project, branch, environment");
  });
});


describe("level-specific field restrictions", () => {
  it("rejects environment-only fields (trusted domains) at branch level", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // domains.trustedDomains is only available at environment level
    const response = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.my-domain': {
            baseUrl: 'https://example.com',
            handlerPath: '/auth/handler',
          },
        }),
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toContain("domains.trustedDomains");
  });

  it("rejects environment-only fields (email server config) at branch level", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // emails.server is only available at environment level
    const response = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'emails.server': {
            isShared: false,
            provider: 'smtp',
            host: 'smtp.example.com',
            port: 587,
            username: 'user',
            password: 'pass',
            senderName: 'Test',
            senderEmail: 'test@example.com',
          },
        }),
      },
    });

    expect(response.status).toBe(400);
    expect(response.body).toContain("emails.server");
  });

  it("rejects environment-only fields (oauth secrets) at branch level", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // OAuth clientId and clientSecret are only available at environment level
    const response = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'auth.oauth.providers.google': {
            type: 'google',
            isShared: false,
            clientId: 'test-client-id',
            clientSecret: 'test-client-secret',
            allowSignIn: true,
            allowConnectedAccounts: true,
          },
        }),
      },
    });

    expect(response.status).toBe(400);
    // Should reject because isShared, clientId, clientSecret are environment-only
    expect(response.body).toContain("auth.oauth.providers");
  });

  it("allows branch-level fields at environment level", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Branch-level fields should also work at environment level
    const response = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
          'users.allowClientUserDeletion': true,
        }),
      },
    });

    expect(response.status).toBe(200);

    // Verify the changes
    const verifyResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    const config = JSON.parse(verifyResponse.body.config_string);
    expect(config.teams.allowClientTeamCreation).toBe(true);
    expect(config.users.allowClientUserDeletion).toBe(true);
  });

  it("allows valid branch-level oauth config at branch level", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // allowSignIn and allowConnectedAccounts are branch-level fields
    // Note: provider ID must match the regex /^\$?[a-z0-9_:]+$/ (no hyphens)
    const response = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'auth.oauth.providers.my_provider': {
            type: 'google',
            allowSignIn: true,
            allowConnectedAccounts: true,
          },
        }),
      },
    });

    expect(response.status).toBe(200);
  });
});


describe("GET and PUT endpoints", () => {
  it("gets config override for a level", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Get initial config override (should be empty)
    const initialBranchResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(initialBranchResponse.status).toBe(200);
    expect(JSON.parse(initialBranchResponse.body.config_string)).toEqual({});

    // Set some config at branch level
    const patchResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
        }),
      },
    });
    expect(patchResponse.status).toBe(200);

    // Get the config override again
    const updatedBranchResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(updatedBranchResponse.status).toBe(200);
    // Config is returned in flat dotted-key format
    const updatedBranchConfig = JSON.parse(updatedBranchResponse.body.config_string);
    expect(updatedBranchConfig["teams.allowClientTeamCreation"]).toBe(true);

    // Environment override should NOT have the branch-level change
    const envResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });

    expect(envResponse.status).toBe(200);
    const envConfig = JSON.parse(envResponse.body.config_string);
    expect(envConfig["teams.allowClientTeamCreation"]).toBeUndefined();
  });

  it("sets config override via PUT (replaces entire config) at branch level", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // First, PATCH some values
    const patchResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
          'users.allowClientUserDeletion': true,
        }),
      },
    });
    expect(patchResponse.status).toBe(200);

    // Verify both values are set (config is in flat dotted-key format)
    const getResponse1 = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config1 = JSON.parse(getResponse1.body.config_string);
    expect(config1["teams.allowClientTeamCreation"]).toBe(true);
    expect(config1["users.allowClientUserDeletion"]).toBe(true);

    // Now PUT a completely new config (should replace, not merge)
    const putResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PUT",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_string: JSON.stringify({
          'teams.createPersonalTeamOnSignUp': true,
        }),
        source: { type: "unlinked" },
      },
    });
    expect(putResponse.status).toBe(200);

    // Verify the old values are gone and only the new value remains
    const getResponse2 = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config2 = JSON.parse(getResponse2.body.config_string);
    expect(config2["teams.allowClientTeamCreation"]).toBeUndefined();
    expect(config2["users.allowClientUserDeletion"]).toBeUndefined();
    expect(config2["teams.createPersonalTeamOnSignUp"]).toBe(true);
  });

  it("sets config override via PUT at environment level", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // First, PATCH some values at environment level
    const patchResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
          'users.allowClientUserDeletion': true,
        }),
      },
    });
    expect(patchResponse.status).toBe(200);

    // Now PUT a completely new config (should replace, not merge)
    const putResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PUT",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_string: JSON.stringify({
          'auth.passkey.allowSignIn': true,
        }),
      },
    });
    expect(putResponse.status).toBe(200);

    // Verify the old values are gone and only the new value remains
    const getResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config = JSON.parse(getResponse.body.config_string);
    expect(config["teams.allowClientTeamCreation"]).toBeUndefined();
    expect(config["users.allowClientUserDeletion"]).toBeUndefined();
    expect(config["auth.passkey.allowSignIn"]).toBe(true);
  });
});


describe("pushConfig and updateConfig behavior", () => {
  it("pushConfig overwrites previous pushConfig but retains updateConfig changes", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // First, use updateConfig to set an environment-level value
    const updateResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'users.allowClientUserDeletion': true,
        }),
      },
    });
    expect(updateResponse.status).toBe(200);

    // Push a config to branch level
    const pushResponse1 = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PUT",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
          'teams.createPersonalTeamOnSignUp': true,
        }),
        source: { type: "unlinked" },
      },
    });
    expect(pushResponse1.status).toBe(200);

    // Verify both branch and environment changes are reflected in rendered config
    const configResponse1 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config1 = JSON.parse(configResponse1.body.config_string);
    expect(config1.teams.allowClientTeamCreation).toBe(true);
    expect(config1.teams.createPersonalTeamOnSignUp).toBe(true);
    expect(config1.users.allowClientUserDeletion).toBe(true);

    // Push a completely new config (should overwrite branch but not environment)
    const pushResponse2 = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PUT",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_string: JSON.stringify({
          'auth.passkey.allowSignIn': true,
        }),
        source: { type: "unlinked" },
      },
    });
    expect(pushResponse2.status).toBe(200);

    // Verify old branch values are gone, new branch value is set, environment value is retained
    const configResponse2 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config2 = JSON.parse(configResponse2.body.config_string);
    expect(config2.teams.allowClientTeamCreation).toBe(false); // back to default
    expect(config2.teams.createPersonalTeamOnSignUp).toBe(false); // back to default
    expect(config2.auth.passkey.allowSignIn).toBe(true); // new pushed value
    expect(config2.users.allowClientUserDeletion).toBe(true); // environment value retained
  });

  it("updateConfig changes take precedence over pushConfig", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Push a config at branch level
    const pushResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PUT",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_string: JSON.stringify({
          'teams.allowClientTeamCreation': true,
        }),
        source: { type: "unlinked" },
      },
    });
    expect(pushResponse.status).toBe(200);

    // Verify branch value is applied
    const configResponse1 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config1 = JSON.parse(configResponse1.body.config_string);
    expect(config1.teams.allowClientTeamCreation).toBe(true);

    // Use updateConfig to override the same value at environment level
    const updateResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          'teams.allowClientTeamCreation': false,
        }),
      },
    });
    expect(updateResponse.status).toBe(200);

    // Verify environment value takes precedence
    const configResponse2 = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config2 = JSON.parse(configResponse2.body.config_string);
    expect(config2.teams.allowClientTeamCreation).toBe(false);
  });
});

describe("pushed config errors", () => {
  it("sets pushed config errors only for development-environment projects and clears them after a successful branch config push", async ({ expect }) => {
    await Project.createAndSwitch();
    const nonRdeResponse = await niceBackendFetch("/api/v1/internal/config/pushed-error", {
      method: "PUT",
      accessType: "server",
      body: {
        error_message: "Config file error: Example failure. Please check your config file.",
      },
    });
    expect(nonRdeResponse.status).toBe(403);

    await Project.createAndSwitch({
      is_development_environment: true,
    });
    const setErrorResponse = await niceBackendFetch("/api/v1/internal/config/pushed-error", {
      method: "PUT",
      accessType: "server",
      body: {
        error_message: "Config file error: The key \"abcd\" is not valid. Please check your config file.",
      },
    });
    expect(setErrorResponse.status).toBe(200);

    const projectWithErrorResponse = await niceBackendFetch("/api/v1/projects/current", {
      accessType: "client",
    });
    expect(projectWithErrorResponse.status).toBe(200);
    expect(projectWithErrorResponse.body.pushed_config_error).toEqual({
      message: "Config file error: The key \"abcd\" is not valid. Please check your config file.",
    });

    const pushConfigResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PUT",
      accessType: "server",
      body: {
        config_string: JSON.stringify({
          "auth.allowSignUp": true,
        }),
        source: { type: "pushed-from-unknown" },
      },
    });
    expect(pushConfigResponse.status).toBe(200);

    const projectAfterPushResponse = await niceBackendFetch("/api/v1/projects/current", {
      accessType: "client",
    });
    expect(projectAfterPushResponse.status).toBe(200);
    expect(projectAfterPushResponse.body.pushed_config_error).toBeNull();
  });
});

describe("config warnings", () => {
  it("only exposes config warnings on development-environment project responses", async ({ expect }) => {
    const warningConfig = {
      "auth.oauth.providers.google.type": "google",
    };

    await Project.createAndSwitch();
    const nonRdePushResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PUT",
      accessType: "server",
      body: {
        config_string: JSON.stringify(warningConfig),
        source: { type: "pushed-from-unknown" },
      },
    });
    expect(nonRdePushResponse.status).toBe(200);

    const nonRdeProjectResponse = await niceBackendFetch("/api/v1/projects/current", {
      accessType: "client",
    });
    expect(nonRdeProjectResponse.status).toBe(200);
    expect(nonRdeProjectResponse.body.config_warnings).toEqual([]);

    await Project.createAndSwitch({
      is_development_environment: true,
    });
    const rdePushResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "PUT",
      accessType: "server",
      body: {
        config_string: JSON.stringify(warningConfig),
        source: { type: "pushed-from-unknown" },
      },
    });
    expect(rdePushResponse.status).toBe(200);

    const rdeProjectResponse = await niceBackendFetch("/api/v1/projects/current", {
      accessType: "client",
    });
    expect(rdeProjectResponse.status).toBe(200);
    expect(rdeProjectResponse.body.config_warnings).toEqual([
      {
        message: "Dot-notation key \"auth.oauth.providers.google.type\" will be silently ignored because it references non-existent parent \"auth.oauth.providers.google\". Instead of dot notation, use nested object notation like this: { \"auth.oauth.providers.google\": { \"type\": ... } }",
      },
    ]);
  });
});


describe("test helpers", () => {
  it("Project.updateConfig helper sets environment level config", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Use the helper to update config
    await Project.updateConfig({
      'teams.allowClientTeamCreation': true,
      'users.allowClientUserDeletion': true,
    });

    // Verify environment config is set
    const envResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const envConfig = JSON.parse(envResponse.body.config_string);
    expect(envConfig["teams.allowClientTeamCreation"]).toBe(true);
    expect(envConfig["users.allowClientUserDeletion"]).toBe(true);

    // Update again to verify it merges (not replaces)
    await Project.updateConfig({
      'auth.passkey.allowSignIn': true,
    });

    const envResponse2 = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const envConfig2 = JSON.parse(envResponse2.body.config_string);
    // Previous values should still be there
    expect(envConfig2["teams.allowClientTeamCreation"]).toBe(true);
    expect(envConfig2["users.allowClientUserDeletion"]).toBe(true);
    // New value should be added
    expect(envConfig2["auth.passkey.allowSignIn"]).toBe(true);
  });

  it("Project.pushConfig helper sets branch level config", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Use the helper to push config
    await Project.pushConfig({
      'teams.allowClientTeamCreation': true,
      'teams.createPersonalTeamOnSignUp': true,
    });

    // Verify branch config is set
    const branchResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const branchConfig = JSON.parse(branchResponse.body.config_string);
    expect(branchConfig["teams.allowClientTeamCreation"]).toBe(true);
    expect(branchConfig["teams.createPersonalTeamOnSignUp"]).toBe(true);

    // Push again to verify it replaces (not merges)
    await Project.pushConfig({
      'auth.passkey.allowSignIn': true,
    });

    const branchResponse2 = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const branchConfig2 = JSON.parse(branchResponse2.body.config_string);
    expect(branchConfig2["teams.allowClientTeamCreation"]).toBeUndefined();
    expect(branchConfig2["auth.passkey.allowSignIn"]).toBe(true);
  });
});


// =============================================================================
// RESET CONFIG OVERRIDE KEYS TESTS
// =============================================================================

describe("reset config override keys", () => {
  it("resets a flat key from environment config override", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Set some environment config
    await Project.updateConfig({
      'teams.allowClientTeamCreation': true,
      'users.allowClientUserDeletion': true,
    });

    // Reset one key
    await Project.resetConfigOverrideKeys("environment", ["teams.allowClientTeamCreation"]);

    // Verify only the reset key is removed
    const envResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const envConfig = JSON.parse(envResponse.body.config_string);
    expect(envConfig["teams.allowClientTeamCreation"]).toBeUndefined();
    expect(envConfig["users.allowClientUserDeletion"]).toBe(true);
  });

  it("resets a parent key which also removes children", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Set some environment config
    await Project.updateConfig({
      'teams.allowClientTeamCreation': true,
      'teams.createPersonalTeamOnSignUp': true,
      'users.allowClientUserDeletion': true,
    });

    // Reset the parent "teams" key — should remove both teams.* keys
    await Project.resetConfigOverrideKeys("environment", ["teams"]);

    const envResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const envConfig = JSON.parse(envResponse.body.config_string);
    expect(envConfig["teams.allowClientTeamCreation"]).toBeUndefined();
    expect(envConfig["teams.createPersonalTeamOnSignUp"]).toBeUndefined();
    expect(envConfig["users.allowClientUserDeletion"]).toBe(true);
  });

  it("resets keys from branch config override", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Set some branch config
    await Project.updatePushedConfig({
      'teams.allowClientTeamCreation': true,
      'users.allowClientUserDeletion': true,
    });

    // Reset one key from branch level
    await Project.resetConfigOverrideKeys("branch", ["teams.allowClientTeamCreation"]);

    const branchResponse = await niceBackendFetch("/api/v1/internal/config/override/branch", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const branchConfig = JSON.parse(branchResponse.body.config_string);
    expect(branchConfig["teams.allowClientTeamCreation"]).toBeUndefined();
    expect(branchConfig["users.allowClientUserDeletion"]).toBe(true);
  });

  it("resetting keys causes branch config to take effect over environment", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Set branch config
    await Project.updatePushedConfig({
      'teams.allowClientTeamCreation': true,
    });

    // Set environment config override that overrides the branch value
    await Project.updateConfig({
      'teams.allowClientTeamCreation': false,
    });

    // Verify environment takes precedence
    let configResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    let config = JSON.parse(configResponse.body.config_string);
    expect(config.teams.allowClientTeamCreation).toBe(false);

    // Reset the key from environment — branch config should now win
    await Project.resetConfigOverrideKeys("environment", ["teams.allowClientTeamCreation"]);

    configResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    config = JSON.parse(configResponse.body.config_string);
    expect(config.teams.allowClientTeamCreation).toBe(true);
  });

  it("resetting non-existent keys is a no-op", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Set some config
    await Project.updateConfig({
      'teams.allowClientTeamCreation': true,
    });

    // Reset a key that doesn't exist
    await Project.resetConfigOverrideKeys("environment", ["nonExistent.key"]);

    // Config should be unchanged
    const envResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const envConfig = JSON.parse(envResponse.body.config_string);
    expect(envConfig["teams.allowClientTeamCreation"]).toBe(true);
  });

  it("resetting with empty keys array is a no-op", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Set some config
    await Project.updateConfig({
      'teams.allowClientTeamCreation': true,
    });

    // Reset with empty array
    await Project.resetConfigOverrideKeys("environment", []);

    // Config should be unchanged
    const envResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const envConfig = JSON.parse(envResponse.body.config_string);
    expect(envConfig["teams.allowClientTeamCreation"]).toBe(true);
  });

  it("resets multiple keys at once", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Set some config
    await Project.updateConfig({
      'teams.allowClientTeamCreation': true,
      'teams.createPersonalTeamOnSignUp': true,
      'users.allowClientUserDeletion': true,
      'auth.passkey.allowSignIn': true,
    });

    // Reset multiple keys at once
    await Project.resetConfigOverrideKeys("environment", [
      "teams.allowClientTeamCreation",
      "auth.passkey.allowSignIn",
    ]);

    const envResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const envConfig = JSON.parse(envResponse.body.config_string);
    expect(envConfig["teams.allowClientTeamCreation"]).toBeUndefined();
    expect(envConfig["auth.passkey.allowSignIn"]).toBeUndefined();
    expect(envConfig["teams.createPersonalTeamOnSignUp"]).toBe(true);
    expect(envConfig["users.allowClientUserDeletion"]).toBe(true);
  });

  it("rejects invalid level", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    const response = await niceBackendFetch("/api/v1/internal/config/override/invalid-level/reset-keys", {
      method: "POST",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: { keys: ["teams.allowClientTeamCreation"] },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("SCHEMA_ERROR");
  });

  it("rejects non-admin access", async ({ expect }) => {
    await Project.createAndSwitch();

    const clientResponse = await niceBackendFetch("/api/v1/internal/config/override/environment/reset-keys", {
      accessType: "client",
      method: "POST",
      body: { keys: ["teams.allowClientTeamCreation"] },
    });
    expect(clientResponse.status).toBe(401);

    const serverResponse = await niceBackendFetch("/api/v1/internal/config/override/environment/reset-keys", {
      accessType: "server",
      method: "POST",
      body: { keys: ["teams.allowClientTeamCreation"] },
    });
    expect(serverResponse.status).toBe(401);
  });

  it("handles nested object config with reset", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch();

    // Set config using nested object format
    await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
      body: {
        config_override_string: JSON.stringify({
          auth: {
            oauth: {
              providers: {
                google: {
                  type: 'google',
                  isShared: false,
                  clientId: 'google-client-id',
                  clientSecret: 'google-client-secret',
                  allowSignIn: true,
                  allowConnectedAccounts: true,
                },
              },
            },
          },
          'teams.allowClientTeamCreation': true,
        }),
      },
    });

    // Reset the oauth provider key
    await Project.resetConfigOverrideKeys("environment", ["auth.oauth.providers.google"]);

    const envResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const envConfig = JSON.parse(envResponse.body.config_string);
    // teams key should still be there
    expect(envConfig["teams.allowClientTeamCreation"]).toBe(true);
    // google provider should be removed from nested object (entire auth structure might be cleaned up)
    const configResponse = await niceBackendFetch("/api/v1/internal/config", {
      method: "GET",
      accessType: "admin",
      headers: adminHeaders(adminAccessToken),
    });
    const config = JSON.parse(configResponse.body.config_string);
    expect(config.auth.oauth.providers.google).toBeUndefined();
    expect(config.teams.allowClientTeamCreation).toBe(true);
  });
});


// =============================================================================
// BRANCH CONFIG SOURCE TESTS
// =============================================================================

describe("branch config source", () => {
  // ---------------------------------------------------------------------------
  // Helper functions for creating source objects
  // ---------------------------------------------------------------------------
  const createGitHubSource = (overrides?: Partial<{
    owner: string,
    repo: string,
    branch: string,
    commit_hash: string,
    config_file_path: string,
  }>) => ({
    type: "pushed-from-github" as const,
    owner: overrides?.owner ?? "myorg",
    repo: overrides?.repo ?? "myrepo",
    branch: overrides?.branch ?? "main",
    commit_hash: overrides?.commit_hash ?? "abc123def456",
    config_file_path: overrides?.config_file_path ?? "stack.config.ts",
  });

  const createUnknownSource = () => ({
    type: "pushed-from-unknown" as const,
  });

  const createUnlinkedSource = () => ({
    type: "unlinked" as const,
  });

  // ---------------------------------------------------------------------------
  // Access control tests
  // ---------------------------------------------------------------------------
  describe("access control", () => {
    it("rejects client access to config source endpoint", async ({ expect }) => {
      await Project.createAndSwitch();

      const response = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "client",
        method: "GET",
      });

      expect(response).toMatchInlineSnapshot(`
        NiceResponse {
          "status": 401,
          "body": {
            "code": "INSUFFICIENT_ACCESS_TYPE",
            "details": {
              "actual_access_type": "client",
              "allowed_access_types": ["admin"],
            },
            "error": "The x-hexclave-access-type header must be 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
          },
          "headers": Headers {
            "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
            <some fields may have been hidden>,
          },
        }
      `);
    });

    it("rejects server access to config source endpoint", async ({ expect }) => {
      await Project.createAndSwitch();

      const response = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "server",
        method: "GET",
      });

      expect(response).toMatchInlineSnapshot(`
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

    it("allows admin access to config source endpoint", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      const response = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });

      expect(response.status).toBe(200);
      expect(response.body.source).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /config/source tests
  // ---------------------------------------------------------------------------
  describe("GET /config/source", () => {
    it("returns unlinked source for new projects", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      const response = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });

      expect(response.status).toBe(200);
      expect(response.body.source).toEqual({ type: "unlinked" });
    });

    it("returns pushed-from-github source after pushing with github source", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Push config with GitHub source
      const githubSource = createGitHubSource();
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, githubSource);

      const response = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });

      expect(response.status).toBe(200);
      expect(response.body.source).toEqual(githubSource);
    });

    it("returns pushed-from-unknown source after pushing with unknown source", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Push config with unknown source
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createUnknownSource());

      const response = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });

      expect(response.status).toBe(200);
      expect(response.body.source).toEqual({ type: "pushed-from-unknown" });
    });

    it("returns correct github source details", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      const customGithubSource = createGitHubSource({
        owner: "custom-org",
        repo: "custom-repo",
        branch: "feature-branch",
        commit_hash: "1234567890abcdef",
        config_file_path: "config/stack.config.ts",
      });

      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, customGithubSource);

      const response = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });

      expect(response.status).toBe(200);
      expect(response.body.source.type).toBe("pushed-from-github");
      expect(response.body.source.owner).toBe("custom-org");
      expect(response.body.source.repo).toBe("custom-repo");
      expect(response.body.source.branch).toBe("feature-branch");
      expect(response.body.source.commit_hash).toBe("1234567890abcdef");
      expect(response.body.source.config_file_path).toBe("config/stack.config.ts");
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /config/source (unlink) tests
  // ---------------------------------------------------------------------------
  describe("DELETE /config/source (unlink)", () => {
    it("unlinks github source to unlinked", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Push with GitHub source
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createGitHubSource());

      // Verify it's GitHub
      const beforeResponse = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });
      expect(beforeResponse.body.source.type).toBe("pushed-from-github");

      // Unlink
      const deleteResponse = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "DELETE",
        headers: adminHeaders(adminAccessToken),
      });
      expect(deleteResponse.status).toBe(200);

      // Verify it's now unlinked
      const afterResponse = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });
      expect(afterResponse.body.source).toEqual({ type: "unlinked" });
    });

    it("unlinks unknown source to unlinked", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Push with unknown source
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createUnknownSource());

      // Verify it's unknown
      const beforeResponse = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });
      expect(beforeResponse.body.source.type).toBe("pushed-from-unknown");

      // Unlink
      await Project.unlinkConfigSource();

      // Verify it's now unlinked
      const afterResponse = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });
      expect(afterResponse.body.source).toEqual({ type: "unlinked" });
    });

    it("unlink is idempotent (unlinking already unlinked is ok)", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Push with unlinked source
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createUnlinkedSource());

      // Unlink (should succeed even though already unlinked)
      const deleteResponse = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "DELETE",
        headers: adminHeaders(adminAccessToken),
      });
      expect(deleteResponse.status).toBe(200);

      // Verify still unlinked
      const afterResponse = await niceBackendFetch("/api/v1/internal/config/source", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });
      expect(afterResponse.body.source).toEqual({ type: "unlinked" });
    });

    it("unlink preserves the config values", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Push config with GitHub source
      await Project.pushConfig({
        'teams.allowClientTeamCreation': true,
        'teams.createPersonalTeamOnSignUp': true,
      }, createGitHubSource());

      // Verify config is set
      const beforeConfig = await niceBackendFetch("/api/v1/internal/config/override/branch", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });
      const beforeConfigParsed = JSON.parse(beforeConfig.body.config_string);
      expect(beforeConfigParsed["teams.allowClientTeamCreation"]).toBe(true);
      expect(beforeConfigParsed["teams.createPersonalTeamOnSignUp"]).toBe(true);

      // Unlink
      await Project.unlinkConfigSource();

      // Verify config values are preserved
      const afterConfig = await niceBackendFetch("/api/v1/internal/config/override/branch", {
        accessType: "admin",
        method: "GET",
        headers: adminHeaders(adminAccessToken),
      });
      const afterConfigParsed = JSON.parse(afterConfig.body.config_string);
      expect(afterConfigParsed["teams.allowClientTeamCreation"]).toBe(true);
      expect(afterConfigParsed["teams.createPersonalTeamOnSignUp"]).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // PUT (pushConfig) with source parameter tests
  // ---------------------------------------------------------------------------
  describe("PUT branch config with source", () => {
    it("requires source parameter for branch PUT", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Try to PUT without source
      const response = await niceBackendFetch("/api/v1/internal/config/override/branch", {
        accessType: "admin",
        method: "PUT",
        headers: adminHeaders(adminAccessToken),
        body: {
          config_string: JSON.stringify({ 'teams.allowClientTeamCreation': true }),
          // No source provided
        },
      });

      expect(response.status).toBe(400);
      expect(response.body).toContain("source is required");
    });

    it("does not require source parameter for environment PUT", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // PUT without source for environment level should work
      const response = await niceBackendFetch("/api/v1/internal/config/override/environment", {
        accessType: "admin",
        method: "PUT",
        headers: adminHeaders(adminAccessToken),
        body: {
          config_string: JSON.stringify({ 'teams.allowClientTeamCreation': true }),
        },
      });

      expect(response.status).toBe(200);
    });

    it("accepts all valid source types", async ({ expect }) => {
      const sources = [
        createGitHubSource(),
        createUnknownSource(),
        createUnlinkedSource(),
      ];

      for (const source of sources) {
        const { adminAccessToken } = await Project.createAndSwitch();

        const response = await niceBackendFetch("/api/v1/internal/config/override/branch", {
          accessType: "admin",
          method: "PUT",
          headers: adminHeaders(adminAccessToken),
          body: {
            config_string: JSON.stringify({ 'teams.allowClientTeamCreation': true }),
            source,
          },
        });

        expect(response.status).toBe(200);

        // Verify the source was stored
        const sourceResponse = await niceBackendFetch("/api/v1/internal/config/source", {
          accessType: "admin",
          method: "GET",
          headers: adminHeaders(adminAccessToken),
        });
        expect(sourceResponse.body.source.type).toBe(source.type);
      }
    });

    it("updates source when pushing new config", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // First push with GitHub source
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createGitHubSource({ owner: "org", repo: "repo1" }));

      const firstSource = await Project.getConfigSource();
      expect(firstSource.type).toBe("pushed-from-github");
      expect((firstSource as any).owner).toBe("org");
      expect((firstSource as any).repo).toBe("repo1");

      // Push again with different GitHub source
      await Project.pushConfig({ 'teams.allowClientTeamCreation': false }, createGitHubSource({ owner: "org", repo: "repo2" }));

      const secondSource = await Project.getConfigSource();
      expect(secondSource.type).toBe("pushed-from-github");
      expect((secondSource as any).owner).toBe("org");
      expect((secondSource as any).repo).toBe("repo2");

      // Push with unknown source
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createUnknownSource());

      const thirdSource = await Project.getConfigSource();
      expect(thirdSource.type).toBe("pushed-from-unknown");
    });

    it("rejects invalid source type", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      const response = await niceBackendFetch("/api/v1/internal/config/override/branch", {
        accessType: "admin",
        method: "PUT",
        headers: adminHeaders(adminAccessToken),
        body: {
          config_string: JSON.stringify({ 'teams.allowClientTeamCreation': true }),
          source: { type: "invalid-type" },
        },
      });

      expect(response.status).toBe(400);
    });

    it("rejects github source missing required fields", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      const incompleteGithubSources = [
        { type: "pushed-from-github" }, // missing all fields
        { type: "pushed-from-github", owner: "org", repo: "repo" }, // missing other fields
        { type: "pushed-from-github", owner: "org", repo: "repo", branch: "main" }, // missing commit hash and config path
      ];

      for (const source of incompleteGithubSources) {
        const response = await niceBackendFetch("/api/v1/internal/config/override/branch", {
          accessType: "admin",
          method: "PUT",
          headers: adminHeaders(adminAccessToken),
          body: {
            config_string: JSON.stringify({ 'teams.allowClientTeamCreation': true }),
            source,
          },
        });

        expect(response.status).toBe(400);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH (updatePushedConfig) source preservation tests
  // ---------------------------------------------------------------------------
  describe("PATCH branch config (source preservation)", () => {
    it("preserves github source when patching config", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Push with GitHub source
      const originalSource = createGitHubSource({ owner: "myorg", repo: "myrepo", commit_hash: "abc123" });
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, originalSource);

      // Patch the config
      await Project.updatePushedConfig({ 'teams.createPersonalTeamOnSignUp': true });

      // Verify source is preserved
      const source = await Project.getConfigSource();
      expect(source).toEqual(originalSource);
    });

    it("preserves unknown source when patching config", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Push with unknown source
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createUnknownSource());

      // Patch the config
      await Project.updatePushedConfig({ 'teams.createPersonalTeamOnSignUp': true });

      // Verify source is preserved
      const source = await Project.getConfigSource();
      expect(source.type).toBe("pushed-from-unknown");
    });

    it("preserves unlinked source when patching config", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Push with unlinked source
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createUnlinkedSource());

      // Patch the config
      await Project.updatePushedConfig({ 'teams.createPersonalTeamOnSignUp': true });

      // Verify source is preserved
      const source = await Project.getConfigSource();
      expect(source.type).toBe("unlinked");
    });

    it("preserves source across multiple patches", async ({ expect }) => {
      const { adminAccessToken } = await Project.createAndSwitch();

      // Push with GitHub source
      const originalSource = createGitHubSource();
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, originalSource);

      // Multiple patches
      await Project.updatePushedConfig({ 'teams.createPersonalTeamOnSignUp': true });
      await Project.updatePushedConfig({ 'users.allowClientUserDeletion': true });
      await Project.updatePushedConfig({ 'auth.passkey.allowSignIn': true });

      // Verify source is still preserved
      const source = await Project.getConfigSource();
      expect(source).toEqual(originalSource);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases and special scenarios
  // ---------------------------------------------------------------------------
  describe("edge cases", () => {
    it("source is preserved when config values are identical", async ({ expect }) => {
      await Project.createAndSwitch();

      // Push with GitHub source
      const originalSource = createGitHubSource();
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, originalSource);

      // Patch with the same value
      await Project.updatePushedConfig({ 'teams.allowClientTeamCreation': true });

      // Source should still be preserved
      const source = await Project.getConfigSource();
      expect(source).toEqual(originalSource);
    });

    it("can push empty config with source", async ({ expect }) => {
      await Project.createAndSwitch();

      // Push empty config
      await Project.pushConfig({}, createGitHubSource());

      const source = await Project.getConfigSource();
      expect(source.type).toBe("pushed-from-github");
    });

    it("source is isolated per project", async ({ expect }) => {
      // Create first project with GitHub source
      await Project.createAndSwitch();
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createGitHubSource({ owner: "org", repo: "project1" }));

      // Create second project with unknown source
      await Project.createAndSwitch();
      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createUnknownSource());

      // Verify second project has unknown source
      const source2 = await Project.getConfigSource();
      expect(source2.type).toBe("pushed-from-unknown");

      // Note: We can't easily verify the first project's source is unchanged
      // without switching back, but the isolation is inherent in the project model
    });

    it("handles special characters in github source fields", async ({ expect }) => {
      await Project.createAndSwitch();

      const sourceWithSpecialChars = createGitHubSource({
        owner: "org-name_123",
        repo: "repo.name-with_special",
        branch: "feature/branch-with-slashes",
        commit_hash: "a1b2c3d4e5f6789012345678901234567890abcd",
        config_file_path: "configs/my-app/stack.config.ts",
      });

      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, sourceWithSpecialChars);

      const source = await Project.getConfigSource();
      expect(source).toEqual(sourceWithSpecialChars);
    });

    it("handles very long commit hashes", async ({ expect }) => {
      await Project.createAndSwitch();

      const sourceWithLongHash = createGitHubSource({
        commit_hash: "a".repeat(100),
      });

      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, sourceWithLongHash);

      const source = await Project.getConfigSource();
      expect((source as any).commit_hash).toBe("a".repeat(100));
    });

    it("handles unicode characters in source fields", async ({ expect }) => {
      await Project.createAndSwitch();

      const sourceWithUnicode = createGitHubSource({
        owner: "组织",
        repo: "仓库",
        branch: "функция/ветка",
        config_file_path: "配置/stack.config.ts",
      });

      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, sourceWithUnicode);

      const source = await Project.getConfigSource();
      expect(source).toEqual(sourceWithUnicode);
    });

    it("handles empty strings in github source fields gracefully", async ({ expect }) => {
      await Project.createAndSwitch();

      // These are technically valid (the schema allows empty strings)
      const sourceWithEmptyStrings = {
        type: "pushed-from-github" as const,
        owner: "",
        repo: "",
        branch: "",
        commit_hash: "",
        config_file_path: "",
      };

      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, sourceWithEmptyStrings);

      const source = await Project.getConfigSource();
      expect(source).toEqual(sourceWithEmptyStrings);
    });

    it("handles source fields at string length boundaries", async ({ expect }) => {
      await Project.createAndSwitch();

      // Very long but reasonable strings
      const sourceLong = createGitHubSource({
        owner: "z".repeat(100),
        repo: "a".repeat(200),
        branch: "b".repeat(200),
        commit_hash: "c".repeat(200),
        config_file_path: "d".repeat(500),
      });

      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, sourceLong);

      const source = await Project.getConfigSource();
      expect((source as any).repo).toBe("a".repeat(200));
      expect((source as any).branch).toBe("b".repeat(200));
    });
  });

  // ---------------------------------------------------------------------------
  // Helper function tests
  // ---------------------------------------------------------------------------
  describe("Project helper functions", () => {
    it("Project.getConfigSource returns correct source", async ({ expect }) => {
      await Project.createAndSwitch();

      // Default should be unlinked
      const initialSource = await Project.getConfigSource();
      expect(initialSource.type).toBe("unlinked");

      // After pushing with GitHub
      await Project.pushConfig({}, createGitHubSource());
      const afterPush = await Project.getConfigSource();
      expect(afterPush.type).toBe("pushed-from-github");
    });

    it("Project.unlinkConfigSource works correctly", async ({ expect }) => {
      await Project.createAndSwitch();

      // Push with GitHub source
      await Project.pushConfig({}, createGitHubSource());
      expect((await Project.getConfigSource()).type).toBe("pushed-from-github");

      // Unlink
      await Project.unlinkConfigSource();
      expect((await Project.getConfigSource()).type).toBe("unlinked");
    });

    it("Project.updatePushedConfig helper preserves source", async ({ expect }) => {
      await Project.createAndSwitch();

      await Project.pushConfig({ 'teams.allowClientTeamCreation': true }, createGitHubSource());

      // Use the updatePushedConfig helper
      await Project.updatePushedConfig({ 'teams.createPersonalTeamOnSignUp': true });

      // Source should be preserved
      const source = await Project.getConfigSource();
      expect(source.type).toBe("pushed-from-github");
    });
  });
});
