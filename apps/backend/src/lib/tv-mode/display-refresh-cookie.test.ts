import { afterEach, describe, expect, it, vi } from "vitest";
import type { CookieWrite, ResponseCookieOptions } from "@/lib/runtime/request-context";
import {
  clearTvDisplayRefreshCookie,
  readTvDisplayRefreshCookie,
  setTvDisplayRefreshCookie,
} from "./display-refresh-cookie";

// Model the affected libsoup SQLite jar: memory keys include path, but replacing
// an existing cookie deletes persisted rows by name + host only. All cookies in
// these tests share a host. Reload must use disk state, not the still-correct RAM jar.
function createAffectedPersistentJar() {
  const persisted = new Map<string, CookieWrite>();
  let memory = new Map<string, CookieWrite>();
  return {
    set(name: string, value: string, options: ResponseCookieOptions) {
      const key = JSON.stringify([name, options.path]);
      if (memory.has(key)) {
        for (const [storedKey, cookie] of persisted) {
          if (cookie.name === name) persisted.delete(storedKey);
        }
      }
      if (options.maxAge === 0) {
        memory.delete(key);
      } else {
        const cookie = { name, value, options };
        memory.set(key, cookie);
        persisted.set(key, cookie);
      }
    },
    reload() {
      memory = new Map(persisted);
      return [...memory.values()];
    },
  };
}

describe("TV display refresh cookie policy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("clears legacy scopes before issuing distinctly named alias credentials with a 30-day lifetime", () => {
    const set = vi.fn();
    setTvDisplayRefreshCookie({ set }, "tv-refresh", "secret");

    expect(set.mock.calls).toEqual([
      ["tv-refresh", "", expect.objectContaining({ path: "/api", expires: new Date(0), maxAge: 0 })],
      ["tv-refresh", "", expect.objectContaining({ path: "/api/v1/tv-displays", expires: new Date(0), maxAge: 0 })],
      ["tv-refresh", "secret", expect.objectContaining({ path: "/api/latest/tv-displays", maxAge: 30 * 24 * 60 * 60 })],
      ["tv-refresh-v1", "secret", expect.objectContaining({ path: "/api/v1/tv-displays", maxAge: 30 * 24 * 60 * 60 })],
    ]);
    for (const [, , options] of set.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ httpOnly: true, secure: false, sameSite: "strict" }));
    }
  });

  it("clears both current cookies and all historical scopes", () => {
    const set = vi.fn();
    clearTvDisplayRefreshCookie({ set }, "tv-refresh");

    expect(set.mock.calls.map(([name, , options]) => [name, options.path])).toEqual([
      ["tv-refresh", "/api/latest/tv-displays"],
      ["tv-refresh", "/api/v1/tv-displays"],
      ["tv-refresh", "/api"],
      ["tv-refresh-v1", "/api/v1/tv-displays"],
    ]);
    for (const [, value, options] of set.mock.calls) {
      expect({ value, options }).toEqual({
        value: "",
        options: expect.objectContaining({ httpOnly: true, expires: new Date(0), maxAge: 0 }),
      });
    }
  });

  it.each([
    { alias: "latest", current: "latest-token", v1: "v1-token", expected: "latest-token" },
    { alias: "latest", current: undefined, v1: "v1-token", expected: undefined },
    { alias: "v1", current: "legacy-token", v1: "v1-token", expected: "v1-token" },
    { alias: "v1", current: "legacy-token", v1: undefined, expected: "legacy-token" },
    { alias: "v1", current: "legacy-token", v1: "", expected: "" },
    { alias: "v1", current: "legacy-token", v1: "invalid-token", expected: "invalid-token" },
    { alias: "v1", current: undefined, v1: undefined, expected: undefined },
  ])("selects one credential for $alias without shadowing or fallback on invalid values ($v1)", ({ alias, current, v1, expected }) => {
    const incoming = new Map([
      ["tv-refresh", current],
      ["tv-refresh-v1", v1],
    ]);
    const get = (name: string) => {
      const value = incoming.get(name);
      return value == null ? undefined : { value };
    };
    expect(readTvDisplayRefreshCookie({ get }, "tv-refresh", `https://example.com/api/${alias}/tv-displays/auth/refresh`)).toBe(expected);
  });

  it("reproduces the old same-name cookie loss after rotation and reload", () => {
    const jar = createAffectedPersistentJar();
    for (const token of ["initial", "rotated"]) {
      jar.set("tv-refresh", token, { path: "/api/latest/tv-displays", maxAge: 2592000 });
      jar.set("tv-refresh", token, { path: "/api/v1/tv-displays", maxAge: 2592000 });
      jar.reload();
    }
    expect(jar.reload().map(cookie => cookie.options.path)).toEqual(["/api/v1/tv-displays"]);
  });

  it.each([
    { state: "fresh jar", paths: [] },
    { state: "legacy broad cookie", paths: ["/api"] },
    { state: "old alias cookies", paths: ["/api/latest/tv-displays", "/api/v1/tv-displays"] },
    { state: "already-lost latest cookie", paths: ["/api/v1/tv-displays"] },
    { state: "all historical scopes", paths: ["/api", "/api/latest/tv-displays", "/api/v1/tv-displays"] },
  ])("retains both aliases across ten rotations/reloads from $state, and clears them on unpair", ({ paths }) => {
    const jar = createAffectedPersistentJar();
    for (const path of paths) {
      jar.set("tv-refresh", "legacy", { path, maxAge: 2592000 });
    }
    jar.reload();
    for (let rotation = 0; rotation < 10; rotation++) {
      const token = `rotation-${rotation}`;
      setTvDisplayRefreshCookie(jar, "tv-refresh", token);
      expect(jar.reload()).toEqual([
        { name: "tv-refresh", value: token, options: expect.objectContaining({ path: "/api/latest/tv-displays", httpOnly: true, maxAge: 2592000 }) },
        { name: "tv-refresh-v1", value: token, options: expect.objectContaining({ path: "/api/v1/tv-displays", httpOnly: true, maxAge: 2592000 }) },
      ]);
    }
    clearTvDisplayRefreshCookie(jar, "tv-refresh");
    expect(jar.reload()).toEqual([]);
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
