import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { augmentUrlWithPersistedRedirectBackState, getRawAfterAuthReturnTo, readRedirectBackState, saveRedirectBackStateFromUrl } from "./redirect-back-state";

function createMockSessionStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

const previousWindow = globalThis["window"];
const hadPreviousWindow = Reflect.has(globalThis, "window");
const projectId = "00000000-0000-4000-8000-000000000000";

describe("redirect-back state mirror", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "window", { sessionStorage: createMockSessionStorage() });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (hadPreviousWindow) {
      Reflect.set(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("round-trips redirect-back state including the cross-domain handoff params", () => {
    const url = new URL("https://hosted.example.test/handler/sign-in");
    url.searchParams.set("after_auth_return_to", "https://app.example.test/handler/oauth-callback?hexclave_cross_domain_auth=1");
    url.searchParams.set("hexclave_cross_domain_state", "the-state");
    url.searchParams.set("hexclave_cross_domain_code_challenge", "the-code-challenge");
    url.searchParams.set("hexclave_cross_domain_after_callback_redirect_url", "https://app.example.test/dashboard");

    saveRedirectBackStateFromUrl({ url, projectId });

    expect(readRedirectBackState({ projectId })).toEqual({
      afterAuthReturnTo: "https://app.example.test/handler/oauth-callback?hexclave_cross_domain_auth=1",
      crossDomainState: "the-state",
      crossDomainCodeChallenge: "the-code-challenge",
      crossDomainAfterCallbackRedirectUrl: "https://app.example.test/dashboard",
      savedAtMillis: Date.now(),
    });
  });

  it("returns null when nothing was saved and does not save URLs without after_auth_return_to", () => {
    expect(readRedirectBackState({ projectId })).toBeNull();
    saveRedirectBackStateFromUrl({ url: new URL("https://hosted.example.test/handler/sign-in?foo=bar"), projectId });
    expect(readRedirectBackState({ projectId })).toBeNull();
  });

  it("expires the state after the TTL", () => {
    const url = new URL("https://hosted.example.test/handler/sign-in?after_auth_return_to=/music");
    saveRedirectBackStateFromUrl({ url, projectId });

    vi.advanceTimersByTime(29 * 60 * 1000);
    expect(readRedirectBackState({ projectId })).not.toBeNull();

    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(readRedirectBackState({ projectId })).toBeNull();
  });

  it("scopes the state per project", () => {
    const url = new URL("https://hosted.example.test/handler/sign-in?after_auth_return_to=/music");
    saveRedirectBackStateFromUrl({ url, projectId });
    expect(readRedirectBackState({ projectId: "11111111-1111-4111-8111-111111111111" })).toBeNull();
    expect(readRedirectBackState({ projectId })).not.toBeNull();
  });

  it("discards malformed stored values", () => {
    const storage = createMockSessionStorage();
    storage.setItem(`hexclave-redirect-back-state-${projectId}`, "{not json");
    Reflect.set(globalThis, "window", { sessionStorage: storage });
    expect(readRedirectBackState({ projectId })).toBeNull();

    storage.setItem(`hexclave-redirect-back-state-${projectId}`, JSON.stringify({ some: "other-shape" }));
    expect(readRedirectBackState({ projectId })).toBeNull();
  });

  it("restores dropped params onto a URL, but never overrides an explicit after_auth_return_to", () => {
    const arrivalUrl = new URL("https://hosted.example.test/handler/sign-in");
    arrivalUrl.searchParams.set("after_auth_return_to", "https://app.example.test/handler/oauth-callback");
    arrivalUrl.searchParams.set("hexclave_cross_domain_state", "the-state");
    arrivalUrl.searchParams.set("hexclave_cross_domain_code_challenge", "the-code-challenge");
    arrivalUrl.searchParams.set("hexclave_cross_domain_after_callback_redirect_url", "https://app.example.test/dashboard");
    saveRedirectBackStateFromUrl({ url: arrivalUrl, projectId });

    // Params were dropped along the way: restore all of them.
    const strippedUrl = new URL("https://hosted.example.test/handler/mfa");
    const augmented = augmentUrlWithPersistedRedirectBackState({ currentUrl: strippedUrl, projectId });
    expect(augmented.searchParams.get("after_auth_return_to")).toBe("https://app.example.test/handler/oauth-callback");
    expect(augmented.searchParams.get("hexclave_cross_domain_state")).toBe("the-state");
    expect(augmented.searchParams.get("hexclave_cross_domain_code_challenge")).toBe("the-code-challenge");
    expect(augmented.searchParams.get("hexclave_cross_domain_after_callback_redirect_url")).toBe("https://app.example.test/dashboard");
    // The input URL is not mutated.
    expect(strippedUrl.searchParams.has("after_auth_return_to")).toBe(false);

    // Explicit query params always win over the mirror.
    const explicitUrl = new URL("https://hosted.example.test/handler/sign-in?after_auth_return_to=/somewhere-else");
    const unchanged = augmentUrlWithPersistedRedirectBackState({ currentUrl: explicitUrl, projectId });
    expect(unchanged.toString()).toBe(explicitUrl.toString());
  });

  it("reads the explicit return target before persisted state", () => {
    saveRedirectBackStateFromUrl({
      url: new URL("https://hosted.example.test/handler/sign-in?after_auth_return_to=/persisted"),
      projectId,
    });

    expect(getRawAfterAuthReturnTo({
      currentUrl: new URL("https://hosted.example.test/handler/mfa?after_auth_return_to=/explicit"),
      projectId,
    })).toBe("/explicit");
    expect(getRawAfterAuthReturnTo({
      currentUrl: new URL("https://hosted.example.test/handler/mfa"),
      projectId,
    })).toBe("/persisted");
  });

  it("treats an explicitly empty return target as missing instead of reviving persisted state", () => {
    saveRedirectBackStateFromUrl({
      url: new URL("https://hosted.example.test/handler/sign-in?after_auth_return_to=/persisted"),
      projectId,
    });

    expect(getRawAfterAuthReturnTo({
      currentUrl: new URL("https://hosted.example.test/handler/mfa?after_auth_return_to=%20%20"),
      projectId,
    })).toBeNull();
  });

  it("leaves the URL unchanged when there is no mirrored state", () => {
    const url = new URL("https://hosted.example.test/handler/sign-in");
    const augmented = augmentUrlWithPersistedRedirectBackState({ currentUrl: url, projectId });
    expect(augmented.toString()).toBe(url.toString());
  });

  it("degrades to a no-op when sessionStorage is unavailable", () => {
    Reflect.set(globalThis, "window", {
      get sessionStorage(): Storage {
        throw new Error("Storage is disabled");
      },
    });
    const url = new URL("https://hosted.example.test/handler/sign-in?after_auth_return_to=/music");
    saveRedirectBackStateFromUrl({ url, projectId });
    expect(readRedirectBackState({ projectId })).toBeNull();
    expect(augmentUrlWithPersistedRedirectBackState({ currentUrl: url, projectId }).toString()).toBe(url.toString());
  });
});
