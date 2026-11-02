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

  it("passes the requested limit through, and a dry run on its own", async () => {
    const received: unknown[] = [];
    const release = async (options: { maxBytes: number, dryRun: boolean }) => {
      received.push(options);
      return null;
    };
    await handleReleaseFreePagesRequest({ maxBytes: 1024 * 1024 }, release, "piledriver-breezylite");
    await handleReleaseFreePagesRequest({ dryRun: true }, release, "piledriver-breezylite");
    expect(received).toEqual([
      { maxBytes: 1024 * 1024, dryRun: false },
      { maxBytes: 1024 * 1024 * 1024, dryRun: true },
    ]);
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
    // Smaller than any SQLite page, so it could never release anything.
    [{ maxBytes: 100 }, "at least 1 MiB"],
    [{ maxBytes: 1024 * 1024 - 1 }, "at least 1 MiB"],
    // A dry run releases nothing, so a limit would be silently ignored.
    [{ dryRun: true, maxBytes: 1024 * 1024 }, "dryRun"],
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

  it.each([
    ["already-running", "A free page release is already running"],
    ["cannot-release", "This SQLite file was created without auto_vacuum=INCREMENTAL, so its free pages can't be released incrementally. Recreate the database directory to enable it."],
  ] as const)("turns a %s conflict into a 409 with a fixed message", async (reason, message) => {
    const result = await statusOf(handleReleaseFreePagesRequest({}, async () => {
      throw new FreePageReleaseConflictError(reason);
    }, "piledriver-breezylite"));
    expect(result).toEqual({ status: 409, message });
  });

  it("never sends the error's own message text to the client", async () => {
    const conflict = new FreePageReleaseConflictError("already-running");
    conflict.message = "internal detail: /var/lib/bulldozer/breezy.sqlite";
    const result = await statusOf(handleReleaseFreePagesRequest({}, async () => {
      throw conflict;
    }, "piledriver-breezylite"));
    expect(result.message).not.toContain("internal detail");
  });

  it("lets any other failure through unchanged, so the handler reports it as a server error", async () => {
    const failure = new Error("disk I/O error");
    await expect(handleReleaseFreePagesRequest({}, async () => {
      throw failure;
    }, "piledriver-breezylite")).rejects.toBe(failure);
  });
});
