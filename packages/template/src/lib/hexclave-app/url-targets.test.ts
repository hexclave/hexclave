import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCliAuthConfirmUrl, getPagePrompt, isLocalHandlerUrlTarget, resolveHandlerUrls, resolveUnknownHandlerPathFallbackUrl } from "./url-targets";

describe("handler URL targets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("treats handler-component targets the same as omitted values", () => {
    const urls = resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        handler: "/custom-handler",
        signIn: { type: "handler-component" },
      },
    });

    expect(urls.signIn).toBe("/custom-handler/sign-in");
  });

  it("treats custom v0 page targets like legacy string targets", () => {
    const urls = resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        handler: "/custom-handler",
        signIn: { type: "handler-component" },
        signUp: { type: "custom", url: "/sign-up-explicit", version: 0 },
      },
    });

    expect(urls.signIn).toBe("/custom-handler/sign-in");
    expect(urls.signUp).toBe("/sign-up-explicit");
  });

  it("throws on v0 custom target for handler page", () => {
    expect(() => resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        handler: { type: "custom", url: "/custom-handler", version: 0 },
      },
    })).toThrowError(/cannot be a custom page/);
  });

  it("supports the latest documented custom target version", () => {
    const signInPrompt = getPagePrompt("signIn");
    if (signInPrompt == null) {
      throw new Error("Expected signIn prompt metadata to exist");
    }

    const urls = resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        signIn: { type: "custom", url: "/custom-sign-in", version: signInPrompt.latestVersion },
      },
    });

    expect(urls.signIn).toBe("/custom-sign-in");
  });

  it("throws on custom target versions newer than the latest supported version", () => {
    const signInPrompt = getPagePrompt("signIn");
    if (signInPrompt == null) {
      throw new Error("Expected signIn prompt metadata to exist");
    }

    expect(() => resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        signIn: { type: "custom", url: "/custom-sign-in", version: signInPrompt.latestVersion + 1 },
      },
    })).toThrowError(/Unsupported custom page version/);
  });

  it("throws on non-zero custom version for handler page", () => {
    expect(() => resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        handler: { type: "custom", url: "/custom-handler", version: 1 },
      },
    })).toThrowError(/cannot be a custom page/);
  });

  it("uses hosted defaults for unspecified URLs", () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_HOSTED_HANDLER_DOMAIN_SUFFIX", ".example-stack-hosted.test");

    const urls = resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        signUp: "/sign-up",
        default: { type: "hosted" },
      },
    });

    expect(urls.signUp).toBe("/sign-up");
    expect(urls.signIn).toBe("https://project-id.example-stack-hosted.test/handler/sign-in");
    expect(urls.cliAuthConfirm).toBe("https://project-id.example-stack-hosted.test/handler/cli-auth-confirm");
    expect(urls.agentAuthConfirm).toBe("https://project-id.example-stack-hosted.test/handler/agent-auth-confirm");
  });

  it("keeps redirect-only post-auth targets local even when the default target is hosted", () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_HOSTED_HANDLER_DOMAIN_SUFFIX", ".example-stack-hosted.test");

    const urls = resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        default: { type: "hosted" },
      },
    });

    expect(urls.signIn).toBe("https://project-id.example-stack-hosted.test/handler/sign-in");
    expect(urls.signOut).toBe("https://project-id.example-stack-hosted.test/handler/sign-out");
    expect(urls.home).toBe("/");
    expect(urls.afterSignIn).toBe("/");
    expect(urls.afterSignUp).toBe("/");
    expect(urls.afterSignOut).toBe("/");
  });

  it("rejects absolute OAuth callback string targets", () => {
    expect(() => resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        oauthCallback: "https://app.example.test/oauth-callback",
      },
    })).toThrowErrorMatchingInlineSnapshot(`
      [HexclaveAssertionError: OAuth callback URLs must be relative.

      This is likely an error in Hexclave. Please make sure you are running the newest version and report it.]
    `);
  });

  it("rejects absolute OAuth callback custom targets", () => {
    expect(() => resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        oauthCallback: { type: "custom", url: "https://app.example.test/oauth-callback", version: 0 },
      },
    })).toThrowErrorMatchingInlineSnapshot(`
      [HexclaveAssertionError: OAuth callback URLs must be relative.

      This is likely an error in Hexclave. Please make sure you are running the newest version and report it.]
    `);
  });

  it("inherits a hosted default target for the OAuth callback", () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_HOSTED_HANDLER_DOMAIN_SUFFIX", ".example-stack-hosted.test");

    const urls = resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        default: { type: "hosted" },
      },
    });

    expect(urls.signIn).toBe("https://project-id.example-stack-hosted.test/handler/sign-in");
    expect(urls.oauthCallback).toBe("https://project-id.example-stack-hosted.test/handler/oauth-callback");
  });

  it("supports custom CLI auth confirmation targets", () => {
    const cliAuthConfirmPrompt = getPagePrompt("cliAuthConfirm");
    if (cliAuthConfirmPrompt == null) {
      throw new Error("Expected cliAuthConfirm prompt metadata to exist");
    }

    const urls = resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        cliAuthConfirm: { type: "custom", url: "/cli/authorize", version: cliAuthConfirmPrompt.latestVersion },
      },
    });

    expect(urls.cliAuthConfirm).toBe("/cli/authorize");
  });

  it("defaults the agent auth confirmation target to the local handler path", () => {
    const urls = resolveHandlerUrls({
      projectId: "project-id",
      urls: {},
    });

    expect(urls.agentAuthConfirm).toBe("/handler/agent-auth-confirm");
  });

  it("supports custom agent auth confirmation targets", () => {
    const agentAuthConfirmPrompt = getPagePrompt("agentAuthConfirm");
    if (agentAuthConfirmPrompt == null) {
      throw new Error("Expected agentAuthConfirm prompt metadata to exist");
    }

    const urls = resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        agentAuthConfirm: { type: "custom", url: "/agents/approve", version: agentAuthConfirmPrompt.latestVersion },
      },
    });

    expect(urls.agentAuthConfirm).toBe("/agents/approve");
  });

  it("builds CLI auth login URLs from the resolved confirmation target", () => {
    expect(buildCliAuthConfirmUrl({
      cliAuthConfirmUrl: "/cli/authorize",
      appUrl: "https://app.example.test/base",
      loginCode: "login-code",
    })).toBe("https://app.example.test/cli/authorize?login_code=login-code");
  });

  it("uses default target for unknown /handler/* pages", () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_HOSTED_HANDLER_DOMAIN_SUFFIX", ".example-stack-hosted.test");

    const url = resolveUnknownHandlerPathFallbackUrl({
      defaultTarget: { type: "hosted" },
      projectId: "project-id",
      unknownPath: "custom-page",
    });

    expect(url).toBe("https://project-id.example-stack-hosted.test/handler/custom-page");
  });

  it("uses the full hosted handler URL template when configured", () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_HOSTED_HANDLER_URL_TEMPLATE", "http://{projectId}.localhost:${NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX:-81}09/{hostedPath}");
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "93");

    const urls = resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        default: { type: "hosted" },
      },
    });

    expect(urls.signIn).toBe("http://project-id.localhost:9309/handler/sign-in");
    expect(urls.accountSettings).toBe("http://project-id.localhost:9309/handler/account-settings");
  });

  it("validates the hosted handler URL template placeholders", () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_HOSTED_HANDLER_URL_TEMPLATE", "http://localhost:9309/{projectId}/handler");

    expect(() => resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        default: { type: "hosted" },
      },
    })).toThrowError(/\{projectId\} and \{hostedPath\}/);
  });

  it("rejects hosted handler URL templates that put the project ID in the path", () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_HOSTED_HANDLER_URL_TEMPLATE", "http://localhost:9309/{projectId}/{hostedPath}");

    expect(() => resolveHandlerUrls({
      projectId: "project-id",
      urls: {
        default: { type: "hosted" },
      },
    })).toThrowErrorMatchingInlineSnapshot(`
      [HexclaveAssertionError: The hosted handler URL template must put {projectId} in the hostname.

      This is likely an error in Hexclave. Please make sure you are running the newest version and report it.]
    `);
  });
});

describe("isLocalHandlerUrlTarget", () => {
  it("treats relative handler URLs as local targets", () => {
    expect(isLocalHandlerUrlTarget({
      targetUrl: "/handler/sign-in",
      handlerPath: "/handler",
      currentOrigin: "http://p91.localhost:9101",
    })).toBe(true);
  });

  it("treats same-origin absolute handler URLs as local targets", () => {
    expect(isLocalHandlerUrlTarget({
      targetUrl: "http://p91.localhost:9101/handler/sign-in",
      handlerPath: "/handler",
      currentOrigin: "http://p91.localhost:9101",
    })).toBe(true);
  });

  it("treats cross-origin absolute handler URLs as non-local targets", () => {
    expect(isLocalHandlerUrlTarget({
      targetUrl: "https://project-id.built-with-hexclave.com/handler/sign-in",
      handlerPath: "/handler",
      currentOrigin: "http://p91.localhost:9101",
    })).toBe(false);
  });

  it("treats non-handler paths as non-local targets", () => {
    expect(isLocalHandlerUrlTarget({
      targetUrl: "/projects",
      handlerPath: "/handler",
      currentOrigin: "http://p91.localhost:9101",
    })).toBe(false);
  });
});
