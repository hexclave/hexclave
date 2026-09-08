import { describe, expect, it } from "vitest";
import { appNameForService } from "./fly/naming.js";
import { isPlatformHostname, platformHostname } from "./platform-domain-names.js";

describe("Fly proxy hostnames", () => {
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
