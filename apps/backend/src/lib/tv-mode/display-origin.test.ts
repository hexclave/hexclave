import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfiguredTvDisplayOrigin } from "./display-origin";

describe("TV display canonical dashboard origin", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL", "");
    vi.stubEnv("NEXT_PUBLIC_STACK_DASHBOARD_URL", "");
    // Neither old override is an alternative source of credentialed trust.
    vi.stubEnv("HEXCLAVE_TV_DISPLAY_ORIGIN", "https://stale-tv.example.com");
    vi.stubEnv("NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL", "https://stale-browser.example.com");
    vi.stubEnv("NEXT_PUBLIC_BROWSER_HEXCLAVE_DASHBOARD_URL", "https://another-stale-browser.example.com");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["https://app.dev.example.com", "https://app.example.com", "http://localhost:9101"])(
    "uses the canonical setting %s without consulting stale overrides", (origin) => {
      vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL", origin);
      expect(getConfiguredTvDisplayOrigin()).toBe(origin);
    },
  );

  it("preserves legacy alias support", () => {
    vi.stubEnv("NEXT_PUBLIC_STACK_DASHBOARD_URL", "https://legacy.example.com");
    expect(getConfiguredTvDisplayOrigin()).toBe("https://legacy.example.com");
  });

  it("does not silently choose between conflicting canonical and legacy settings", () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL", "https://app.example.com");
    vi.stubEnv("NEXT_PUBLIC_STACK_DASHBOARD_URL", "https://stale.example.com");
    expect(() => getConfiguredTvDisplayOrigin()).toThrow("both set to different values");
  });

  it("accepts matching aliases and trims the configured URL", () => {
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL", " https://app.example.com ");
    vi.stubEnv("NEXT_PUBLIC_STACK_DASHBOARD_URL", " https://app.example.com ");
    expect(getConfiguredTvDisplayOrigin()).toBe("https://app.example.com");
  });

  it("leaves credentialed CORS unconfigured when the dashboard setting is missing", () => {
    expect(getConfiguredTvDisplayOrigin()).toBe("");
  });
});
