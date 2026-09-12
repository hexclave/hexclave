import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearTvDisplayRefreshCookie,
  setTvDisplayRefreshCookie,
} from "./display-refresh-cookie";

describe("TV display refresh cookie policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("issues alias-scoped credentials with the 30-day idle lifetime while clearing the legacy broad cookie", () => {
    const set = vi.fn();
    setTvDisplayRefreshCookie({ set }, "tv-refresh", "secret");

    expect(set.mock.calls).toEqual([
      ["tv-refresh", "", expect.objectContaining({ path: "/api", expires: new Date(0), maxAge: 0 })],
      ["tv-refresh", "secret", expect.objectContaining({ path: "/api/latest/tv-displays", maxAge: 30 * 24 * 60 * 60 })],
      ["tv-refresh", "secret", expect.objectContaining({ path: "/api/v1/tv-displays", maxAge: 30 * 24 * 60 * 60 })],
    ]);
    for (const [, , options] of set.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ httpOnly: true, secure: false, sameSite: "strict" }));
    }
  });

  it("clears both supported aliases and the legacy broad scope", () => {
    const set = vi.fn();
    clearTvDisplayRefreshCookie({ set }, "tv-refresh");

    expect(set.mock.calls.map(([, , options]) => options.path)).toEqual([
      "/api/latest/tv-displays",
      "/api/v1/tv-displays",
      "/api",
    ]);
    for (const [name, value, options] of set.mock.calls) {
      expect({ name, value, options }).toEqual({
        name: "tv-refresh",
        value: "",
        options: expect.objectContaining({ expires: new Date(0), maxAge: 0 }),
      });
    }
  });

  it("marks production refresh cookies as secure", () => {
    vi.stubEnv("NODE_ENV", "production");
    const set = vi.fn();
    setTvDisplayRefreshCookie({ set }, "tv-refresh", "secret");
    for (const [, , options] of set.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ secure: true }));
    }
  });

  it("uses SameSite=None only for a distinct secure display origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HEXCLAVE_TV_DISPLAY_ORIGIN", "https://tv.example.com");
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "https://api.example.com");
    vi.stubEnv("NEXT_PUBLIC_STACK_API_URL", "https://api.example.com");
    const set = vi.fn();
    setTvDisplayRefreshCookie({ set }, "tv-refresh", "secret");
    for (const [, , options] of set.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ secure: true, sameSite: "none" }));
    }
  });

  it("uses the dashboard URL fallback for a distinct secure display origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL", "https://tv.example.com");
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "https://api.example.com");
    vi.stubEnv("NEXT_PUBLIC_STACK_API_URL", "https://api.example.com");
    const set = vi.fn();
    setTvDisplayRefreshCookie({ set }, "tv-refresh", "secret");
    for (const [, , options] of set.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ secure: true, sameSite: "none" }));
    }
  });

  it("keeps SameSite=Strict for same-site and development displays", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HEXCLAVE_TV_DISPLAY_ORIGIN", "https://api.example.com");
    vi.stubEnv("NEXT_PUBLIC_HEXCLAVE_API_URL", "https://api.example.com");
    vi.stubEnv("NEXT_PUBLIC_STACK_API_URL", "https://api.example.com");
    const set = vi.fn();
    setTvDisplayRefreshCookie({ set }, "tv-refresh", "secret");
    expect(set.mock.calls[1][2]).toEqual(expect.objectContaining({ sameSite: "strict" }));

    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("HEXCLAVE_TV_DISPLAY_ORIGIN", "https://tv.example.com");
    setTvDisplayRefreshCookie({ set }, "tv-refresh", "secret");
    expect(set.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({ secure: false, sameSite: "strict" }));
  });
});
