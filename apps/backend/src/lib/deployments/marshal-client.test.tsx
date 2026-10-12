/* eslint-disable no-restricted-syntax -- this test must manipulate process.env
   directly to exercise the env-var handling that getEnvVariable() wraps. */
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarshalApiError, MarshalClient, getMarshalClientOrThrow, getMarshalDeploymentsConfigOrNull } from "./marshal-client";

// The env-var handling can't be covered by e2e tests (the dev backend always
// has the mock credentials set), so the unconfigured-instance path is unit
// tested here instead.
describe("marshal deployments configuration", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["HEXCLAVE_MARSHAL_API_KEY", "HEXCLAVE_MARSHAL_URL", "STACK_MARSHAL_API_KEY", "STACK_MARSHAL_URL"];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it("returns null when the instance has no Marshal credentials", () => {
    expect(getMarshalDeploymentsConfigOrNull()).toBeNull();
  });

  it("returns null when a real key is set without a base URL", () => {
    // Unlike the mock key (which derives the local dev port), a real
    // credential has no sensible default URL — the operator must say where
    // Marshal runs.
    process.env.HEXCLAVE_MARSHAL_API_KEY = "some-real-key";
    expect(getMarshalDeploymentsConfigOrNull()).toBeNull();
  });

  it("throws a clean 400 (never a 5xx) when unconfigured", () => {
    let thrown: unknown;
    try {
      getMarshalClientOrThrow();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(StatusError);
    expect((thrown as StatusError).statusCode).toBe(400);
    expect((thrown as StatusError).message).toMatchInlineSnapshot(`"Deploy is not configured on this Hexclave instance. Configure HEXCLAVE_MARSHAL_API_KEY (and HEXCLAVE_MARSHAL_URL if Marshal is not on the default local port) first."`);
  });

  it("uses the configured URL for real keys and the local dev port for the mock key", () => {
    process.env.HEXCLAVE_MARSHAL_API_KEY = "some-real-key";
    process.env.HEXCLAVE_MARSHAL_URL = "https://marshal.example.com/";
    expect(getMarshalDeploymentsConfigOrNull()).toEqual({
      apiKey: "some-real-key",
      baseUrl: "https://marshal.example.com",
    });

    delete process.env.HEXCLAVE_MARSHAL_URL;
    process.env.HEXCLAVE_MARSHAL_API_KEY = "mock_hexclave_marshal_key";
    const mockConfig = getMarshalDeploymentsConfigOrNull();
    expect(mockConfig?.baseUrl).toMatch(/^http:\/\/localhost:\d+$/);

    process.env.HEXCLAVE_MARSHAL_URL = "http://localhost:9999";
    expect(getMarshalDeploymentsConfigOrNull()?.baseUrl).toBe("http://localhost:9999");
  });
});

describe("MarshalClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes a timeout while consuming the response body", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new DOMException("The response body timed out", "TimeoutError"));
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    const client = new MarshalClient({ apiKey: "test-key", baseUrl: "https://marshal.example.com" });

    let thrown: unknown;
    try {
      await client.getService("test-namespace", "test-service");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MarshalApiError);
    expect(thrown).toMatchObject({
      status: 504,
      code: "timeout",
      endpoint: "GET /v1/namespaces/test-namespace/services/test-service",
    });
  });

  it("gives starting a deployment far longer than the default request tier", async () => {
    // REGRESSION. This ran on the 60s default and 504'd on a 30 MB source while
    // the runtime carried on — creating a deployment, a Fly app and a builder
    // machine that the caller had no id for. It validates the archive out of the
    // bucket, calls ensureApp once per target in sequence, and starts the
    // builder before it answers, so it belongs with the apply tier, not the
    // default one. Asserted through the AbortSignal the request actually
    // carries, since that is what enforces it.
    const timeouts: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      timeouts.push(ms);
      return new AbortController().signal;
    });
    // A fresh Response per call: a body can only be read once.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    const client = new MarshalClient({ apiKey: "test-key", baseUrl: "https://marshal.example.com" });

    await client.startSourceDeployment("test-namespace", "test-source", { targets: [], order: [], runtime: "gcp" });
    await client.startSourceDeployment("test-namespace", "test-source", { targets: [], order: [], runtime: "fly" });
    await client.getService("test-namespace", "test-service");

    const [deployStartMs, flyDeployStartMs, defaultMs] = timeouts;
    expect(deployStartMs).toBeGreaterThan(defaultMs);
    expect(flyDeployStartMs).toBeGreaterThan(defaultMs);
    // A first GCP deploy into a namespace may provision a tenant project synchronously when
    // the pool is empty; a Fly deploy has nothing of the kind and keeps the shorter budget.
    expect(deployStartMs).toBe(13 * 60 * 1000);
    expect(flyDeployStartMs).toBe(5 * 60 * 1000);
    // And under the 800s maxDuration both services declare to Vercel, so this
    // timeout fires first and the caller gets a 504 with a body rather than a
    // platform-killed invocation. Sized for the first deploy into a namespace when
    // Marshal's project pool is empty: project creation + billing propagation + API
    // enablement can exceed five minutes before the runtime even sees the archive.
    expect(deployStartMs).toBeLessThan(800 * 1000);
  });
});
