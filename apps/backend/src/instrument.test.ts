import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => true),
  flush: vi.fn(async () => {}),
  setTelemetrySuppressionPredicate: vi.fn(),
  getHexclaveServerApp: vi.fn(),
  initPerfStats: vi.fn(),
  disableBackendInstrumentations: vi.fn(),
  prismaInstrumentation: vi.fn(),
  registerInstrumentations: vi.fn(),
  registerNodeTelemetrySuppressionRunner: vi.fn(),
  sentryInit: vi.fn(),
}));

mocks.getHexclaveServerApp.mockReturnValue({
  flush: mocks.flush,
  _setTelemetrySuppressionPredicate: mocks.setTelemetrySuppressionPredicate,
});
mocks.registerInstrumentations.mockReturnValue(mocks.disableBackendInstrumentations);

vi.mock("@hexclave/shared/dist/utils/env", () => ({
  getEnvVariable: (_name: string, fallback?: string) => fallback ?? "",
  getNodeEnvironment: () => "test",
}));
vi.mock("@hexclave/shared/dist/utils/sentry", () => ({
  sentryBaseConfig: {
    debug: false,
    ignoreErrors: [],
    maxValueLength: 1_000,
    normalizeDepth: 3,
    tracesSampleRate: 0,
  },
}));
vi.mock("@sentry/node", () => ({
  close: mocks.close,
  init: mocks.sentryInit,
}));
vi.mock("@opentelemetry/instrumentation", () => ({
  registerInstrumentations: mocks.registerInstrumentations,
}));
vi.mock("@prisma/instrumentation", () => ({
  PrismaInstrumentation: mocks.prismaInstrumentation,
}));
vi.mock("./hexclave", () => ({
  getHexclaveServerApp: mocks.getHexclaveServerApp,
}));
vi.mock("./lib/dev-perf-stats", () => ({ initPerfStats: mocks.initPerfStats }));
vi.mock("./lib/node-telemetry-suppression", () => ({
  isNodeTelemetrySuppressed: () => false,
  registerNodeTelemetrySuppressionRunner: mocks.registerNodeTelemetrySuppressionRunner,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.getHexclaveServerApp.mockReturnValue({
    flush: mocks.flush,
    _setTelemetrySuppressionPredicate: mocks.setTelemetrySuppressionPredicate,
  });
  mocks.registerInstrumentations.mockReturnValue(mocks.disableBackendInstrumentations);
  mocks.close.mockResolvedValue(true);
});

it("installs the Hexclave SDK provider before the optional Sentry sink", async () => {
  await import("./instrument");

  expect(mocks.getHexclaveServerApp).toHaveBeenCalledOnce();
  expect(mocks.sentryInit).toHaveBeenCalledOnce();
  expect(mocks.getHexclaveServerApp.mock.invocationCallOrder[0])
    .toBeLessThan(mocks.sentryInit.mock.invocationCallOrder[0] ?? 0);
  expect(mocks.registerInstrumentations.mock.invocationCallOrder[0])
    .toBeLessThan(mocks.sentryInit.mock.invocationCallOrder[0] ?? 0);
  expect(mocks.setTelemetrySuppressionPredicate).toHaveBeenCalledWith(expect.any(Function));
  expect(mocks.registerNodeTelemetrySuppressionRunner)
    .toHaveBeenCalledWith(expect.any(Function));
});

it("registers Prisma against the Hexclave-owned provider", async () => {
  await import("./instrument");

  expect(mocks.prismaInstrumentation).toHaveBeenCalledOnce();
  expect(mocks.registerInstrumentations).toHaveBeenCalledWith({
    instrumentations: [expect.any(mocks.prismaInstrumentation)],
  });
});

it("prevents Sentry from owning backend OpenTelemetry", async () => {
  await import("./instrument");

  expect(mocks.sentryInit).toHaveBeenCalledWith(expect.objectContaining({
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 0,
  }));
  expect(mocks.sentryInit.mock.calls[0]?.[0]).not.toHaveProperty("openTelemetrySpanProcessors");
});

it("flushes the Hexclave SDK during graceful shutdown", async () => {
  const { closeBackendInstrumentation } = await import("./instrument");

  await closeBackendInstrumentation(1_234);

  expect(mocks.flush).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledWith(1_234);
  expect(mocks.disableBackendInstrumentations).toHaveBeenCalledOnce();
});
