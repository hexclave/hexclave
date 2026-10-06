import * as Sentry from "@sentry/nextjs";
import type { HexclaveNextInstrumentation } from "@hexclave/next/next";
import { getEnvBoolean, getEnvVariable, getNextRuntime, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { sentryBaseConfig } from "@hexclave/shared/dist/utils/sentry";
import { nicify } from "@hexclave/shared/dist/utils/strings";
import "./polyfills";

let hexclaveNextInstrumentationPromise: Promise<HexclaveNextInstrumentation | null> | undefined;
function getHexclaveNextInstrumentation(): Promise<HexclaveNextInstrumentation | null> {
  hexclaveNextInstrumentationPromise ??= (async () => {
    if (process.env.NEXT_RUNTIME !== "nodejs") return null;
    const { isRemoteDevelopmentEnvironmentEnabled } = await import("./lib/remote-development-environment/env");
    if (isRemoteDevelopmentEnvironmentEnabled()) return null;
    const [{ hexclaveInstrumentation }, { getHexclaveServerApp }] = await Promise.all([
      import("@hexclave/next/next"),
      import("./hexclave/server"),
    ]);
    return hexclaveInstrumentation(getHexclaveServerApp());
  })();
  return hexclaveNextInstrumentationPromise;
}

export async function register() {
  const hexclaveNextInstrumentation = await getHexclaveNextInstrumentation();
  await hexclaveNextInstrumentation?.register();

  // Next.js builds instrumentation for both Node.js and Edge. Keep the runtime
  // check inline so the Edge bundle does not follow this Node-only import.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (getEnvBoolean("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT")) {
      globalThis.process.title = `Hexclave — Development Server (port ${getEnvVariable("PORT", "?")})`;

      const { startRemoteDevelopmentEnvironmentLifecycle } = await import("./lib/remote-development-environment/manager");
      startRemoteDevelopmentEnvironmentLifecycle();
    } else {
      globalThis.process.title = `stack-dashboard:${getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81")} (node/nextjs)`;
    }
  }

  if (getNextRuntime() === "nodejs" || getNextRuntime() === "edge") {
    Sentry.init({
      ...sentryBaseConfig,

      dsn: getEnvVariable("NEXT_PUBLIC_SENTRY_DSN", ""),

      enabled: getNodeEnvironment() !== "development" && !getEnvVariable("CI", ""),

      skipOpenTelemetrySetup: true,

      // Add exception metadata to the event
      beforeSend(event, hint) {
        const error = hint.originalException;
        let nicified;
        try {
          nicified = nicify(error, { maxDepth: 8 });
        } catch (e) {
          nicified = `Error occurred during nicification: ${e}`;
        }
        if (error instanceof Error) {
          event.extra = {
            ...event.extra,
            cause: error.cause,
            errorProps: {
              ...error,
            },
            nicifiedError: nicified,
          };
        }
        return event;
      },
    });

  }
}

export async function onRequestError(
  ...args: Parameters<HexclaveNextInstrumentation["onRequestError"]>
): Promise<void> {
  const hexclaveNextInstrumentation = await getHexclaveNextInstrumentation();
  if (hexclaveNextInstrumentation === null) return;
  await hexclaveNextInstrumentation.onRequestError(...args);
}
