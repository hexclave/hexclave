import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../internal-tool-client", () => ({
  callInternalTool: vi.fn(),
}));

vi.mock("@hexclave/shared/dist/utils/errors", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  captureError: vi.fn(),
}));

import { captureError } from "@hexclave/shared/dist/utils/errors";
import { callInternalTool } from "../internal-tool-client";

// The module holds its cache in module-level state, so each test imports a
// fresh copy to start from an empty cache.
async function freshGetVerifiedQaContext() {
  vi.resetModules();
  const mod = await import("./verified-qa");
  return mod.getVerifiedQaContext;
}

describe("getVerifiedQaContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(callInternalTool).mockReset();
    vi.mocked(captureError).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches a successful fetch for the TTL", async () => {
    const getVerifiedQaContext = await freshGetVerifiedQaContext();
    vi.mocked(callInternalTool).mockResolvedValue({ context: "qa-block" });

    expect(await getVerifiedQaContext()).toBe("qa-block");
    expect(await getVerifiedQaContext()).toBe("qa-block");
    expect(callInternalTool).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    expect(await getVerifiedQaContext()).toBe("qa-block");
    expect(callInternalTool).toHaveBeenCalledTimes(2);
  });

  it("serves stale content on failure and re-arms the TTL instead of retrying every call", async () => {
    const getVerifiedQaContext = await freshGetVerifiedQaContext();
    vi.mocked(callInternalTool).mockResolvedValue({ context: "qa-block" });
    expect(await getVerifiedQaContext()).toBe("qa-block");

    vi.advanceTimersByTime(61_000);
    vi.mocked(callInternalTool).mockRejectedValue(new Error("internal tool down"));

    // First call past expiry hits the failing fetch, serves stale...
    expect(await getVerifiedQaContext()).toBe("qa-block");
    expect(callInternalTool).toHaveBeenCalledTimes(2);
    expect(captureError).toHaveBeenCalledWith("verified-qa", expect.any(Error));

    // ...and negative-caches it: calls within the re-armed TTL don't retry.
    expect(await getVerifiedQaContext()).toBe("qa-block");
    expect(callInternalTool).toHaveBeenCalledTimes(2);

    // After the re-armed TTL expires, it retries again.
    vi.advanceTimersByTime(61_000);
    expect(await getVerifiedQaContext()).toBe("qa-block");
    expect(callInternalTool).toHaveBeenCalledTimes(3);
  });

  it("negative-caches an empty value when there is no stale content yet", async () => {
    const getVerifiedQaContext = await freshGetVerifiedQaContext();
    vi.mocked(callInternalTool).mockRejectedValue(new Error("internal tool down"));

    expect(await getVerifiedQaContext()).toBe("");
    expect(await getVerifiedQaContext()).toBe("");
    expect(callInternalTool).toHaveBeenCalledTimes(1);
  });
});
