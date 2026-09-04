// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import IndependentTvPageClient, { getTvDisplayRequestHeaders, resolveTvDisplayApiBase } from "./page-client";

const fetchMock = vi.hoisted(() => vi.fn());
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
  configurable: true,
  value: true,
});

vi.mock("@/lib/env", () => ({
  getPublicEnvVar: () => "http://localhost:8102",
}));

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("independent TV display requests", () => {
  it("keeps the configured API origin when the Quick Tunnel opt-in is disabled", () => {
    expect(resolveTvDisplayApiBase({
      browserOrigin: "https://phase-one-box.trycloudflare.com",
      configuredApiUrl: "http://localhost:8102",
      configuredBrowserApiUrl: undefined,
      nodeEnvironment: "development",
      quickTunnelEnabled: false,
    })).toBe("http://localhost:8102");
  });

  it("uses the current browser origin only for an explicitly enabled development tunnel", () => {
    expect(resolveTvDisplayApiBase({
      browserOrigin: "https://phase-one-box.trycloudflare.com",
      configuredApiUrl: "http://localhost:8102",
      configuredBrowserApiUrl: undefined,
      nodeEnvironment: "development",
      quickTunnelEnabled: true,
    })).toBe("https://phase-one-box.trycloudflare.com");
  });

  it("refuses to use the Quick Tunnel client transport in production", () => {
    expect(() => resolveTvDisplayApiBase({
      browserOrigin: "https://phase-one-box.trycloudflare.com",
      configuredApiUrl: "https://api.hexclave.com",
      configuredBrowserApiUrl: undefined,
      nodeEnvironment: "production",
      quickTunnelEnabled: true,
    })).toThrowError(/cannot be used outside development/);
  });

  it("does not advertise JSON for a bodyless pairing or refresh request", () => {
    const headers = getTvDisplayRequestHeaders({ method: "POST" });
    expect(headers.has("content-type")).toBe(false);
  });

  it("advertises JSON when a request has a JSON body", () => {
    const headers = getTvDisplayRequestHeaders({
      method: "POST",
      body: JSON.stringify({ deviceSecret: "secret" }),
    });
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("keeps scheduling pairing restoration after consecutive refresh failures", async () => {
    fetchMock.mockRejectedValue(new Error("backend unavailable"));
    const root = createRoot(document.createElement("div"));

    await act(async () => {
      root.render(createElement(IndependentTvPageClient));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => root.unmount());
  });

  it("aborts a stalled refresh request on its own timeout", async () => {
    let refreshWasAborted = false;
    fetchMock.mockImplementationOnce(async (_input, init: RequestInit | undefined) => {
      const signal = init?.signal;
      if (signal == null) throw new Error("Refresh request did not receive an abort signal.");
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          refreshWasAborted = signal.aborted;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    });
    const root = createRoot(document.createElement("div"));

    await act(async () => {
      root.render(createElement(IndependentTvPageClient));
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_001);
    });

    expect(refreshWasAborted).toBe(true);
    await act(async () => root.unmount());
  });

  it("aborts a stalled pairing challenge independently after refresh", async () => {
    let challengeWasAborted = false;
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementationOnce(async (_input, init: RequestInit | undefined) => {
        const signal = init?.signal;
        if (signal == null) throw new Error("Challenge request did not receive an abort signal.");
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            challengeWasAborted = signal.aborted;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      });
    const root = createRoot(document.createElement("div"));

    await act(async () => {
      root.render(createElement(IndependentTvPageClient));
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_001);
    });

    expect(challengeWasAborted).toBe(true);
    await act(async () => root.unmount());
  });

  it("creates a pairing challenge independently after a credential is revoked", async () => {
    const challenge = {
      challengeId: "927dfeac-2e80-4311-8180-4879b687bfc0",
      pairingCode: "A2BC3DEF",
      deviceSecret: "display-secret-with-at-least-32-characters",
      expiresAt: "2026-08-19T01:00:00.000Z",
      pollingIntervalSeconds: 5,
    };
    const jsonResponse = (status: number, body?: unknown) => new Response(
      body == null ? null : JSON.stringify(body),
      {
        status,
        headers: body == null ? undefined : { "content-type": "application/json" },
      },
    );
    let snapshotSignal: AbortSignal | null | undefined;
    let recoveryChallengeSignal: AbortSignal | null | undefined;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: "initial-display-access-token" }))
      .mockImplementationOnce(async (_input, init: RequestInit | undefined) => {
        snapshotSignal = init?.signal;
        return jsonResponse(401);
      })
      .mockResolvedValueOnce(jsonResponse(401))
      .mockImplementationOnce(async (_input, init: RequestInit | undefined) => {
        recoveryChallengeSignal = init?.signal;
        return jsonResponse(200, challenge);
      })
      .mockReturnValueOnce(new Promise(() => {}));
    const root = createRoot(document.createElement("div"));

    await act(async () => {
      root.render(createElement(IndependentTvPageClient));
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[3]?.[0]).toBe("http://localhost:8102/api/latest/tv-displays/pairing-challenges");
    expect(recoveryChallengeSignal).not.toBeNull();
    expect(snapshotSignal).not.toBeNull();
    expect(recoveryChallengeSignal).not.toBe(snapshotSignal);

    await act(async () => root.unmount());
  });

  it("clears the presentation after a post-refresh authorization failure", async () => {
    const jsonResponse = (status: number, body?: unknown) => new Response(
      body == null ? null : JSON.stringify(body),
      {
        status,
        headers: body == null ? undefined : { "content-type": "application/json" },
      },
    );
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: "initial-display-access-token" }))
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: "refreshed-display-access-token" }))
      .mockResolvedValueOnce(jsonResponse(401));
    const container = document.createElement("div");
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(IndependentTvPageClient));
      for (let turn = 0; turn < 16; turn += 1) await Promise.resolve();
    });

    expect(container.textContent).toContain("TV Mode Authorization Required");
    await act(async () => root.unmount());
  });

  it("aborts a stalled pairing-status request and resumes polling", async () => {
    const challenge = {
      challengeId: "927dfeac-2e80-4311-8180-4879b687bfc0",
      pairingCode: "A2BC3DEF",
      deviceSecret: "display-secret-with-at-least-32-characters",
      expiresAt: "2099-08-19T01:00:00.000Z",
      pollingIntervalSeconds: 5,
    };
    const jsonResponse = (status: number, body?: unknown) => new Response(
      body == null ? null : JSON.stringify(body),
      {
        status,
        headers: body == null ? undefined : { "content-type": "application/json" },
      },
    );
    let firstStatusWasAborted = false;
    let statusRequests = 0;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(401))
      .mockResolvedValueOnce(jsonResponse(200, challenge))
      .mockImplementation(async (_input, init: RequestInit | undefined) => {
        statusRequests += 1;
        if (statusRequests > 1) {
          return jsonResponse(200, { status: "waiting", retryAfterSeconds: 5 });
        }
        const signal = init?.signal;
        if (signal == null) throw new Error("Pairing-status request did not receive an abort signal.");
        return await new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            firstStatusWasAborted = signal.aborted;
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      });
    const root = createRoot(document.createElement("div"));

    await act(async () => {
      root.render(createElement(IndependentTvPageClient));
      for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(firstStatusWasAborted).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await act(async () => root.unmount());
  });
});
