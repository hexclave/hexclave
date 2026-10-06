// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAnonymousAnalyticsTokenStore, makeAnonymousAnalyticsTokenStorageKey, parseAnonymousAnalyticsTokens } from "./analytics-session";

const PROJECT_ID = "00000000-0000-4000-8000-000000000000";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

let storage: Storage;

beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("anonymous analytics session", () => {
  it("persists its private identity across SSR page reloads", () => {
    const firstPageStore = createAnonymousAnalyticsTokenStore(PROJECT_ID);
    firstPageStore.set({ accessToken: "access-token", refreshToken: "refresh-token" });

    const nextPageStore = createAnonymousAnalyticsTokenStore(PROJECT_ID);

    expect(nextPageStore.get()).toEqual({
      accessToken: "access-token",
      refreshToken: "refresh-token",
    });
  });

  it("fails closed on malformed persisted identities", () => {
    expect(parseAnonymousAnalyticsTokens('{"accessToken":7,"refreshToken":"refresh-token"}')).toEqual({
      accessToken: null,
      refreshToken: null,
    });
  });

  it("removes the persisted identity when its session is invalidated", () => {
    const store = createAnonymousAnalyticsTokenStore(PROJECT_ID);
    store.set({ accessToken: "access-token", refreshToken: "refresh-token" });
    store.set({ accessToken: null, refreshToken: null });

    expect(localStorage.getItem(makeAnonymousAnalyticsTokenStorageKey(PROJECT_ID))).toBeNull();
  });

  it("keeps an in-memory identity when browser storage access is blocked", () => {
    vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new DOMException("Blocked by privacy policy", "SecurityError");
    });
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Blocked by privacy policy", "SecurityError");
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = createAnonymousAnalyticsTokenStore(PROJECT_ID);
    store.set({ accessToken: "access-token", refreshToken: "refresh-token" });

    expect(store.get()).toEqual({ accessToken: "access-token", refreshToken: "refresh-token" });
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it("keeps the updated in-memory identity when persistence exceeds quota", () => {
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createAnonymousAnalyticsTokenStore(PROJECT_ID);

    store.set({ accessToken: "access-token", refreshToken: "refresh-token" });

    expect(store.get()).toEqual({ accessToken: "access-token", refreshToken: "refresh-token" });
  });
});
