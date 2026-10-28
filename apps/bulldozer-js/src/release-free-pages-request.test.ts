import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { describe, expect, it } from "vitest";
import { FreePageReleaseConflictError } from "./databases/piledriver/implementations/breezy/core.js";
import { defaultReleaseFreePagesMaxBytes, handleReleaseFreePagesRequest } from "./release-free-pages-request.js";

const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (!StatusError.isStatusError(error)) throw error;
    return { status: error.getStatusCode(), message: error.message };
  }
  throw new Error("Expected the request to fail with a status error");
};

describe("POST /internal/piledriver-release-free-pages", () => {
  it("passes defaults when the body is empty or omitted", async () => {
    const received: unknown[] = [];
    const release = async (options: { maxBytes: number, dryRun: boolean }) => {
      received.push(options);
      return "result";
    };
    expect(await handleReleaseFreePagesRequest(undefined, release, "piledriver-breezylite")).toBe("result");
    expect(await handleReleaseFreePagesRequest({}, release, "piledriver-breezylite")).toBe("result");
    expect(received).toEqual([
      { maxBytes: 1024 * 1024 * 1024, dryRun: false },
      { maxBytes: 1024 * 1024 * 1024, dryRun: false },
    ]);
    expect(defaultReleaseFreePagesMaxBytes).toBe(1024 * 1024 * 1024);
  });

  it("passes the requested limit and dry run through", async () => {
    let received: unknown = null;
    await handleReleaseFreePagesRequest({ maxBytes: 4096, dryRun: true }, async options => {
      received = options;
      return null;
    }, "piledriver-breezylite");
    expect(received).toEqual({ maxBytes: 4096, dryRun: true });
  });

  it.each([
    [[], "Expected JSON object body"],
    ["{}", "Expected JSON object body"],
    [{ maxBytes: 0 }, "maxBytes"],
    [{ maxBytes: -1 }, "maxBytes"],
    [{ maxBytes: 1.5 }, "maxBytes"],
    [{ maxBytes: "1024" }, "maxBytes"],
    [{ maxBytes: null }, "maxBytes"],
    [{ dryRun: "yes" }, "dryRun"],
    [{ dryRun: null }, "dryRun"],
  ])("rejects bad body %j with a 400 naming the problem", async (body, expectedMessage) => {
    const result = await statusOf(handleReleaseFreePagesRequest(body, async () => {
      throw new Error("must not run on a bad request");
    }, "piledriver-breezylite"));
    expect(result.status).toBe(400);
    expect(result.message).toContain(expectedMessage);
  });

  it("rejects with a 400 naming the backend when it can't release free pages", async () => {
    const result = await statusOf(handleReleaseFreePagesRequest({}, null, "base"));
    expect(result).toEqual({ status: 400, message: "Releasing free pages is only supported on the breezylite backend (current: base)" });
  });

  it("turns a release that can't run now into a 409 with its message", async () => {
    const result = await statusOf(handleReleaseFreePagesRequest({}, async () => {
      throw new FreePageReleaseConflictError("A free page release is already running");
    }, "piledriver-breezylite"));
    expect(result).toEqual({ status: 409, message: "A free page release is already running" });
  });

  it("lets any other failure through unchanged, so the handler reports it as a server error", async () => {
    const failure = new Error("disk I/O error");
    await expect(handleReleaseFreePagesRequest({}, async () => {
      throw failure;
    }, "piledriver-breezylite")).rejects.toBe(failure);
  });
});
