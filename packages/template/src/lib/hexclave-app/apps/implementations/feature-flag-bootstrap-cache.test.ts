import type { FeatureFlagBootstrapResponse } from "@hexclave/shared/dist/interface/crud/feature-flags";
import { createFeatureFlagsBootstrap } from "@hexclave/shared/dist/feature-flags/canonical";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagBootstrapCache, FeatureFlagBootstrapUnavailableError, type FeatureFlagBootstrapFetchResult } from "./feature-flag-bootstrap-cache";

function bootstrap(version: string): FeatureFlagBootstrapResponse {
  const canonical = createFeatureFlagsBootstrap({
    flags: {},
    segments: {},
    holdouts: {},
    mutualExclusionGroups: {},
    experiments: {},
  });
  return {
    config: canonical.config,
    flag_ids_by_key: canonical.flagIdsByKey,
    config_version: version === "canonical" ? canonical.configVersion : version,
  };
}

describe("FeatureFlagBootstrapCache", () => {
  it("revalidates after thirty seconds with ETags", async () => {
    let now = 0;
    const fetch = vi.fn(async (etag?: string): Promise<FeatureFlagBootstrapFetchResult> => etag == null
      ? { status: "ok", data: bootstrap("canonical"), etag: '"v1"' }
      : { status: "not-modified" });
    const cache = new FeatureFlagBootstrapCache(fetch, () => now);

    const version = bootstrap("canonical").config_version;
    expect((await cache.get()).config_version).toBe(version);
    now = 29_999;
    expect((await cache.get()).isStale).toBe(false);
    now = 30_000;
    expect((await cache.get()).config_version).toBe(version);
    expect(fetch).toHaveBeenNthCalledWith(2, '"v1"');
  });

  it("serves a validated snapshot for five minutes during transient failure", async () => {
    let now = 0;
    let offline = false;
    const cache = new FeatureFlagBootstrapCache(async () => {
      if (offline) throw new Error("network diagnostics failed", { cause: new TypeError("offline") });
      return { status: "ok", data: bootstrap("canonical"), etag: '"v1"' };
    }, () => now);

    await cache.get();
    offline = true;
    now = 30_000;
    expect((await cache.get()).isStale).toBe(true);
    now = 300_001;
    await expect(cache.get()).rejects.toBeInstanceOf(FeatureFlagBootstrapUnavailableError);
  });

  it("does not hide authorization failures behind stale definitions", async () => {
    const authorizationError = Object.assign(new Error("unauthorized"), { status: 401 });
    const cache = new FeatureFlagBootstrapCache(async () => {
      throw authorizationError;
    });
    await expect(cache.get()).rejects.toBe(authorizationError);
  });

  it("rejects a bootstrap whose revision or public-key lookup does not match its definitions", async () => {
    const mismatchedVersion = new FeatureFlagBootstrapCache(async () => ({
      status: "ok",
      data: bootstrap("wrong"),
      etag: null,
    }));
    await expect(mismatchedVersion.get()).rejects.toThrowError("config version does not match");

    const data = bootstrap("canonical");
    data.flag_ids_by_key.checkout = "missing";
    const mismatchedLookup = new FeatureFlagBootstrapCache(async () => ({ status: "ok", data, etag: null }));
    await expect(mismatchedLookup.get()).rejects.toThrowError("public-key lookup does not match");
  });
});
