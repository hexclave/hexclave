import { afterEach, describe, expect, it, vi } from "vitest";
import { appNameForService } from "./fly/naming.js";
import { isPlatformHostname, platformDomain, platformHostname } from "./platform-domain-names.js";

describe("Fly proxy hostnames", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses an explicit domain override for generation and reservation", () => {
    vi.stubEnv("HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN", "deploy.example.net");
    expect(platformHostname("test", "project", "web")).toMatch(/\.deploy\.example\.net$/);
    expect(isPlatformHostname("app.deploy.example.net")).toBe(true);
    expect(isPlatformHostname("app.deploy.built-with-hexclave.com")).toBe(false);
  });

  it.each(["", "*.example.net", "Example.net", "-bad.example.net", "example.net/", "example.net\n", "a".repeat(64) + ".net", "a.".repeat(96) + "net"])("rejects invalid domain %j", (domain) => {
    vi.stubEnv("HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN", domain);
    expect(() => platformDomain()).toThrow("lowercase DNS domain");
  });
  it("reuses the complete Fly app identity without a DNS lookup or certificate", () => {
    const hostname = platformHostname("prod", "project", "web");
    expect(`hxc-${hostname.split(".")[0]}`).toBe(appNameForService("prod", "project", "web"));
    expect(hostname.split(".")[0].length).toBeLessThanOrEqual(63);
    expect(platformHostname("prod", "project", "api")).not.toBe(hostname);
    expect(platformHostname("dev", "project", "web")).not.toBe(hostname);
    expect(platformHostname("prod", "another", "web")).not.toBe(hostname);
  });

  it("reserves generated names without reserving hosted components", () => {
    expect(isPlatformHostname("Example.deploy.built-with-hexclave.com.")).toBe(true);
    expect(isPlatformHostname("deploy.built-with-hexclave.com")).toBe(true);
    expect(isPlatformHostname("nested.example.deploy.built-with-hexclave.com")).toBe(true);
    expect(isPlatformHostname("project-id.built-with-hexclave.com")).toBe(false);
    expect(isPlatformHostname("test.deploy.built-with-hexclave.com.attacker.com")).toBe(false);
  });
});
