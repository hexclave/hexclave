import type { Instrumentation } from "@opentelemetry/instrumentation";
import type { RequestLike } from "../../common";
import type { ManagedOtelRegistration } from "./otel-managed";
import type { ServerLifecycleHandle, ServerLifecycleInstallOptions } from "./server-lifecycle";

export type ServerAppInstrumentation = {
  ensureOpenTelemetryProvider: () => void,
  installServerErrorMonitor: () => void,
  installServerLifecycle: (options?: Omit<ServerLifecycleInstallOptions, "ownerKey" | "capture" | "flush">) => ServerLifecycleHandle | null,
  uninstallErrorIntegrations: () => void,
  setTelemetrySuppressionPredicate: (predicate: (() => boolean) | null) => void,
  runWithTelemetrySuppressed: <T>(fn: () => Promise<T>) => Promise<T>,
  captureServerRequestError: (error: unknown, info: { mechanism: string, handled: boolean, request?: RequestLike, data?: Record<string, unknown> }) => Promise<void>,
  /**
   * Registers the framework's ambient request provider: a function that
   * returns the current request's RequestLike when called inside a request
   * scope (null outside one — that is a normal state, not an error). Once
   * registered, bare `trackEvent` / `withSpan` / logger calls with no explicit
   * `{ request }` attribute to the ambient request automatically. Single slot,
   * replace semantics; pass null to unregister.
   */
  setAmbientRequestProvider: (provider: (() => Promise<RequestLike | null>) | null) => void,
  /** Registers the real OTel Node SDK and authenticated Hexclave exporter. */
  registerOpenTelemetry: (instrumentations: Instrumentation[]) => Promise<ManagedOtelRegistration | null>,
};

/**
 * A global symbol keeps the internal facade recognizable when a framework
 * bundle and `<package>/otel` load different ESM/CJS copies of the SDK.
 */
export const serverAppInstrumentationSymbol = Symbol.for("hexclave.server-app.instrumentation.v1");

type ServerAppInstrumentationProvider = () => ServerAppInstrumentation;

function isServerAppInstrumentationProvider(value: unknown): value is ServerAppInstrumentationProvider {
  // The symbol is an SDK-internal contract; the function signature is owned
  // by the matching server-app implementation on the other side of it.
  return typeof value === "function";
}

/**
 * SDK-internal accessor for framework instrumentation hooks. Keeping this
 * lookup in a leaf module lets the Node-only `/otel` entrypoint access a real
 * server app without pulling the full server-app/React framework graph into
 * native Node ESM. Structural mocks do not carry the private symbol and are
 * rejected with null so callers can fail loud with their own message.
 */
export function getServerAppInstrumentation(app: unknown): ServerAppInstrumentation | null {
  if ((typeof app !== "object" && typeof app !== "function") || app === null) return null;
  const provider: unknown = Reflect.get(app, serverAppInstrumentationSymbol);
  if (!isServerAppInstrumentationProvider(provider)) return null;
  return provider.call(app);
}
