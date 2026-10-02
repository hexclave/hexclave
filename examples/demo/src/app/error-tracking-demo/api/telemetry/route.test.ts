import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => {
  const databaseSpan = {
    setData: vi.fn(async (_data: unknown): Promise<void> => {}),
  };
  const cacheSpan = {
    trackEvent: vi.fn(async (_type: string, _data: unknown): Promise<void> => {}),
    end: vi.fn(async (): Promise<void> => {}),
  };
  const requestSpan = {
    traceId: "demo-trace-id",
    spanId: "demo-span-id",
    spanType: "server",
    trackEvent: vi.fn(async (_type: string, _data: unknown): Promise<void> => {}),
    setData: vi.fn(async (_data: unknown): Promise<void> => {}),
    withSpan: vi.fn(async (
      _name: string,
      _options: unknown,
      callback: (span: typeof databaseSpan) => Promise<unknown>,
    ): Promise<unknown> => await callback(databaseSpan)),
  };
  const app = {
    withSpan: vi.fn(async (
      _name: string,
      _options: unknown,
      callback: (span: typeof requestSpan) => Promise<unknown>,
    ): Promise<unknown> => await callback(requestSpan)),
    startSpan: vi.fn(() => cacheSpan),
    trackEvent: vi.fn(async (_type: string, _data: unknown, _options: unknown): Promise<void> => {}),
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    captureException: vi.fn(),
  };

  return { app, cacheSpan, requestSpan };
});

vi.mock("../../../../hexclave", () => ({
  hexclaveServerApp: mocks.app,
}));

describe("observability demo telemetry route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the successful cross-tier flow as a non-cacheable POST", async () => {
    const response = await POST(new Request("http://demo.test/error-tracking-demo/api/telemetry?delay=0"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      traceId: "demo-trace-id",
      spanId: "demo-span-id",
      spanType: "server",
    });
    expect(mocks.app.withSpan).toHaveBeenCalledWith(
      "demo.http.request",
      expect.objectContaining({
        data: expect.objectContaining({ method: "POST" }),
      }),
      expect.any(Function),
    );
    expect(mocks.cacheSpan.end).toHaveBeenCalledOnce();
  });

  it("captures and returns the manual failure without allowing cache reuse", async () => {
    const response = await POST(new Request("http://demo.test/error-tracking-demo/api/telemetry?failure=1"));

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      traceId: "demo-trace-id",
      spanId: "demo-span-id",
    });
    expect(mocks.app.captureException).toHaveBeenCalledOnce();
  });
});
