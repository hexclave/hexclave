import { describe, expect, it, vi } from "vitest";
import { getPublicEnvVar } from "@/lib/env";
import { buildTvDisplayUrl, getConfiguredTvDisplayUrl, isLocalTvDisplayUrl } from "./display-url";

vi.mock("@/lib/env", () => ({ getPublicEnvVar: vi.fn() }));

describe("TV display URL", () => {
  it("prefers the configured dashboard origin", () => {
    expect(buildTvDisplayUrl({
      dashboardUrl: "https://dashboard.example.com/projects/project-fixture",
      currentOrigin: "http://localhost:8101",
    })).toBe("https://dashboard.example.com/tv");
  });

  it("does not consult the browser-specific override for configured TV links", () => {
    vi.mocked(getPublicEnvVar).mockImplementation((name) => name === "NEXT_PUBLIC_STACK_DASHBOARD_URL"
      ? "https://dashboard.example.com"
      : "https://stale.example.com");
    expect(getConfiguredTvDisplayUrl("http://localhost:8101")).toBe("https://dashboard.example.com/tv");
    expect(getPublicEnvVar).toHaveBeenCalledTimes(1);
    expect(getPublicEnvVar).toHaveBeenCalledWith("NEXT_PUBLIC_STACK_DASHBOARD_URL");
    vi.mocked(getPublicEnvVar).mockReset();
  });

  it("falls back through the configured dashboard and current browser origins", () => {
    expect(buildTvDisplayUrl({
      dashboardUrl: "https://app.example.com",
      currentOrigin: "http://localhost:8101",
    })).toBe("https://app.example.com/tv");
    expect(buildTvDisplayUrl({ currentOrigin: "http://a.localhost:9101" })).toBe("http://a.localhost:9101/tv");
    expect(buildTvDisplayUrl({})).toBeNull();
  });

  it("skips empty or malformed configured origins", () => {
    expect(buildTvDisplayUrl({
      dashboardUrl: "not a URL",
      currentOrigin: "http://localhost:8101",
    })).toBe("http://localhost:8101/tv");
    expect(buildTvDisplayUrl({ dashboardUrl: "" })).toBeNull();
    expect(buildTvDisplayUrl({ dashboardUrl: "not a URL" })).toBeNull();
  });

  it("skips unsupported protocols and continues to later candidates", () => {
    expect(buildTvDisplayUrl({
      dashboardUrl: "file:///tmp/dashboard",
      currentOrigin: "https://dashboard.example.com",
    })).toBe("https://dashboard.example.com/tv");
    expect(buildTvDisplayUrl({
      dashboardUrl: "ftp://dashboard.example.com",
      currentOrigin: "file:///tmp/dashboard",
    })).toBeNull();
  });

  it("identifies loopback and local development hosts", () => {
    expect(isLocalTvDisplayUrl("http://localhost:8101/tv")).toBe(true);
    expect(isLocalTvDisplayUrl("http://127.0.0.1:8101/tv")).toBe(true);
    expect(isLocalTvDisplayUrl("http://127.1.2.3:8101/tv")).toBe(true);
    expect(isLocalTvDisplayUrl("http://a.localhost:9101/tv")).toBe(true);
    expect(isLocalTvDisplayUrl("https://app.example.com/tv")).toBe(false);
  });
});
