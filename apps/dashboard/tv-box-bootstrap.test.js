import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTvBoxDocument } from "./src/app/tv-box/document.ts";

let browser;
let navigationErrors;

function openBrowser(beforeParse = () => {}) {
  browser?.window.close();
  navigationErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => navigationErrors.push(error.message));
  // jsdom executes the inline watchdog but not external module scripts, matching
  // an HTML response whose entrypoint never initializes. Navigation is reported
  // through its virtual console rather than actually leaving the test document.
  browser = new JSDOM(createTvBoxDocument({
    mode: "live",
    api: { mode: "configured", apiBaseUrl: "https://api.example.com" },
  }), {
    url: "https://app.example.com/tv-box",
    runScripts: "dangerously",
    virtualConsole,
    beforeParse,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  openBrowser();
});

afterEach(() => {
  browser.window.close();
  vi.useRealTimers();
});

describe("TV Box document bootstrap recovery", () => {
  it("reloads a document when its external renderer has not initialized within the deadline", async () => {
    await vi.advanceTimersByTimeAsync(29_999);
    expect(navigationErrors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(navigationErrors).toEqual(["Not implemented: navigation (except hash changes)"]);
  });

  it("does not reload an initialized renderer even when its backend is unavailable", async () => {
    browser.window.dispatchEvent(new browser.window.Event("hexclave-tv-box-ready"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(navigationErrors).toEqual([]);
  });

  it("cancels bootstrap retries when the page is left", async () => {
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(navigationErrors).toEqual([]);
  });

  it("continues past three failed loads with a capped delay, then clears recovery on initialization", async () => {
    let previousCount = "0";
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      openBrowser((window) => {
        window.sessionStorage.setItem("hexclave-tv-box-bootstrap-reloads", previousCount);
      });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(navigationErrors).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(navigationErrors).toEqual(["Not implemented: navigation (except hash changes)"]);
      previousCount = browser.window.sessionStorage.getItem("hexclave-tv-box-bootstrap-reloads");
    }

    openBrowser((window) => {
      window.sessionStorage.setItem("hexclave-tv-box-bootstrap-reloads", previousCount);
    });
    browser.window.dispatchEvent(new browser.window.Event("hexclave-tv-box-ready"));
    expect(browser.window.sessionStorage.getItem("hexclave-tv-box-bootstrap-reloads")).toBeNull();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(navigationErrors).toEqual([]);
  });

  it("keeps a conservative retry when session storage cannot be accessed", async () => {
    openBrowser((window) => {
      Object.defineProperty(window, "sessionStorage", {
        get() { throw new window.DOMException("Storage is unavailable", "SecurityError"); },
      });
    });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(navigationErrors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(navigationErrors).toEqual(["Not implemented: navigation (except hash changes)"]);
  });

  it("still reloads if persisting the next retry count fails", async () => {
    openBrowser((window) => {
      window.Storage.prototype.setItem = () => {
        throw new window.DOMException("Storage is full", "QuotaExceededError");
      };
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(navigationErrors).toEqual(["Not implemented: navigation (except hash changes)"]);
  });

  it("stops retrying after initialization even if removing stored state fails", async () => {
    openBrowser((window) => {
      window.Storage.prototype.removeItem = () => {
        throw new window.DOMException("Storage is unavailable", "SecurityError");
      };
    });
    browser.window.dispatchEvent(new browser.window.Event("hexclave-tv-box-ready"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(navigationErrors).toEqual([]);
  });

  it.each(["garbage", "-1", "Infinity", "999999999999999999999", "2junk"])(
    "uses bounded recovery for invalid persisted counts (%s)", async (count) => {
      openBrowser((window) => {
        window.sessionStorage.setItem("hexclave-tv-box-bootstrap-reloads", count);
      });
      await vi.advanceTimersByTimeAsync(299_999);
      expect(navigationErrors).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(navigationErrors).toEqual(["Not implemented: navigation (except hash changes)"]);
    },
  );

  it("cancels the slow recovery timer when the page is left", async () => {
    openBrowser((window) => {
      window.sessionStorage.setItem("hexclave-tv-box-bootstrap-reloads", "4");
    });
    browser.window.dispatchEvent(new browser.window.Event("pagehide"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(navigationErrors).toEqual([]);
  });
});
