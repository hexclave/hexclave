import { describe, expect, it, vi } from "vitest";
import { serverAppInstrumentationSymbol, type ServerAppInstrumentation } from "../lib/hexclave-app/apps/implementations/server-app-instrumentation";

vi.mock("../lib/hexclave-app/apps/implementations/server-app-impl", () => {
  throw new Error("The Node-only /otel entrypoint must not load the server app implementation");
});

import { captureHexclaveServerRequestError } from "./otel";

describe("Node OTel integration entrypoint", () => {
  it("captures through the cycle-free server instrumentation facade", async () => {
    const captureServerRequestError: ServerAppInstrumentation["captureServerRequestError"] = vi.fn(async () => {});
    const instrumentation: ServerAppInstrumentation = {
      ensureOpenTelemetryProvider: () => {},
      installServerErrorMonitor: () => {},
      installServerLifecycle: () => null,
      uninstallErrorIntegrations: () => {},
      setTelemetrySuppressionPredicate: () => {},
      runWithTelemetrySuppressed: async (fn) => await fn(),
      captureServerRequestError,
      setAmbientRequestProvider: () => {},
      registerOpenTelemetry: async () => null,
    };
    const app = {
      [serverAppInstrumentationSymbol]: () => instrumentation,
    };
    const error = new Error("request failed");
    const request = new Request("http://localhost/api/orders");
    const info = {
      mechanism: "test.adapter",
      handled: false,
      request,
      data: { request_id: "request-1" },
    };

    await captureHexclaveServerRequestError(app, error, info);

    expect(captureServerRequestError).toHaveBeenCalledWith(error, info);
  });

  it("rejects structural apps without the internal facade", async () => {
    await expect(captureHexclaveServerRequestError({}, new Error("request failed"), {
      mechanism: "test.adapter",
      handled: false,
      request: new Request("http://localhost/api/orders"),
    })).rejects.toThrow("requires a StackServerApp instance");
  });
});
