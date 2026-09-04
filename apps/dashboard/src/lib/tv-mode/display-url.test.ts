import { describe, expect, it } from "vitest";
import { buildTvDisplayUrl, isLocalTvDisplayUrl } from "./display-url";

describe("TV display URL", () => {
  it("prefers the configured browser dashboard origin", () => {
    expect(buildTvDisplayUrl({
      browserDashboardUrl: "https://dashboard.example.com/projects/project-fixture",
      dashboardUrl: "https://fallback.example.com",
      currentOrigin: "http://localhost:8101",
    })).toBe("https://dashboard.example.com/tv");
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
      browserDashboardUrl: "",
      dashboardUrl: "not a URL",
      currentOrigin: "http://localhost:8101",
    })).toBe("http://localhost:8101/tv");
    expect(buildTvDisplayUrl({ browserDashboardUrl: "not a URL" })).toBeNull();
  });

  it("skips unsupported protocols and continues to later candidates", () => {
    expect(buildTvDisplayUrl({
      browserDashboardUrl: "file:///tmp/dashboard",
      dashboardUrl: "https://dashboard.example.com",
    })).toBe("https://dashboard.example.com/tv");
    expect(buildTvDisplayUrl({
      browserDashboardUrl: "ftp://dashboard.example.com",
      dashboardUrl: "file:///tmp/dashboard",
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
