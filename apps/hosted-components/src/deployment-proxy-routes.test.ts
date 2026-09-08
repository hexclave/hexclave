import { describe, expect, it } from "vitest";
import { deploymentProxyHostPattern, deploymentProxyRoutes } from "./deployment-proxy-routes";
import { platformHostname } from "../../marshal/src/platform-domain-names";
import { appNameForService } from "../../marshal/src/fly/naming";

describe("deployment proxy routing contract", () => {
  it("routes Marshal's generated names to their existing Fly apps", () => {
    for (const identity of [["production", "project-1", "web"], ["dev", "project-2", "api"], ["staging", "namespace/with spaces", "group/service"]]) {
      const [env, ns, key] = identity;
      const hostname = platformHostname(env, ns, key);
      const match = new RegExp(deploymentProxyHostPattern).exec(hostname);
      expect(match?.groups?.appSuffix).toBe(appNameForService(env, ns, key).slice(4));
    }
  });

  it.each([
    "project-id.built-with-hexclave.com", "internal.built-with-hexclave.com",
    "built-with-hexclave.com", "deploy-.built-with-hexclave.com",
    "deploy--bad.built-with-hexclave.com", "deploy-bad-.built-with-hexclave.com",
    "deploy-bad.name.built-with-hexclave.com", "deploy-test.built-with-hexclave.com.attacker.com",
    "deploy-test@evil.com", "deploy-test.built-with-hexclave.com:443",
    `deploy-${"a".repeat(57)}.built-with-hexclave.com`,
    "deploy-test.built-with-hexclave.com\n",
  ])("does not proxy invalid or hosted-component hostname %s", (hostname) => {
    // Browser/edge host parsing rejects control characters before route evaluation.
    expect(new RegExp(deploymentProxyHostPattern).exec(hostname)?.[0] === hostname).toBe(false);
  });

  it("allows matching apps without an ownership registry", () => {
    expect(new RegExp(deploymentProxyHostPattern).exec("deploy-someone-elses-app.built-with-hexclave.com")?.groups?.appSuffix).toBe("someone-elses-app");
  });

  it("matches all application paths, including paths used by hosted components", () => {
    const route = deploymentProxyRoutes[0];
    for (const path of ["/", "/handler/sign-in", "/llms.txt", "/assets/index.js", "/favicon.ico", "/api/upload", "/socket"]) {
      expect(new RegExp(route.src).exec(path)?.[1]).toBe(path.slice(1));
    }
    expect(route.dest).toBe("https://hxc-$appSuffix.fly.dev/$1");
    // No method restriction: POST/PUT/DELETE/OPTIONS must reach the deployment too.
    expect("methods" in route).toBe(false);
    expect("continue" in route).toBe(false);
  });
});
