import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTvBoxDocument } from "./src/app/tv-box/document.ts";

let browser;
let navigationErrors;

beforeEach(() => {
  vi.useFakeTimers();
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
  });
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
});
