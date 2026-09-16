import { describe } from "vitest";
import { it } from "../../../../../../helpers";
import { withPortPrefix } from "../../../../../../helpers/ports";
import { Auth, InternalApiKey, Project, niceBackendFetch } from "../../../../../backend-helpers";

const oauthMockServerPort = withPortPrefix("07");

describe("OAuth with wildcard domains", () => {
  it("should work with exact domain configuration", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch({
      config: {
        oauth_providers: [{ id: "spotify", type: "shared" }],
      }
    });
    await InternalApiKey.createAndSetProjectKeys();

    // Add exact domain matching our test redirect URL
    const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.exact': {
            baseUrl: 'http://stack-test.localhost',
            handlerPath: '/some-callback-url',
          },
          'domains.allowLocalhost': false,
        }),
      },
    });
    expect(configResponse.status).toBe(200);

    // OAuth flow should work
    const response = await Auth.OAuth.signIn();
    expect(response.tokenResponse.status).toBe(200);
  });

  it("should FAIL with exact domain that doesn't match", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch({
      config: {
        oauth_providers: [{ id: "spotify", type: "shared" }],
      }
    });
    await InternalApiKey.createAndSetProjectKeys();

    // Add exact domain that DOESN'T match our test redirect URL
    const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.exact': {
            baseUrl: 'https://app.example.com',
            handlerPath: '/handler',
          },
          'domains.allowLocalhost': false, // Disable localhost to ensure exact matching
        }),
      },
    });
    expect(configResponse.status).toBe(200);

    // Try to complete the OAuth flow - it should fail at the callback stage
    const { response } = await Auth.OAuth.getMaybeFailingAuthorizationCode();
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "REDIRECT_URL_NOT_WHITELISTED",
          "details": { "redirect_url": "http://stack-test.localhost/some-callback-url" },
          "error": "Redirect URL not whitelisted. Did you forget to add this domain to the trusted domains list on the Hexclave dashboard?",
        },
        "headers": Headers {
          "set-cookie": <deleting cookie 'stack-oauth-inner-<stripped cookie name key>' at path '/'>,
          "x-stack-known-error": "REDIRECT_URL_NOT_WHITELISTED",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should work with single wildcard domain", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch({
      config: {
        oauth_providers: [{ id: "spotify", type: "shared" }],
      }
    });
    await InternalApiKey.createAndSetProjectKeys();

    // Add wildcard domain
    const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.wildcard': {
            baseUrl: 'http://*.localhost',
            handlerPath: '/some-callback-url',
          },
          'domains.allowLocalhost': false,
        }),
      },
    });
    expect(configResponse.status).toBe(200);

    // OAuth flow should work with localhost
    const response = await Auth.OAuth.signIn();
    expect(response.tokenResponse.status).toBe(200);
  });

  it("should work with a wildcard port domain", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch({
      config: {
        oauth_providers: [{ id: "spotify", type: "shared" }],
      }
    });
    await InternalApiKey.createAndSetProjectKeys();

    const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.wildcard-port': {
            baseUrl: 'http://*.localhost:*',
            handlerPath: '/some-callback-url',
          },
          'domains.allowLocalhost': false,
        }),
      },
    });
    expect(configResponse.status).toBe(200);

    const response = await Auth.OAuth.signIn();
    expect(response.tokenResponse.status).toBe(200);
  });

  it("should FAIL with single wildcard that doesn't match", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch({
      config: {
        oauth_providers: [{ id: "spotify", type: "shared" }],
      }
    });
    await InternalApiKey.createAndSetProjectKeys();

    // Add wildcard domain that doesn't match localhost pattern
    const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.wildcard': {
            baseUrl: 'https://*.example.com',
            handlerPath: '/handler',
          },
          'domains.allowLocalhost': false,
        }),
      },
    });
    expect(configResponse.status).toBe(200);

    // Try to complete the OAuth flow - it should fail at the callback stage
    const { response } = await Auth.OAuth.getMaybeFailingAuthorizationCode();
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "REDIRECT_URL_NOT_WHITELISTED",
          "details": { "redirect_url": "http://stack-test.localhost/some-callback-url" },
          "error": "Redirect URL not whitelisted. Did you forget to add this domain to the trusted domains list on the Hexclave dashboard?",
        },
        "headers": Headers {
          "set-cookie": <deleting cookie 'stack-oauth-inner-<stripped cookie name key>' at path '/'>,
          "x-stack-known-error": "REDIRECT_URL_NOT_WHITELISTED",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should work with double wildcard domain", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch({
      config: {
        oauth_providers: [{ id: "spotify", type: "shared" }],
      }
    });
    await InternalApiKey.createAndSetProjectKeys();

    // Add double wildcard domain
    const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.double': {
            baseUrl: 'http://**.localhost',
            handlerPath: '/some-callback-url',
          },
          'domains.allowLocalhost': false,
        }),
      },
    });
    expect(configResponse.status).toBe(200);

    // OAuth flow should work
    const response = await Auth.OAuth.signIn();
    expect(response.tokenResponse.status).toBe(200);
  });

  it("should FAIL with double wildcard that doesn't match", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch({
      config: {
        oauth_providers: [{ id: "spotify", type: "shared" }],
      }
    });
    await InternalApiKey.createAndSetProjectKeys();

    // Add double wildcard for different TLD
    const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.double': {
            baseUrl: 'https://**.example.org', // Different TLD - won't match localhost
            handlerPath: '/handler',
          },
          'domains.allowLocalhost': false,
        }),
      },
    });
    expect(configResponse.status).toBe(200);

    // Try to complete the OAuth flow - it should fail at the callback stage
    const { response } = await Auth.OAuth.getMaybeFailingAuthorizationCode();
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "REDIRECT_URL_NOT_WHITELISTED",
          "details": { "redirect_url": "http://stack-test.localhost/some-callback-url" },
          "error": "Redirect URL not whitelisted. Did you forget to add this domain to the trusted domains list on the Hexclave dashboard?",
        },
        "headers": Headers {
          "set-cookie": <deleting cookie 'stack-oauth-inner-<stripped cookie name key>' at path '/'>,
          "x-stack-known-error": "REDIRECT_URL_NOT_WHITELISTED",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should match prefix wildcard patterns correctly", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch({
      config: {
        oauth_providers: [{ id: "spotify", type: "shared" }],
      }
    });
    await InternalApiKey.createAndSetProjectKeys();

    // Add prefix wildcard that should match "localhost"
    const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.prefix': {
            baseUrl: 'http://stack-test.*', // Should match stack-test.localhost
            handlerPath: '/some-callback-url',
          },
          'domains.allowLocalhost': false,
        }),
      },
    });
    expect(configResponse.status).toBe(200);

    // OAuth flow should work
    const response = await Auth.OAuth.signIn();
    expect(response.tokenResponse.status).toBe(200);
  });

  it("should FAIL with prefix wildcard that doesn't match", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch({
      config: {
        oauth_providers: [{ id: "spotify", type: "shared" }],
      }
    });
    await InternalApiKey.createAndSetProjectKeys();

    // Add prefix wildcard that won't match localhost
    const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.prefix': {
            baseUrl: `http://api-*:${oauthMockServerPort}`, // Won't match localhost
            handlerPath: '/handler',
          },
          'domains.allowLocalhost': false,
        }),
      },
    });
    expect(configResponse.status).toBe(200);

    // Try to complete the OAuth flow - it should fail at the callback stage
    const { response } = await Auth.OAuth.getMaybeFailingAuthorizationCode();
    expect(response).toMatchInlineSnapshot(`
      NiceResponse {
        "status": 400,
        "body": {
          "code": "REDIRECT_URL_NOT_WHITELISTED",
          "details": { "redirect_url": "http://stack-test.localhost/some-callback-url" },
          "error": "Redirect URL not whitelisted. Did you forget to add this domain to the trusted domains list on the Hexclave dashboard?",
        },
        "headers": Headers {
          "set-cookie": <deleting cookie 'stack-oauth-inner-<stripped cookie name key>' at path '/'>,
          "x-stack-known-error": "REDIRECT_URL_NOT_WHITELISTED",
          <some fields may have been hidden>,
        },
      }
    `);
  });

  it("should properly validate multiple domains with wildcards", async ({ expect }) => {
    const { adminAccessToken } = await Project.createAndSwitch({
      config: {
        oauth_providers: [{ id: "spotify", type: "shared" }],
      }
    });
    await InternalApiKey.createAndSetProjectKeys();
    // Configure multiple domains, only one matches
    const configResponse = await niceBackendFetch("/api/v1/internal/config/override/environment", {
      method: "PATCH",
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      body: {
        config_override_string: JSON.stringify({
          'domains.trustedDomains.prod': {
            baseUrl: 'https://app.production.com',
            handlerPath: '/handler',
          },
          'domains.trustedDomains.staging': {
            baseUrl: 'https://*.staging.com',
            handlerPath: '/handler',
          },
          'domains.trustedDomains.test': {
            baseUrl: 'http://stack-test.localhost', // This one matches!
            handlerPath: '/some-callback-url',
          },
          'domains.allowLocalhost': false,
        }),
      },
    });
    expect(configResponse.status).toBe(200);

    // Get the config to verify all domains are stored
    const getResponse = await niceBackendFetch("/api/v1/internal/config", {
      accessType: "admin",
      headers: {
        'x-stack-admin-access-token': adminAccessToken,
      },
      method: "GET",
    });
    expect(getResponse.status).toBe(200);

    const config = JSON.parse(getResponse.body.config_string);
    expect(Object.keys(config.domains.trustedDomains).length).toBe(3);
  });
});
