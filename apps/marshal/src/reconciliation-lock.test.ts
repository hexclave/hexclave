import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconciliationLease } from "./types.js";
import { MutationOutcomeUnknownError } from "./mutation-safety.js";

let stored: { value: ReconciliationLease, etag: string } | null = null;
let nextEtag = 1;
let loseCreateOnce = false;

vi.mock("./store.js", () => ({
  readReconciliationLease: vi.fn(async () => stored),
  createReconciliationLease: vi.fn(async (_ns: string, _key: string, lease: ReconciliationLease) => {
    if (stored !== null) return null;
    if (loseCreateOnce) {
      loseCreateOnce = false;
      stored = {
        value: { owner_id: "racer", expires_at_millis: Date.now() + 200 },
        etag: String(nextEtag++),
      };
      return null;
    }
    const etag = String(nextEtag++);
    stored = { value: lease, etag };
    return etag;
  }),
  replaceReconciliationLease: vi.fn(async (_ns: string, _key: string, lease: ReconciliationLease, previousEtag: string) => {
    if (stored?.etag !== previousEtag) return null;
    const etag = String(nextEtag++);
    stored = { value: lease, etag };
    return etag;
  }),
  releaseReconciliationLease: vi.fn(async (_ns: string, _key: string, etag: string) => {
    if (stored?.etag !== etag) return false;
    stored = null;
    return true;
  }),
}));

import { ReconciliationLeaseLostError, withReconciliationLease } from "./reconciliation-lock.js";
import { releaseReconciliationLease } from "./store.js";

describe("service reconciliation lease", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored = null;
    nextEtag = 1;
    loseCreateOnce = false;
  });

  it("serializes concurrent work for the same service", async () => {
    let releaseFirst: () => void = () => {
      throw new Error("first reconciliation release was not initialized");
    };
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const timings = { durationMs: 1000, renewIntervalMs: 500, contendedPollMs: 5, takeoverGraceMs: 10, acquireTimeoutMs: 5000 };

    const first = withReconciliationLease("ns", "web", async () => {
      events.push("first-start");
      await firstMayFinish;
      events.push("first-end");
    }, timings);
    await vi.waitFor(() => expect(events).toEqual(["first-start"]));

    const second = withReconciliationLease("ns", "web", async () => {
      events.push("second-start");
      events.push("second-end");
    }, timings);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("waits for the mutation drain period before taking over an expired lease", async () => {
    const takeoverGraceMs = 30;
    stored = {
      value: { owner_id: "expired-owner", expires_at_millis: Date.now() },
      etag: String(nextEtag++),
    };
    const startedAt = performance.now();
    await withReconciliationLease("ns", "web", async () => {}, {
      durationMs: 1000,
      renewIntervalMs: 500,
      contendedPollMs: 2,
      takeoverGraceMs,
      acquireTimeoutMs: 5000,
    });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(takeoverGraceMs - 5);
  });

  it("keeps the lease until expiry when a provider mutation outcome is unknown", async () => {
    const error = new MutationOutcomeUnknownError("unknown", { cause: new Error("socket closed") });
    await expect(withReconciliationLease("ns", "web", async () => {
      throw error;
    }, {
      durationMs: 1000,
      renewIntervalMs: 500,
      contendedPollMs: 2,
      takeoverGraceMs: 10,
      acquireTimeoutMs: 5000,
    })).rejects.toBe(error);

    expect(releaseReconciliationLease).not.toHaveBeenCalled();
    expect(stored?.value.owner_id).toBeDefined();
  });

  it("reports a lease it could not release as fencing, not as an internal fault", async () => {
    // A store whose conditional writes are not atomic (adobe/s3mock is one) lets
    // two owners hold the lease at once, and the first to finish finds a foreign
    // etag at release time. The action still succeeded, so this must fail the
    // request — but as a typed fencing error the HTTP layer answers 409 for,
    // rather than a bare Error that becomes an opaque 500.
    await expect(withReconciliationLease("ns", "web", async () => {
      stored = { value: { owner_id: "other-owner", expires_at_millis: Date.now() + 1000 }, etag: String(nextEtag++) };
      return "done";
    }, { durationMs: 1000, renewIntervalMs: 500, contendedPollMs: 2, takeoverGraceMs: 10, acquireTimeoutMs: 5000 }))
      .rejects.toThrow(ReconciliationLeaseLostError);
  });

  it("gives up on a lease a live owner keeps renewing, instead of polling forever", async () => {
    // A healthy owner renews before expiry, so the takeover branch never fires and the
    // acquire loop has nothing that would end it on its own. It must time out into the same
    // fencing error the HTTP layer answers 409 for, so the caller retries rather than hanging.
    stored = {
      value: { owner_id: "live-owner", expires_at_millis: Date.now() + 60_000 },
      etag: String(nextEtag++),
    };
    const promise = withReconciliationLease("ns", "web", async () => "never runs", {
      durationMs: 1000,
      renewIntervalMs: 500,
      contendedPollMs: 2,
      takeoverGraceMs: 10,
      acquireTimeoutMs: 30,
    });
    await expect(promise).rejects.toBeInstanceOf(ReconciliationLeaseLostError);
    await expect(promise).rejects.toThrow(/holder live-owner/);
  });

  it("logs when a contended lease is acquired after the owner expires", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stored = {
      value: { owner_id: "expiring-owner", expires_at_millis: Date.now() + 200 },
      etag: String(nextEtag++),
    };
    try {
      await withReconciliationLease("ns", "web", async () => {}, {
        durationMs: 1000,
        renewIntervalMs: 500,
        contendedPollMs: 2,
        takeoverGraceMs: 0,
        acquireTimeoutMs: 2000,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/contended/));
      expect(warn.mock.calls.some(([message]) => typeof message === "string" && /acquired .* after \d+ms/.test(message))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs when a conditional lease create is lost before acquisition", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loseCreateOnce = true;
    try {
      await withReconciliationLease("ns", "web", async () => {}, {
        durationMs: 1000,
        renewIntervalMs: 500,
        contendedPollMs: 2,
        takeoverGraceMs: 0,
        acquireTimeoutMs: 2000,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/lost conditional lease write/));
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/contended .* holder racer/));
      expect(warn.mock.calls.some(([message]) => typeof message === "string" && /acquired .* after \d+ms/.test(message))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
