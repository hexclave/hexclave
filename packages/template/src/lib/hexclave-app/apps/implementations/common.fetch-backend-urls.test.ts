import { setGlobal } from "@hexclave/shared/dist/utils/globals";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveApiUrls } from "./common";

describe("resolveApiUrls background discovery", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setGlobal("__stack-fetch-backend-urls-started", undefined);
    setGlobal("__stack-fetched-backend-urls", undefined);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("does not recurse when the discovery fetch itself resolves API URLs (instrumented-fetch shape)", () => {
    const getApiUrls = resolveApiUrls(undefined);
    let fetchCalls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      getApiUrls();
      return Promise.resolve(new Response("{}", { status: 500 }));
    }) as typeof fetch;

    const urls = getApiUrls();
    expect(urls.length).toBeGreaterThan(0);
    expect(fetchCalls).toBe(1);
  });

  it("only starts one discovery fetch across repeated calls", () => {
    const getApiUrls = resolveApiUrls(undefined);
    let fetchCalls = 0;
    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return Promise.resolve(new Response("{}", { status: 500 }));
    }) as typeof fetch;

    getApiUrls();
    getApiUrls();
    getApiUrls();
    expect(fetchCalls).toBe(1);
  });
});
