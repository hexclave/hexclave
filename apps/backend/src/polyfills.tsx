import * as Sentry from "@sentry/node";
import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { captureError, errorToNiceString, registerErrorSink } from "@hexclave/shared/dist/utils/errors";
import * as util from "util";
import { runAsynchronouslyAndWaitUntil } from "./utils/background-tasks";

function expandHexclavePortPrefix(value?: string | null) {
  if (!value) return value ?? undefined;
  const prefix = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81");
  return prefix ? value.replace(/\$\{NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX:-81\}/g, prefix) : value;
}

const sentryErrorSink = (location: string, error: unknown, level: "error" | "warning") => {
  if (!("captureException" in Sentry)) {
    // this happens if somehow this is called outside of a Next.js script (eg. in the Prisma seed.ts), just log and ignore
    console.log("Attempted to capture Sentry error outside of Next.js script, ignoring");
    return;
  }
  // Sentry's extra-data normalization only walks enumerable properties, which drops
  // e.g. AggregateError.errors (the per-address connect errors behind `fetch failed`)
  // from nested causes. Attach our nicified rendering so the full chain is readable
  // in one place, whatever Sentry's own error linking does with it.
  Sentry.captureException(error, { extra: { location, errorNiceString: errorToNiceString(error) }, level });
  runAsynchronouslyAndWaitUntil(Sentry.flush(2000));
};

export function ensurePolyfilled() {
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("STACK_") || key.startsWith("NEXT_PUBLIC_STACK_") || key.startsWith("HEXCLAVE_") || key.startsWith("NEXT_PUBLIC_HEXCLAVE_")) {
      const replaced = expandHexclavePortPrefix(value ?? undefined);
      if (replaced !== undefined) {
        // eslint-disable-next-line no-restricted-syntax
        process.env[key] = replaced;
      }
    }
  }

  registerErrorSink(sentryErrorSink);

  if ("addEventListener" in globalThis) {
    globalThis.addEventListener("unhandledrejection", (event) => {
      captureError("unhandled-browser-promise-rejection", event.reason);
      console.error("Unhandled promise rejection", event.reason);
    });
  }

  // not all environments have default options for util.inspect
  if ("inspect" in util && "defaultOptions" in util.inspect) {
    util.inspect.defaultOptions.depth = 8;
  }

  if (typeof process !== "undefined" && typeof process.on === "function") {
    process.on("unhandledRejection", (reason, promise) => {
      captureError("unhandled-promise-rejection", reason);
      if (getNodeEnvironment() === "development") {
        console.error("\x1b[41mUnhandled promise rejection. Some production environments (particularly Vercel) will kill the server in this case, so the server will now exit. Please use the `ignoreUnhandledRejection` function to signal that you've handled the error.\x1b[0m", reason);
        (globalThis as any).process.exit(1);
      }
    });
  }
}

ensurePolyfilled();
