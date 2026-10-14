import { KnownErrors } from "@hexclave/shared";
import { Result } from "@hexclave/shared/dist/utils/results";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HexclaveClientApp, HexclaveClientAppConstructorOptions } from "../interfaces/client-app";

const baseOptions = {
  baseUrl: "http://localhost:12345",
  projectId: "00000000-0000-4000-8000-000000000000",
  publishableClientKey: "stack-pk-test",
  tokenStore: "memory",
  redirectMethod: "none",
  noAutomaticPrefetch: true,
} satisfies HexclaveClientAppConstructorOptions<true, string>;

const analyticsAppDisabledMessage = "initAnalytics() was called, but the Analytics app is not enabled on this Hexclave project";

// The backend's AnalyticsNotEnabled rejection only reaches the client through the event tracker's and session
// recorder's upload callbacks, which only exist in a browser; this simulates such a rejection arriving.
function simulateAnalyticsUploadResult(app: HexclaveClientApp, result: Result<Response, Error>) {
  const handler: unknown = Reflect.get(app, "_handleAnalyticsUploadResult");
  if (typeof handler !== "function") {
    throw new Error("Expected HexclaveClientApp to have a _handleAnalyticsUploadResult method");
  }
  handler.call(app, result);
}

describe("HexclaveClientApp.initAnalytics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not throw when analytics are configured", () => {
    const app = new HexclaveClientApp(baseOptions);
    expect(() => app.initAnalytics()).not.toThrow();
  });

  it("throws when analytics are disabled with the analytics option", () => {
    const app = new HexclaveClientApp({ ...baseOptions, analytics: { enabled: false } });
    expect(() => app.initAnalytics()).toThrow("`analytics.enabled` constructor option is set to false");
  });

  it("does not throw when only session replays are disabled", () => {
    const app = new HexclaveClientApp({ ...baseOptions, analytics: { replays: { enabled: false } } });
    expect(() => app.initAnalytics()).not.toThrow();
  });

  it("reports an error when the backend rejects uploads after initAnalytics() was called", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new HexclaveClientApp(baseOptions);
    app.initAnalytics();

    simulateAnalyticsUploadResult(app, Result.error(new KnownErrors.AnalyticsNotEnabled()));
    // Repeated rejections must not report the error again.
    simulateAnalyticsUploadResult(app, Result.error(new KnownErrors.AnalyticsNotEnabled()));

    const reports = consoleError.mock.calls.filter((args) => args.some((arg) => String(arg).includes(analyticsAppDisabledMessage)));
    expect(reports).toHaveLength(1);
  });

  it("throws from initAnalytics() when the backend already rejected uploads before it was called", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = new HexclaveClientApp(baseOptions);

    simulateAnalyticsUploadResult(app, Result.error(new KnownErrors.AnalyticsNotEnabled()));
    expect(consoleError.mock.calls.some((args) => args.some((arg) => String(arg).includes(analyticsAppDisabledMessage)))).toBe(false);

    expect(() => app.initAnalytics()).toThrow(analyticsAppDisabledMessage);
  });

  it("ignores upload failures unrelated to the Analytics app being disabled", () => {
    const app = new HexclaveClientApp(baseOptions);
    simulateAnalyticsUploadResult(app, Result.error(new Error("network error")));
    expect(() => app.initAnalytics()).not.toThrow();
  });
});
