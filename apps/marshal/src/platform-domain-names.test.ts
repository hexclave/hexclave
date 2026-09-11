import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appNameForService } from "./fly/naming.js";
import { DEVELOPMENT_PLATFORM_HOSTNAME_KEY, isPlatformHostname, platformDomain, platformHostname, platformHostnameKey, platformHostnameMac } from "./platform-domain-names.js";

describe("Fly proxy hostnames", () => {
  beforeEach(() => {
    vi.stubEnv("HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY", DEVELOPMENT_PLATFORM_HOSTNAME_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses an explicit domain override for generation and reservation", () => {
    vi.stubEnv("HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN", "deploy.example.net");
    expect(platformHostname("test", "project", "web")).toMatch(/\.deploy\.example\.net$/);
    expect(isPlatformHostname("app.deploy.example.net")).toBe(true);
    expect(isPlatformHostname("app.deploy.built-with-hexclave.com")).toBe(false);
  });

  it("treats an empty domain override as unset, since the .env placeholder loads as empty", () => {
    vi.stubEnv("HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN", "");
    expect(platformDomain()).toBe("deploy.built-with-hexclave.com");
  });

  it.each(["*.example.net", "Example.net", "-bad.example.net", "example.net/", "example.net\n", "a".repeat(64) + ".net", "a.".repeat(96) + "net"])("rejects invalid domain %j", (domain) => {
    vi.stubEnv("HEXCLAVE_DEPLOYMENT_PLATFORM_DOMAIN", domain);
    expect(() => platformDomain()).toThrow("lowercase DNS domain");
  });

  it("reuses the complete Fly app identity without a DNS lookup or certificate", () => {
    const hostname = platformHostname("prod", "project", "web");
    const [label] = hostname.split(".");
    const appSuffix = label.slice(0, -17);
    expect(`hxc-${appSuffix}`).toBe(appNameForService("prod", "project", "web"));
    expect(label.length).toBeLessThanOrEqual(63);
    expect(platformHostname("prod", "project", "api")).not.toBe(hostname);
    expect(platformHostname("dev", "project", "web")).not.toBe(hostname);
    expect(platformHostname("prod", "another", "web")).not.toBe(hostname);
  });

  it("signs the hostname so only a key holder can mint one the gateway routes", () => {
    const hostname = platformHostname("prod", "project", "web");
    const [label] = hostname.split(".");
    const appSuffix = label.slice(0, -17);
    const mac = label.slice(-16);
    expect(mac).toMatch(/^[0-9a-f]{16}$/);
    expect(mac).toBe(platformHostnameMac("deploy.built-with-hexclave.com", appSuffix, platformHostnameKey()));
    // A different key, a different domain, or a different app each yield a different mac.
    expect(platformHostnameMac("deploy.built-with-hexclave.com", appSuffix, Buffer.alloc(32, 1))).not.toBe(mac);
    expect(platformHostnameMac("deploy.example.net", appSuffix, platformHostnameKey())).not.toBe(mac);
    expect(platformHostnameMac("deploy.built-with-hexclave.com", `${appSuffix.slice(0, -1)}0`, platformHostnameKey())).not.toBe(mac);
    vi.stubEnv("HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY", "0".repeat(64));
    expect(platformHostname("prod", "project", "web")).not.toBe(hostname);
    expect(platformHostname("prod", "project", "web").slice(0, appSuffix.length)).toBe(appSuffix);
  });

  // Pinned so a change to the mac construction cannot go unnoticed: the gateway's own test
  // (apps/deployment-gateway/gateway.test.mjs) routes this exact hostname.
  it("matches the gateway's construction of the mac", () => {
    expect(platformHostnameMac("deploy.built-with-hexclave.com", "t-ns-ke-0123456789abcdef01", Buffer.from(DEVELOPMENT_PLATFORM_HOSTNAME_KEY, "hex"))).toBe("b8e6cf5af5b36a08");
  });

  it.each(["", "short", "g".repeat(64), "0".repeat(63), "0".repeat(65)])("rejects invalid key %j", (key) => {
    vi.stubEnv("HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY", key);
    expect(() => platformHostnameKey()).toThrow("64 hexadecimal characters");
    expect(() => platformHostname("prod", "project", "web")).toThrow("HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY");
  });

  it("reserves generated names without reserving hosted components", () => {
    expect(isPlatformHostname("Example.deploy.built-with-hexclave.com.")).toBe(true);
    expect(isPlatformHostname("deploy.built-with-hexclave.com")).toBe(true);
    expect(isPlatformHostname("nested.example.deploy.built-with-hexclave.com")).toBe(true);
    expect(isPlatformHostname("project-id.built-with-hexclave.com")).toBe(false);
    expect(isPlatformHostname("test.deploy.built-with-hexclave.com.attacker.com")).toBe(false);
  });
});
