import { afterEach, describe, expect, it, vi } from "vitest";
import { checkBrowserReports, configureLiveRun, liveCredentialSettings, liveRunIdentity, newLiveRun, parseLiveRun, waitForLiveCheck } from "./live-platform-domain-test.js";
import { logicalStorageKey, storageKey } from "./storage-prefix.js";

const credentials = {
  FLY_API_TOKEN: "test-fly-token", FLY_ORG_SLUG: "test-org",
  S3_ACCESS_KEY_ID: "test-access", S3_SECRET_ACCESS_KEY: "test-secret",
  S3_API_ENDPOINT: "https://s3.example.com", S3_BUCKET_NAME: "test-bucket",
  GATEWAY_HOSTNAME_KEY: "f".repeat(64),
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("live test setup (no provider calls)", () => {
  it("maps local credential aliases and prefers canonical names", () => {
    const settings = liveCredentialSettings({ ...credentials, MARSHAL_FLY_ORG_SLUG: "canonical" });
    expect(settings.MARSHAL_FLY_ORG_SLUG).toBe("canonical");
    expect(settings.MARSHAL_FLY_API_TOKEN).toBe(credentials.FLY_API_TOKEN);
    expect(settings.MARSHAL_S3_BUCKET).toBe(credentials.S3_BUCKET_NAME);
    expect(() => liveCredentialSettings({ ...credentials, FLY_API_TOKEN: "" })).toThrow("FLY_API_TOKEN");
    expect(() => liveCredentialSettings({ ...credentials, S3_API_ENDPOINT: "http://localhost" })).toThrow("HTTPS");
    expect(() => liveCredentialSettings({ ...credentials, GATEWAY_HOSTNAME_KEY: "" })).toThrow("HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY");
  });

  it("validates recovery identity and account scope before cleanup", () => {
    const settings = liveCredentialSettings(credentials);
    const run = newLiveRun(settings);
    expect(parseLiveRun(JSON.parse(JSON.stringify(run)), settings)).toEqual(run);
    expect(() => parseLiveRun({ ...run, id: "../other-run" }, settings)).toThrow("Recovery file");
    expect(() => parseLiveRun({ ...run, encryptionKey: "bad" }, settings)).toThrow("Recovery file");
    expect(() => parseLiveRun(run, { ...settings, MARSHAL_FLY_ORG_SLUG: "other-org" })).toThrow("different Fly");
    expect(() => parseLiveRun(run, { ...settings, MARSHAL_S3_BUCKET: "other-bucket" })).toThrow("different Fly");
    vi.stubEnv("HEXCLAVE_DEPLOYMENT_HOSTNAME_KEY", credentials.GATEWAY_HOSTNAME_KEY);
    const identity = liveRunIdentity(run);
    expect(identity.hostname).toMatch(/^[a-z0-9-]+-[0-9a-f]{16}\.deploy\.built-with-hexclave\.com$/);
    expect(liveRunIdentity(newLiveRun(settings))).not.toEqual(identity);
  });

  it("isolates real provider endpoints and state from inherited development settings", () => {
    const previous = { ...process.env };
    try {
      process.env.HEXCLAVE_MARSHAL_GCP_PROJECT_ID = "inherited";
      process.env.MARSHAL_FLY_MACHINES_API_URL = "http://localhost";
      const settings = liveCredentialSettings(credentials);
      const run = newLiveRun(settings);
      configureLiveRun(settings, run);
      expect(process.env.MARSHAL_FLY_MACHINES_API_URL).toBe("https://api.machines.dev");
      expect(process.env.HEXCLAVE_MARSHAL_GCP_PROJECT_ID).toBeUndefined();
      expect(storageKey("specs/test/web.json")).toBe(`live-domain-tests/${run.id}/specs/test/web.json`);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  });

  it("does not run a check after interruption and propagates check errors", async () => {
    const check = vi.fn(async () => true);
    await expect(waitForLiveCheck("test", check, AbortSignal.abort(new Error("interrupted")), 0)).rejects.toThrow("interrupted");
    expect(check).not.toHaveBeenCalled();
    await expect(waitForLiveCheck("test", async () => false, new AbortController().signal, 0)).rejects.toThrow("Timed out");
    await expect(waitForLiveCheck("test", async () => {
      throw new Error("provider failure");
    }, new AbortController().signal, 0)).rejects.toThrow("provider failure");
  });
});

describe("isolated S3 keys", () => {
  it("preserves existing keys by default and round-trips prefixed keys", () => {
    vi.stubEnv("HEXCLAVE_MARSHAL_S3_KEY_PREFIX", "");
    expect(storageKey("specs/test/web.json")).toBe("specs/test/web.json");
    vi.stubEnv("HEXCLAVE_MARSHAL_S3_KEY_PREFIX", "live-domain-tests/run/");
    expect(logicalStorageKey(storageKey("specs/test/web.json"))).toBe("specs/test/web.json");
    expect(() => logicalStorageKey("specs/production/web.json")).toThrow("outside");
  });
  it.each(["/absolute/", "../", "missing-slash", "double//slash/"])("rejects ambiguous prefix %s", (prefix) => {
    vi.stubEnv("HEXCLAVE_MARSHAL_S3_KEY_PREFIX", prefix);
    expect(() => storageKey("test")).toThrow("HEXCLAVE_MARSHAL_S3_KEY_PREFIX");
  });
});


describe("browser compatibility reports", () => {
  const hosts = ["test.deploy.built-with-hexclave.com", "hxc-test.fly.dev"];
  const report = (origin: string) => ({ marker: "run-marker", origin, failures: [], lines: ["PASS: streaming", "PASS: cookies", "PASS: WebSockets"] });
  it("requires completed checks from both origins", () => {
    expect(checkBrowserReports([], "run-marker", hosts)).toBe(false);
    expect(checkBrowserReports([report(hosts[0])], "run-marker", hosts)).toBe(false);
    expect(checkBrowserReports(hosts.map(report), "run-marker", hosts)).toBe(true);
  });
  it("waits for the baseline after a proxy failure and includes both reports in the error", () => {
    const failed = { ...report(hosts[0]), failures: ["WebSockets"], lines: ["PASS: streaming", "PASS: cookies", "FAIL: WebSockets"] };
    expect(checkBrowserReports([failed], "run-marker", hosts)).toBe(false);
    expect(checkBrowserReports([failed, failed], "run-marker", hosts)).toBe(false);
    expect(() => checkBrowserReports([failed, report(hosts[1])], "run-marker", hosts)).toThrow(hosts[1]);
  });
  it("rejects stale, incomplete, and failed results", () => {
    expect(() => checkBrowserReports([report(hosts[0])], "another-run", hosts)).toThrow("identity");
    expect(() => checkBrowserReports([report("another-host")], "run-marker", hosts)).toThrow("identity");
    expect(() => checkBrowserReports([{ ...report(hosts[0]), lines: [] }], "run-marker", hosts)).toThrow("Incomplete");
    expect(() => checkBrowserReports([{ ...report(hosts[0]), failures: ["WebSockets"] }, report(hosts[1])], "run-marker", hosts)).toThrow("WebSockets");
  });
});
