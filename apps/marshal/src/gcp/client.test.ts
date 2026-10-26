import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationOutcomeUnknownError, PROVIDER_MUTATION_TIMEOUT_MS } from "../mutation-safety.js";

vi.mock("./auth.js", () => ({ googleAccessToken: async () => "test-access-token" }));

import { GcpApiError, GcpClient, parseGcpOperation } from "./client.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Google Cloud API transport", () => {
  it("routes mock mode through the local simulator with its isolated token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ projects: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new GcpClient({ url: "http://127.0.0.1:18148", token: "mock-token" })
      .request("https://cloudresourcemanager.googleapis.com/v3/projects:search?query=id%3Atenant");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18148/googleapis/cloudresourcemanager.googleapis.com/v3/projects:search?query=id%3Atenant",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer mock-token" }) }),
    );
  });

  it("fences a mutation whose response outcome is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("connection reset");
    }));
    await expect(new GcpClient().request("https://run.googleapis.com/v2/projects/tenant/services/web?updateMask=*", {
      method: "PATCH",
      body: { name: "web" },
    })).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
  });

  it("bounds a hung mutation before reconciliation takeover is allowed", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })));

    const request = new GcpClient().request("https://run.googleapis.com/v2/projects/tenant/services/web", {
      method: "PATCH",
      body: { name: "web" },
    });
    const rejection = expect(request).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
  });

  it("bounds a mutation whose body never arrives after its headers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => new Response(
      // Headers land immediately; the body never does. Before the read was moved inside the
      // deadline this hung forever, holding the caller's reconciliation lease with it.
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      }),
      { status: 200 },
    )));

    const request = new GcpClient().request("https://run.googleapis.com/v2/projects/tenant/services/web", {
      method: "PATCH",
      body: { name: "web" },
    });
    const rejection = expect(request).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
    await vi.advanceTimersByTimeAsync(PROVIDER_MUTATION_TIMEOUT_MS);
    await rejection;
  });

  it("fences a mutation whose body read fails after it was dispatched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset while reading the body"));
        },
      }),
      { status: 200 },
    )));

    // The provider may well have applied this; recording it as a definite failure is the one
    // outcome the mutation fence exists to prevent.
    await expect(new GcpClient().request("https://run.googleapis.com/v2/projects/tenant/services/web", {
      method: "PATCH",
      body: { name: "web" },
    })).rejects.toBeInstanceOf(MutationOutcomeUnknownError);
  });

  it("does not discard an immediately failed long-running operation", async () => {
    const client = new GcpClient();
    await expect(client.waitForOperation(parseGcpOperation({
      name: "operations/failed",
      done: true,
      error: { code: 7, message: "permission denied" },
    }))).rejects.toMatchObject({ status: 7, providerMessage: "permission denied" });
  });

  it("never sends Google credentials to a non-Google origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new GcpClient().request("https://attacker.example/capture")).rejects.toThrow("untrusted API origin");
    await expect(new GcpClient().request("http://compute.googleapis.com/capture")).rejects.toThrow("untrusted API origin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects absolute or traversing persisted operation names before polling", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new GcpClient();
    await expect(client.pollOperation("https://attacker.example/capture", { apiBaseUrl: "https://serviceusage.googleapis.com/v1/" }))
      .rejects.toThrow("invalid operation name");
    await expect(client.pollOperation("../capture", { apiBaseUrl: "https://serviceusage.googleapis.com/v1/" }))
      .rejects.toThrow("invalid operation name");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves provider detail for server logs while normalizing the endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { message: "permission denied for an internal tenant resource" },
    }), { status: 403 })));
    const error = await new GcpClient().request("https://run.googleapis.com/v2/projects/tenant/services/web?view=FULL")
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(GcpApiError);
    expect(error).toMatchObject({ status: 403, endpoint: "/v2/projects/tenant/services/web" });
    expect(String(error)).toContain("permission denied");
    expect(String(error)).not.toContain("view=FULL");
  });

  it("retries the explicit newly-enabled API propagation response", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Compute Engine API has not been used in project tenant before or it is disabled. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry." },
      }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "DONE" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = new GcpClient().request("https://compute.googleapis.com/compute/v1/projects/tenant/global/operations/operation-1");
    await vi.advanceTimersByTimeAsync(1000);

    await expect(resultPromise).resolves.toEqual({ status: "DONE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("carries the google.rpc detail types so callers can tell reasons apart", async () => {
    // This is the shape Cloud Billing returns for an exhausted billing-account quota.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: 400,
        message: "Precondition check failed.",
        status: "FAILED_PRECONDITION",
        details: [{
          "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ subject: "billingAccounts/000000-111111-222222", description: "Cloud billing quota exceeded" }],
        }],
      },
    }), { status: 400 })));

    const error = await new GcpClient()
      .request("https://cloudbilling.googleapis.com/v1/projects/tenant/billingInfo", { method: "PUT", body: {} })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GcpApiError);
    expect((error as GcpApiError).providerDetailTypes).toEqual(["google.rpc.QuotaFailure"]);
  });

  it("reports no detail types when Google elaborates nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: 400, message: "Precondition check failed.", status: "FAILED_PRECONDITION" },
    }), { status: 400 })));

    const error = await new GcpClient()
      .request("https://cloudbilling.googleapis.com/v1/projects/tenant/billingInfo", { method: "PUT", body: {} })
      .catch((caught: unknown) => caught);

    expect((error as GcpApiError).providerDetailTypes).toEqual([]);
  });
});
