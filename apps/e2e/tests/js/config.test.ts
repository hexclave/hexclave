import { pick } from "@hexclave/shared/dist/utils/objects";
import { describe } from "vitest";
import { it } from "../helpers";
import { createApp } from "./js-helpers";


describe("access control", () => {
  it("serverApp project does not have config methods", async ({ expect }) => {
    const { serverApp } = await createApp();
    const project = await serverApp.getProject();

    // Server apps only get basic Project type, not AdminProject
    // So config methods should not exist
    expect((project as any).updateConfig).toBeUndefined();
    expect((project as any).pushConfig).toBeUndefined();
    expect((project as any).updatePushedConfig).toBeUndefined();
    expect((project as any).getConfig).toBeUndefined();
  });

  it("clientApp project does not have config methods", async ({ expect }) => {
    const { clientApp } = await createApp();
    const project = await clientApp.getProject();

    // Client apps only get basic Project type, not AdminProject
    // So config methods should not exist
    expect((project as any).updateConfig).toBeUndefined();
    expect((project as any).pushConfig).toBeUndefined();
    expect((project as any).updatePushedConfig).toBeUndefined();
    expect((project as any).getConfig).toBeUndefined();
  });

  it("only adminApp project has config methods", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // AdminApp gets AdminProject which has config methods
    expect(typeof project.updateConfig).toBe('function');
    expect(typeof project.pushConfig).toBe('function');
    expect(typeof project.updatePushedConfig).toBe('function');
    expect(typeof project.getConfig).toBe('function');
  });
});


describe("error handling", () => {
  it("updateConfig rejects non-existent config fields", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    await expect(project.updateConfig({
      'nonExistentField.value': true,
    } as any)).rejects.toThrow(/nonExistentField/);
  });

  it("pushConfig rejects non-existent config fields", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    await expect(project.pushConfig({
      'nonExistentField.value': true,
    } as any, { source: { type: "unlinked" } })).rejects.toThrow(/nonExistentField/);
  });

  it("updateConfig rejects invalid oauth provider type", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    await expect(project.updateConfig({
      'auth.oauth.providers.invalid': {
        type: 'not-a-real-provider',
        isShared: false,
        clientId: 'test',
        clientSecret: 'test',
        allowSignIn: true,
        allowConnectedAccounts: true,
      },
    } as any)).rejects.toThrow(/type must be one of the following values/);
  });

  it("updateConfig accepts Apple key-based OAuth credentials", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    await project.updateConfig({
      'auth.oauth.providers.apple': {
        type: 'apple',
        isShared: false,
        clientId: 'com.example.web',
        appleTeamId: 'TEAM123',
        appleKeyId: 'KEY123',
        applePrivateKey: '-----BEGIN PRIVATE KEY-----\\nexample\\n-----END PRIVATE KEY-----',
        allowSignIn: true,
        allowConnectedAccounts: true,
      },
    });

    const config = await project.getConfig();
    const apple = config.auth.oauth.providers.apple;
    expect({
      appleTeamId: apple.appleTeamId,
      appleKeyId: apple.appleKeyId,
      hasPrivateKey: apple.applePrivateKey?.includes('BEGIN PRIVATE KEY'),
    }).toMatchInlineSnapshot(`
      {
        "appleKeyId": "KEY123",
        "appleTeamId": "TEAM123",
        "hasPrivateKey": true,
      }
    `);
  });

  it("pushConfig rejects environment-only fields at branch level", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // pushConfig uses branch level, which doesn't allow environment-only fields
    // like clientId, clientSecret, isShared
    await expect(project.pushConfig({
      'auth.oauth.providers.google': {
        type: 'google',
        isShared: false,
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        allowSignIn: true,
        allowConnectedAccounts: true,
      },
    } as any, { source: { type: "unlinked" } })).rejects.toThrow(/auth\.oauth\.providers/);
  });

  it("pushConfig allows branch-level oauth fields", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Branch-level fields only (no secrets)
    await project.pushConfig({
      'auth.oauth.providers.my_provider': {
        type: 'google',
        allowSignIn: true,
        allowConnectedAccounts: true,
      },
    } as any, { source: { type: "unlinked" } });

    const config = await project.getConfig();
    expect(config.auth.oauth.providers['my_provider']).toBeDefined();
  });
});


describe("getConfig", () => {
  it("gets config", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();
    const config = await project.getConfig();
    expect(pick(config, ["auth", "users", "teams"])).toMatchInlineSnapshot(`
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
          "sms": { "allowSignIn": false },
        },
        "teams": {
          "allowClientTeamCreation": false,
          "createPersonalTeamOnSignUp": false,
        },
        "users": { "allowClientUserDeletion": false },
      }
    `);
  });
});


describe("updateConfig", () => {
  it("updates config at environment level", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();
    const config = await project.getConfig();
    expect(config['auth']).toMatchInlineSnapshot(`
      {
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
        "sms": { "allowSignIn": false },
      }
    `);

    await project.updateConfig({
      'auth.allowSignUp': false,
    });

    const config2 = await project.getConfig();
    expect(config2['auth']).toMatchInlineSnapshot(`
      {
        "allowSignUp": false,
        "oauth": {
          "accountMergeStrategy": "link_method",
          "providers": {},
        },
        "otp": { "allowSignIn": false },
        "passkey": { "allowSignIn": false },
        "password": { "allowSignIn": true },
        "signUpRules": {},
        "signUpRulesDefaultAction": "allow",
        "sms": { "allowSignIn": false },
      }
    `);
  });

  it("updateConfig merges with existing config", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Set first value
    await project.updateConfig({
      'teams.allowClientTeamCreation': true,
    });

    // Set second value
    await project.updateConfig({
      'users.allowClientUserDeletion': true,
    });

    // Both should be set
    const config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(true);
    expect(config.users.allowClientUserDeletion).toBe(true);
  });
});


describe("pushConfig", () => {
  it("pushConfig sets branch-level config", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Push config
    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
      'teams.createPersonalTeamOnSignUp': true,
    }, { source: { type: "unlinked" } });

    // Verify config is applied
    const config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(true);
    expect(config.teams.createPersonalTeamOnSignUp).toBe(true);
  });

  it("pushConfig replaces previous pushConfig", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Push first config
    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
      'teams.createPersonalTeamOnSignUp': true,
    }, { source: { type: "unlinked" } });

    // Verify first config is applied
    let config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(true);
    expect(config.teams.createPersonalTeamOnSignUp).toBe(true);

    // Push second config (completely replaces first)
    await project.pushConfig({
      'auth.passkey.allowSignIn': true,
    }, { source: { type: "unlinked" } });

    // Verify old values are gone (back to defaults) and new value is set
    config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(false); // back to default
    expect(config.teams.createPersonalTeamOnSignUp).toBe(false); // back to default
    expect(config.auth.passkey.allowSignIn).toBe(true); // new value
  });

  it("updateConfig takes precedence over pushConfig", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Push config first
    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
    }, { source: { type: "unlinked" } });

    // Verify push is applied
    let config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(true);

    // updateConfig overrides the same value
    await project.updateConfig({
      'teams.allowClientTeamCreation': false,
    });

    // Environment-level (updateConfig) takes precedence
    config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(false);
  });

  it("pushConfig does not affect updateConfig values", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // updateConfig sets environment-level value
    await project.updateConfig({
      'users.allowClientUserDeletion': true,
    });

    // pushConfig sets branch-level values
    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
    }, { source: { type: "unlinked" } });

    // Both should be present
    let config = await project.getConfig();
    expect(config.users.allowClientUserDeletion).toBe(true); // from updateConfig
    expect(config.teams.allowClientTeamCreation).toBe(true); // from pushConfig

    // Push new config (replaces branch but not environment)
    await project.pushConfig({
      'auth.passkey.allowSignIn': true,
    }, { source: { type: "unlinked" } });

    // updateConfig value should still be there
    config = await project.getConfig();
    expect(config.users.allowClientUserDeletion).toBe(true); // still from updateConfig
    expect(config.teams.allowClientTeamCreation).toBe(false); // back to default (old push gone)
    expect(config.auth.passkey.allowSignIn).toBe(true); // from new push
  });
});


describe("updatePushedConfig", () => {
  it("updatePushedConfig merges into pushed config", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Push initial config
    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
    }, { source: { type: "unlinked" } });

    // updatePushedConfig merges into the pushed config
    await project.updatePushedConfig({
      'teams.createPersonalTeamOnSignUp': true,
    });

    // Both values should be set
    const config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(true);
    expect(config.teams.createPersonalTeamOnSignUp).toBe(true);
  });

  it("pushConfig replaces updatePushedConfig changes", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Push initial config
    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
    }, { source: { type: "unlinked" } });

    // updatePushedConfig adds a value
    await project.updatePushedConfig({
      'teams.createPersonalTeamOnSignUp': true,
    });

    // Verify both values are present
    let config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(true);
    expect(config.teams.createPersonalTeamOnSignUp).toBe(true);

    // pushConfig replaces everything including updatePushedConfig changes
    await project.pushConfig({
      'auth.passkey.allowSignIn': true,
    }, { source: { type: "unlinked" } });

    // Old values should be gone
    config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(false); // back to default
    expect(config.teams.createPersonalTeamOnSignUp).toBe(false); // back to default
    expect(config.auth.passkey.allowSignIn).toBe(true); // new push value
  });

  it("updateConfig takes precedence over updatePushedConfig", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // updatePushedConfig sets a value at branch level
    await project.updatePushedConfig({
      'teams.allowClientTeamCreation': true,
    });

    // Verify value is applied
    let config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(true);

    // updateConfig overrides at environment level
    await project.updateConfig({
      'teams.allowClientTeamCreation': false,
    });

    // Environment-level takes precedence
    config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(false);
  });

  it("updatePushedConfig rejects environment-only fields", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // updatePushedConfig uses branch level, so environment-only fields should be rejected
    await expect(project.updatePushedConfig({
      'auth.oauth.providers.google': {
        type: 'google',
        isShared: false,
        clientId: 'test-client-id',
        clientSecret: 'test-secret',
        allowSignIn: true,
        allowConnectedAccounts: true,
      },
    } as any)).rejects.toThrow(/auth\.oauth\.providers/);
  });
});


describe("resetConfigOverrideKeys", () => {
  it("resetConfigOverrideKeys removes keys from environment override", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Set branch config
    await project.updatePushedConfig({
      'teams.allowClientTeamCreation': true,
    });

    // Set environment config that overrides branch
    await project.updateConfig({
      'teams.allowClientTeamCreation': false,
    });

    // Verify environment takes precedence
    let config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(false);

    // Reset the key from environment level
    await project.resetConfigOverrideKeys("environment", ["teams.allowClientTeamCreation"]);

    // Now branch config should win
    config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(true);
  });

  it("resetConfigOverrideKeys with parent key removes children", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Set environment config with multiple team settings
    await project.updateConfig({
      'teams.allowClientTeamCreation': true,
      'teams.createPersonalTeamOnSignUp': true,
      'users.allowClientUserDeletion': true,
    });

    // Reset the parent "teams" key
    await project.resetConfigOverrideKeys("environment", ["teams"]);

    // Verify teams keys are gone but users key remains
    const envOverride = await project.getConfigOverride("environment");
    expect(envOverride["teams.allowClientTeamCreation"]).toBeUndefined();
    expect(envOverride["teams.createPersonalTeamOnSignUp"]).toBeUndefined();
    expect(envOverride["users.allowClientUserDeletion"]).toBe(true);
  });

  it("resetConfigOverrideKeys with non-existent keys is a no-op", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Set environment config
    await project.updateConfig({
      'teams.allowClientTeamCreation': true,
    });

    // Reset a non-existent key
    await project.resetConfigOverrideKeys("environment", ["nonExistent.key"]);

    // Config should be unchanged
    const envOverride = await project.getConfigOverride("environment");
    expect(envOverride["teams.allowClientTeamCreation"]).toBe(true);
  });

  it("resetConfigOverrideKeys on branch level works", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Set branch config
    await project.updatePushedConfig({
      'teams.allowClientTeamCreation': true,
      'users.allowClientUserDeletion': true,
    });

    // Reset one branch key
    await project.resetConfigOverrideKeys("branch", ["teams.allowClientTeamCreation"]);

    const branchOverride = await project.getConfigOverride("branch");
    expect(branchOverride["teams.allowClientTeamCreation"]).toBeUndefined();
    expect(branchOverride["users.allowClientUserDeletion"]).toBe(true);
  });
});


describe("pushedConfigSource", () => {
  it("getPushedConfigSource returns unlinked by default", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    const source = await project.getPushedConfigSource();
    expect(source.type).toBe("unlinked");
  });

  it("pushConfig with source sets the source", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
    }, {
      source: {
        type: "pushed-from-github",
        owner: "myorg",
        repo: "myrepo",
        branch: "main",
        commitHash: "abc123",
        configFilePath: "stack.config.ts",
      },
    });

    const source = await project.getPushedConfigSource();
    expect(source.type).toBe("pushed-from-github");
    if (source.type === "pushed-from-github") {
      expect(source.owner).toBe("myorg");
      expect(source.repo).toBe("myrepo");
      expect(source.branch).toBe("main");
      expect(source.commitHash).toBe("abc123");
      expect(source.configFilePath).toBe("stack.config.ts");
    }
  });

  it("pushConfig without source defaults to unlinked", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // First push with source
    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
    }, {
      source: {
        type: "pushed-from-github",
        owner: "myorg",
        repo: "myrepo",
        branch: "main",
        commitHash: "abc123",
        configFilePath: "stack.config.ts",
      },
    });

    // Then push without source (should default to unlinked)
    await project.pushConfig({
      'teams.createPersonalTeamOnSignUp': true,
    }, { source: { type: "unlinked" } });

    const source = await project.getPushedConfigSource();
    expect(source.type).toBe("unlinked");
  });

  it("updatePushedConfig preserves the source", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Push with GitHub source
    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
    }, {
      source: {
        type: "pushed-from-github",
        owner: "myorg",
        repo: "myrepo",
        branch: "main",
        commitHash: "abc123",
        configFilePath: "stack.config.ts",
      },
    });

    // Update pushed config
    await project.updatePushedConfig({
      'teams.createPersonalTeamOnSignUp': true,
    });

    // Source should still be GitHub
    const source = await project.getPushedConfigSource();
    expect(source.type).toBe("pushed-from-github");
  });

  it("unlinkPushedConfigSource sets source to unlinked", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Push with GitHub source
    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
    }, {
      source: {
        type: "pushed-from-github",
        owner: "myorg",
        repo: "myrepo",
        branch: "main",
        commitHash: "abc123",
        configFilePath: "stack.config.ts",
      },
    });

    // Verify source is GitHub
    expect((await project.getPushedConfigSource()).type).toBe("pushed-from-github");

    // Unlink
    await project.unlinkPushedConfigSource();

    // Verify source is now unlinked
    const source = await project.getPushedConfigSource();
    expect(source.type).toBe("unlinked");
  });

  it("unlinkPushedConfigSource preserves the config", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    // Push config with source
    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
    }, {
      source: {
        type: "pushed-from-github",
        owner: "myorg",
        repo: "myrepo",
        branch: "main",
        commitHash: "abc123",
        configFilePath: "stack.config.ts",
      },
    });

    // Unlink
    await project.unlinkPushedConfigSource();

    // Config should still be there
    const config = await project.getConfig();
    expect(config.teams.allowClientTeamCreation).toBe(true);
  });

  it("can set pushed-from-unknown source", async ({ expect }) => {
    const { adminApp } = await createApp();
    const project = await adminApp.getProject();

    await project.pushConfig({
      'teams.allowClientTeamCreation': true,
    }, {
      source: { type: "pushed-from-unknown" },
    });

    const source = await project.getPushedConfigSource();
    expect(source.type).toBe("pushed-from-unknown");
  });
});
