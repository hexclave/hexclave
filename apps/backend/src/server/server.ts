import { closeBackendInstrumentation } from "@/instrument";
import { closeSharedClickhouseClients } from "@/lib/clickhouse";
import { getTrustedProxy, validateStandaloneTrustedProxyConfiguration } from "@/lib/trusted-proxy";
import "@/polyfills";
import { disconnectPostgresPrismaClients } from "@/prisma-client";
import { drainInFlightPromises } from "@/utils/background-tasks";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import type { Server as ElysiaServer } from "elysia/universal";
import { app } from "./app";
import { googleCloudProfilerEnabledEnvVar, parseGoogleCloudProfilerConfig, startGoogleCloudProfiler } from "./google-cloud-profiler";
import { instanceRecycler, maxInstanceLifetimeEnvVar, parseInstanceRecyclingConfig } from "./instance-recycling";
import { waitForNodeServerToListen } from "./node-server";
import { getMaxRequestBodySizeBytes } from "./request-body-limit";
import { backendShutdownBudget, runShutdownOperationWithTimeout, shutdownBackend } from "./shutdown";

const portPrefix = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX", "81");
const port = Number(getEnvVariable("PORT", getEnvVariable("BACKEND_PORT", `${portPrefix}02`)));
const hostname = getEnvVariable("HOSTNAME", "0.0.0.0");
const trustedProxy = getTrustedProxy();
validateStandaloneTrustedProxyConfiguration({
  nodeEnvironment: getEnvVariable("NODE_ENV", ""),
  publicApiUrl: getEnvVariable("NEXT_PUBLIC_HEXCLAVE_API_URL"),
  trustedProxy,
});

// The @elysia/node adapter never assigns `app.server`, so `app.stop()` falls through to the
// web-standard adapter's stop and throws "Elysia isn't running" even while the server is serving
// traffic. The adapter instead hands a working server handle (whose stop() closes the underlying
// Node http.Server) to the listen callback, so capture that and use it for graceful shutdown.
const listenOptions = {
  hostname,
  port,
  // srvx only uses forwarded protocol/host metadata when the immediate peer is
  // trusted. The deployment setting must only be enabled when direct access to
  // the origin is blocked; otherwise clients could spoof HTTPS and host values.
  trustProxy: trustedProxy !== "",
  // srvx installs its own SIGINT/SIGTERM handlers by default (outside CI/test envs), racing the
  // handlers below: its handler begins `server.close()` first, which marks the listener
  // non-listening, so our own stop step resolves immediately and `process.exit(0)` fires while
  // requests are still in flight. Shutdown must have exactly one owner — this process.
  gracefulShutdown: false,
  // Without a cap, srvx buffers arbitrarily large request bodies and every smart route reads the
  // full body with `arrayBuffer()` before auth/schema validation, so concurrent chunked uploads
  // could exhaust memory on direct Node ingress (Docker/self-host). Keep a conservative default
  // independent of hosted platform limits; operators can raise it explicitly for a known
  // integration. srvx rejects the body read with an ERR_BODY_TOO_LARGE error, which the request
  // pipeline maps to an HTTP 413. Large payloads (deployment tarballs) already bypass the backend
  // via S3 presigned uploads.
  maxRequestBodySize: getMaxRequestBodySizeBytes(),
};
const boundServerPromise = new Promise<ElysiaServer>((resolve, reject) => {
  app.listen(listenOptions, (server) => {
    waitForNodeServerToListen(server).then(resolve, reject);
  });
});

let shutdownPromise: Promise<void> | undefined;

const instanceRecyclingConfig = parseInstanceRecyclingConfig(getEnvVariable(maxInstanceLifetimeEnvVar, ""));

const googleCloudProfilerConfig = parseGoogleCloudProfilerConfig({
  enabled: getEnvVariable(googleCloudProfilerEnabledEnvVar, ""),
  cloudRunService: getEnvVariable("K_SERVICE", ""),
  cloudRunRevision: getEnvVariable("K_REVISION", ""),
});
if (googleCloudProfilerConfig != null) {
  // Profiling is diagnostics only: a failing agent is reported but must not take the server down.
  runAsynchronously(startGoogleCloudProfiler(googleCloudProfilerConfig));
}

runAsynchronously(boundServerPromise.then(() => {
  if (shutdownPromise == null) {
    console.log(`Hexclave backend listening on http://${hostname}:${port}`);
  }
  if (instanceRecyclingConfig != null) {
    instanceRecycler.start({
      config: instanceRecyclingConfig,
      onDrained: () => {
        // A platform SIGTERM may have arrived while we were draining; calling the
        // handler a second time would force-exit with code 1.
        if (shutdownPromise == null) {
          handleShutdownSignal("SIGTERM");
        }
      },
      log: (event) => console.log(JSON.stringify(event)),
    });
  }
}), {
  noErrorLogging: true,
  onError: (error) => {
    console.error(JSON.stringify({
      event: "backend.startup.failed",
      error: error.message,
    }));
    process.exit(1);
  },
});

function handleShutdownSignal(signal: NodeJS.Signals) {
  if (shutdownPromise != null) {
    console.error(JSON.stringify({
      event: "backend.shutdown.forced",
      signal,
    }));
    process.exit(1);
  }

  const hardExitTimeout = setTimeout(() => {
    console.error(JSON.stringify({
      event: "backend.shutdown.timed-out",
      signal,
      timeoutMs: backendShutdownBudget.hardExitTimeoutMs,
    }));
    process.exit(1);
  }, backendShutdownBudget.hardExitTimeoutMs);
  shutdownPromise = shutdownBackend(signal, {
    // stop(false) mirrors the previous app.stop(false) intent: stop accepting new connections but
    // let in-flight requests finish. On Node ≥19, `http.Server.close()` also closes idle
    // keep-alive sockets, so this resolves once active requests complete. The step is bounded:
    // a request that can't finish within the HTTP cap is presumed long-running and will be cut
    // by the platform's grace period anyway. Any unused time flows to background tasks, while
    // the database and instrumentation keep their reserved tail of the overall deadline.
    stopAcceptingRequests: async (timeoutMs) => await runShutdownOperationWithTimeout(
      "http server close",
      timeoutMs,
      async () => (await boundServerPromise).stop(false),
    ),
    drainBackgroundTasks: async (timeoutMs) => await drainInFlightPromises(timeoutMs),
    disconnectDatabases: async (timeoutMs) => await runShutdownOperationWithTimeout(
      "database disconnect",
      timeoutMs,
      async () => await Promise.all([disconnectPostgresPrismaClients(), closeSharedClickhouseClients()]),
    ),
    closeInstrumentation: async (timeoutMs) => await closeBackendInstrumentation(timeoutMs),
    log: (event) => {
      const serializedEvent = JSON.stringify(event);
      if (event.event === "backend.shutdown.failed") {
        console.error(serializedEvent);
      } else {
        console.log(serializedEvent);
      }
    },
  }).then(() => {
    clearTimeout(hardExitTimeout);
    // All owned resources have been drained; exit explicitly so an unknown
    // third-party handle cannot extend a container termination indefinitely.
    process.exit(0);
  });

  runAsynchronously(shutdownPromise, {
    noErrorLogging: true,
    onError: (error) => {
      console.error(JSON.stringify({
        event: "backend.shutdown.unhandled-error",
        signal,
        error: error.message,
      }));
      process.exit(1);
    },
  });
}

process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
process.on("SIGINT", () => handleShutdownSignal("SIGINT"));
