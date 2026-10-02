import { describe, expect, it } from "vitest";
import { runRequestPipeline } from "./server/middleware";

describe("cross-tier telemetry boundary", () => {
  it("allows W3C trace headers and the native span-context header through API CORS", async () => {
    const result = await runRequestPipeline(new Request("http://localhost:8102/api/latest/users", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:8101",
        "access-control-request-headers": "traceparent, tracestate, baggage",
      },
    }));

    const allowHeaders = new Headers(result.corsHeadersInit).get("Access-Control-Allow-Headers")?.split(", ") ?? [];
    expect(allowHeaders).toEqual(expect.arrayContaining([
      "traceparent",
      "tracestate",
      "baggage",
    ]));
    expect(result.shortCircuitResponse?.status).toBe(200);
  });

  it("returns CORS headers for telemetry ingestion without a Next.js proxy", async () => {
    const result = await runRequestPipeline(new Request("http://localhost:8102/api/v1/analytics/events/batch", {
      method: "OPTIONS",
    }));

    const allowHeaders = new Headers(result.corsHeadersInit).get("Access-Control-Allow-Headers")?.split(", ") ?? [];
    expect(allowHeaders).toEqual(expect.arrayContaining([
      "traceparent",
      "tracestate",
      "x-hexclave-span-context",
    ]));
    expect(result.shortCircuitResponse?.status).toBe(200);
  });
});
