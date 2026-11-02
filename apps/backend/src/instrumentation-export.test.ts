import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const backendDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

it("exports spans from Sentry's provider to an OTLP HTTP collector", async () => {
  const exportRequests: { byteLength: number, method: string | undefined, url: string | undefined }[] = [];
  const collector = createServer((request, response) => {
    let byteLength = 0;
    request.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
    });
    request.on("end", () => {
      exportRequests.push({
        byteLength,
        method: request.method,
        url: request.url,
      });
      response.writeHead(200);
      response.end();
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    collector.once("error", onError);
    collector.listen(0, "127.0.0.1", () => {
      collector.off("error", onError);
      resolveListen();
    });
  });

  try {
    const address = collector.address();
    if (address == null || typeof address === "string") {
      throw new Error("The test OTLP collector must listen on a TCP port");
    }

    await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      `
        import { trace } from "@opentelemetry/api";
        import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
        import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
        import * as Sentry from "@sentry/node";

        const endpoint = process.env.TEST_OTLP_ENDPOINT;
        if (endpoint == null) throw new Error("TEST_OTLP_ENDPOINT is required");
        Sentry.init({
          enabled: false,
          openTelemetrySpanProcessors: [
            new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint })),
          ],
          registerEsmLoaderHooks: false,
          tracesSampleRate: 1,
        });
        const span = trace.getTracer("otel-export-test").startSpan("export-test-span");
        span.end();
        if (!await Sentry.close(5_000)) throw new Error("Sentry did not flush the OTLP exporter");
      `,
    ], {
      cwd: backendDirectory,
      env: {
        NODE_ENV: "test",
        TEST_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
      },
    });

    expect(exportRequests).toMatchObject([{
      byteLength: expect.any(Number),
      method: "POST",
      url: "/v1/traces",
    }]);
    expect(exportRequests[0]?.byteLength).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      collector.close((error) => error == null ? resolveClose() : rejectClose(error));
    });
  }
}, 10_000);

// Loads the real instrument.ts (instead of a hand-written Sentry.init like the tests above) so that the test
// breaks if the backend ever stops exporting traces to other destinations or starts sending transactions to Sentry
// again. A single local server stands in for both the OTLP collector and Sentry's envelope endpoint.
it("sends errors but no transactions to Sentry while still exporting spans over OTLP", async () => {
  let otlpExportCount = 0;
  const sentryEnvelopeItemTypes: string[] = [];
  const unexpectedRequests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.url?.startsWith("/v1/traces") === true) {
        otlpExportCount++;
      } else if (request.url?.startsWith("/api/1/envelope/") === true) {
        // Sentry gzips large envelopes; ours are tiny, but decode them anyway so the test doesn't depend on that.
        const envelope = (request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body).toString("utf8");
        // An envelope is newline-delimited JSON: one envelope header, then an item header + payload per item.
        const [, ...itemLines] = envelope.split("\n").filter((line) => line !== "");
        for (let i = 0; i < itemLines.length; i += 2) {
          sentryEnvelopeItemTypes.push(JSON.parse(itemLines[i] ?? throwErr("Sentry envelope item header is missing")).type);
        }
      } else {
        unexpectedRequests.push(`${request.method} ${request.url}`);
      }
      response.writeHead(200);
      response.end();
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  try {
    const address = server.address();
    if (address == null || typeof address === "string") {
      throw new Error("The test server must listen on a TCP port");
    }

    await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
        import * as Sentry from "@sentry/node";

        // Importing instrument.ts registers the backend's instrumentation from the environment below.
        const { closeBackendInstrumentation } = await import(process.env.TEST_INSTRUMENT_MODULE_URL);
        Sentry.startSpan({ name: "export-test-transaction" }, () => {
          Sentry.captureException(new Error("export-test-error"));
        });
        await closeBackendInstrumentation(5_000);
      `,
    ], {
      cwd: backendDirectory,
      env: {
        NODE_ENV: "production",
        NEXT_PUBLIC_SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces`,
        TEST_INSTRUMENT_MODULE_URL: pathToFileURL(resolve(backendDirectory, "src/instrument.ts")).href,
      },
    });

    expect(unexpectedRequests).toEqual([]);
    expect(otlpExportCount).toBeGreaterThan(0);
    expect(sentryEnvelopeItemTypes).toContain("event");
    expect(sentryEnvelopeItemTypes).not.toContain("transaction");
    expect(sentryEnvelopeItemTypes).not.toContain("span");
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error == null ? resolveClose() : rejectClose(error));
    });
  }
}, 20_000);

it("preserves active span context without Sentry or an OTLP exporter", async () => {
  await execFileAsync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
      import { trace } from "@opentelemetry/api";
      import { NoopSpanProcessor } from "@opentelemetry/sdk-trace-base";
      import * as Sentry from "@sentry/node";

      Sentry.init({
        enabled: false,
        openTelemetryInstrumentations: [],
        openTelemetrySpanProcessors: [new NoopSpanProcessor()],
        registerEsmLoaderHooks: false,
        tracesSampleRate: 0,
      });
      await trace.getTracer("no-export-context-test").startActiveSpan("active-context", async (span) => {
        if (trace.getActiveSpan() !== span) throw new Error("No active span context");
        span.end();
      });
      if (!await Sentry.close(5_000)) throw new Error("Sentry did not close");
    `,
  ], {
    cwd: backendDirectory,
    env: { NODE_ENV: "test" },
  });
});
