import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordRedirectAndThrowIfLoopDetected } from "./redirect-loop-breaker";

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

function record(from: string, to: string) {
  recordRedirectAndThrowIfLoopDetected({
    currentUrl: new URL(from),
    targetUrl: new URL(to),
  });
}

describe("recordRedirectAndThrowIfLoopDetected", () => {
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

  it("allows distinct redirects in quick succession", () => {
    for (let i = 0; i < 20; i++) {
      record(`https://app.example.test/page-${i}`, `https://app.example.test/page-${i + 1}`);
    }
  });

  it("throws once the same redirect repeats 5 times within the window", () => {
    for (let i = 0; i < 4; i++) {
      record("https://app.example.test/dashboard", "https://hosted.example.test/handler/sign-in");
      vi.advanceTimersByTime(1000);
    }
    expect(() => {
      record("https://app.example.test/dashboard", "https://hosted.example.test/handler/sign-in");
    }).toThrowError(/Redirect loop detected/);
  });

  it("treats redirects that differ only in query params or hash as identical", () => {
    // Real loops usually rotate nonce-style params (code, state, after_auth_return_to) each cycle.
    for (let i = 0; i < 4; i++) {
      record(
        `https://app.example.test/dashboard?code=code-${i}`,
        `https://hosted.example.test/handler/sign-in?state=state-${i}#frag-${i}`,
      );
    }
    expect(() => {
      record("https://app.example.test/dashboard?code=final", "https://hosted.example.test/handler/sign-in?state=final");
    }).toThrowError(/Redirect loop detected/);
  });

  it("does not throw when the identical redirects are spread out beyond the window", () => {
    for (let i = 0; i < 20; i++) {
      record("https://app.example.test/dashboard", "https://hosted.example.test/handler/sign-in");
      vi.advanceTimersByTime(31_000);
    }
  });

  it("allows the same redirect again after a loop was broken", () => {
    for (let i = 0; i < 4; i++) {
      record("https://app.example.test/dashboard", "https://hosted.example.test/handler/sign-in");
    }
    expect(() => {
      record("https://app.example.test/dashboard", "https://hosted.example.test/handler/sign-in");
    }).toThrowError(/Redirect loop detected/);
    // The breadcrumbs for the broken loop are dropped, so a manual retry isn't instantly blocked.
    record("https://app.example.test/dashboard", "https://hosted.example.test/handler/sign-in");
  });

  it("counts self-redirects (same origin and path) towards loops", () => {
    for (let i = 0; i < 4; i++) {
      record(`https://hosted.example.test/handler/sign-in?attempt=${i}`, "https://hosted.example.test/handler/sign-in");
    }
    expect(() => {
      record("https://hosted.example.test/handler/sign-in?attempt=final", "https://hosted.example.test/handler/sign-in");
    }).toThrowError(/Redirect loop detected/);
  });

  it("degrades to a no-op when sessionStorage is unavailable", () => {
    Reflect.set(globalThis, "window", {
      get sessionStorage(): Storage {
        throw new Error("Storage is disabled");
      },
    });
    for (let i = 0; i < 20; i++) {
      record("https://app.example.test/dashboard", "https://hosted.example.test/handler/sign-in");
    }
  });

  it("recovers from corrupted breadcrumb storage", () => {
    const storage = createMockSessionStorage();
    storage.setItem("hexclave-redirect-loop-breadcrumbs", "{not json");
    Reflect.set(globalThis, "window", { sessionStorage: storage });
    record("https://app.example.test/dashboard", "https://hosted.example.test/handler/sign-in");
    // After recovery, loop detection works again.
    for (let i = 0; i < 3; i++) {
      record("https://app.example.test/dashboard", "https://hosted.example.test/handler/sign-in");
    }
    expect(() => {
      record("https://app.example.test/dashboard", "https://hosted.example.test/handler/sign-in");
    }).toThrowError(/Redirect loop detected/);
  });
});
