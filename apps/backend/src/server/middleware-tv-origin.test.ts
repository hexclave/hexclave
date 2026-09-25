import { afterAll, expect, it, vi } from "vitest";
import { getCorsHeadersInit } from "./middleware";

vi.hoisted(() => {
  // The production middleware caches its origin at module initialization.
  // Set configuration before imports, without mocking the resolver or passing
  // an origin directly to the private CORS helper.
  vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL", "https://dashboard.example.com");
  vi.stubEnv("NEXT_PUBLIC_STACK_DASHBOARD_URL", "");
  vi.stubEnv("HEXCLAVE_TV_DISPLAY_ORIGIN", "https://stale-tv.example.com");
  vi.stubEnv("NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL", "https://stale-browser.example.com");
});

afterAll(() => {
  vi.unstubAllEnvs();
});

it("uses the canonical dashboard at initialization for credentialed TV CORS", () => {
  for (const alias of ["latest", "v1"]) {
    for (const method of ["OPTIONS", "POST"]) {
      for (const origin of [
        "https://dashboard.example.com",
        "https://stale-tv.example.com",
        "https://stale-browser.example.com",
        "https://dashboard.example.com.attacker.example",
      ]) {
        const headers = new Headers(getCorsHeadersInit(new Request(
          `https://api.example.com/api/${encodeURIComponent(alias)}/tv-displays/auth/refresh`,
          { method, headers: { origin } },
        )));
        const allowed = origin === "https://dashboard.example.com";
        expect(headers.get("access-control-allow-origin")).toBe(allowed ? origin : "*");
        expect(headers.get("access-control-allow-credentials")).toBe(allowed ? "true" : null);
        expect(headers.get("vary")).toContain("Origin");
      }
    }
  }
});

it("does not enable credentialed CORS for ordinary API routes", () => {
  const headers = new Headers(getCorsHeadersInit(new Request(
    "https://api.example.com/api/latest/users/me",
    { headers: { origin: "https://dashboard.example.com" } },
  )));
  expect(headers.get("access-control-allow-origin")).toBe("*");
  expect(headers.has("access-control-allow-credentials")).toBe(false);
});
