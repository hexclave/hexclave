import { yupValidate } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { Json } from "@hexclave/shared/dist/utils/json";
import { deepPlainEquals } from "@hexclave/shared/dist/utils/objects";
import { traceSpan } from "@hexclave/shared/dist/utils/telemetry";
import * as yup from "yup";
import "../polyfills";
import { SmartRequest } from "./smart-request";

export type SmartResponse = {
  statusCode: number,
  headers?: Record<string, string[]>,
} & (
  | {
    bodyType?: undefined,
    body?: ArrayBuffer | Json | undefined,
  }
  | {
    bodyType: "empty",
    body?: undefined,
  }
  | {
    bodyType: "text",
    body: string,
  }
  | {
    bodyType: "json",
    body: Json,
  }
  | {
    bodyType: "binary",
    body: ArrayBuffer | Uint8Array,
  }
  | {
    bodyType: "success",
    body?: undefined,
  }
  | {
    bodyType: "response",
    body: Response,
  }
);

export async function validateSmartResponse<T>(req: Request | null, smartReq: SmartRequest, obj: unknown, schema: yup.Schema<T>): Promise<T> {
  try {
    return await yupValidate(schema, obj, {
      abortEarly: false,
      context: {
        noUnknownPathPrefixes: [""],
      },
      currentUserId: smartReq.auth?.user?.id ?? null,
    });
  } catch (error) {
    throw new HexclaveAssertionError(`Error occurred during ${req ? `${req.method} ${req.url}` : "a custom endpoint invocation's"} response validation: ${error}`, { obj, schema, cause: error });
  }
}


// The predicate lists exactly the runtime checks below (rather than the wider
// BodyInit, which also includes string): intersected with SmartResponse's
// declared body types this narrows the "binary" case to buffers, whose
// byteLength the content-length derivation below relies on. Claiming
// ArrayBufferView<ArrayBuffer> (non-shared backing) is as precise as we can
// get — isView can't inspect the backing buffer — and is no stronger a claim
// than the previous `body is BodyInit` already made.
function isBinaryBody(body: unknown): body is ArrayBuffer | SharedArrayBuffer | Blob | ArrayBufferView<ArrayBuffer> {
  return body instanceof ArrayBuffer
    || body instanceof SharedArrayBuffer
    || body instanceof Blob
    || ArrayBuffer.isView(body);
}

function isResponseBody(body: unknown): body is Response {
  return typeof body === "object" && body !== null && body instanceof Response;
}

export async function createResponse<T extends SmartResponse>(req: Request | null, requestId: string, obj: T): Promise<Response> {
  return await traceSpan("creating HTTP response from smart response", async () => {
    let status = obj.statusCode;
    const headers = new Map<string, string[]>();

    let arrayBufferBody;

    // if we have something that resembles a browser, prettify JSON outputs
    const jsonIndent = req?.headers.get("Accept")?.includes("text/html") ? 2 : undefined;

    const bodyType = obj.bodyType ?? (
      obj.body === undefined ? "empty" :
      isResponseBody(obj.body) ? "response" :
      isBinaryBody(obj.body) ? "binary" :
        "json"
    );

    switch (bodyType) {
      case "empty": {
        arrayBufferBody = [204, 205, 304].includes(status) ? null : new ArrayBuffer(0);
        break;
      }
      case "json": {
        if (obj.body === undefined || !deepPlainEquals(obj.body, JSON.parse(JSON.stringify(obj.body)), { ignoreUndefinedValues: true })) {
          throw new HexclaveAssertionError("Invalid JSON body is not JSON", { body: obj.body });
        }
        headers.set("content-type", ["application/json; charset=utf-8"]);
        arrayBufferBody = new TextEncoder().encode(JSON.stringify(obj.body, null, jsonIndent));
        break;
      }
      case "text": {
        headers.set("content-type", ["text/plain; charset=utf-8"]);
        if (typeof obj.body !== "string") throw new Error(`Invalid body, expected string, got ${obj.body}`);
        arrayBufferBody = new TextEncoder().encode(obj.body);
        break;
      }
      case "binary": {
        if (!isBinaryBody(obj.body)) throw new Error(`Invalid body, expected ArrayBuffer or Uint8Array, got ${obj.body}`);
        arrayBufferBody = obj.body;
        break;
      }
      case "response": {
        if (!isResponseBody(obj.body)) {
          throw new Error(`Invalid body, expected Response, got ${obj.body}`);
        }
        for (const [key, value] of obj.body.headers.entries()) {
          headers.set(key.toLowerCase(), [value]);
        }
        arrayBufferBody = obj.body.body;
        break;
      }
      case "success": {
        headers.set("content-type", ["application/json; charset=utf-8"]);
        arrayBufferBody = new TextEncoder().encode(JSON.stringify({
          success: true,
        }, null, jsonIndent));
        break;
      }
      default: {
        throw new Error(`Invalid body type: ${bodyType}`);
      }
    }


    // Next.js used to set Content-Length on route-handler responses, and both
    // clients and the compression layer's minimum-size threshold rely on it
    // being present. Only the "response" bodyType can carry a stream
    // (Response#body is ReadableStream | null); every other case materialized
    // the body into a buffer above, so its byte length is known exactly. The
    // value MUST be exact or Node will truncate/hang the response — which is
    // why it is derived from the encoded buffer, never from the pre-encoding
    // string. Skip when the map already has one (e.g. copied from an inner
    // Response in the "response" case).
    if (!(arrayBufferBody instanceof ReadableStream) && arrayBufferBody != null && !headers.has("content-length")) {
      headers.set("content-length", [arrayBufferBody.byteLength.toString()]);
    }

    // Add the request ID to the response headers
    // Hexclave rebrand: dual-emit both x-hexclave-* and x-stack-* so old and new SDKs can both read it.
    headers.set("x-stack-request-id", [requestId]);
    headers.set("x-hexclave-request-id", [requestId]);


    // Disable caching by default, but only if nothing set a cache-control yet:
    // routes returning a raw Response (bodyType "response") had their inner
    // Response's headers copied into the map above and must be able to opt
    // out — e.g. streaming routes send `no-transform` so the compression
    // layer's gzip buffering doesn't stall incremental delivery.
    if (!headers.has("cache-control")) {
      headers.set("cache-control", ["no-store, max-age=0"]);
    }


    // If the x-stack-override-error-status header is given, override 4xx statuses to 200.
    if (req?.headers.has("x-stack-override-error-status") && status >= 400 && status < 500) {
      status = 200;
      // Hexclave rebrand: dual-emit both x-hexclave-* and x-stack-* so old and new SDKs can both read it.
      headers.set("x-stack-actual-status", [obj.statusCode.toString()]);
      headers.set("x-hexclave-actual-status", [obj.statusCode.toString()]);
    }

    // set all headers from the smart response (considering case insensitivity)
    for (const [key, values] of Object.entries(obj.headers ?? {})) {
        headers.set(key.toLowerCase(), values);
    }

    return new Response(
      arrayBufferBody,
      {
        status,
        headers: [...headers].flatMap(([key, values]) => values.map(v => [key, v] satisfies [string, string])),
      },
    );
  });
}

import.meta.vitest?.test("createResponse sets an exact content-length for JSON bodies", async ({ expect }) => {
  const response = await createResponse(null, "test-request-id", {
    statusCode: 200,
    bodyType: "json",
    // Non-ASCII on purpose: the byte length differs from the string length, so
    // this catches any regression back to measuring the pre-encoding string.
    body: { value: "ünïcödé" },
  });
  const bodyBytes = await response.arrayBuffer();
  expect(bodyBytes.byteLength).toBeGreaterThan("ünïcödé".length);
  expect(response.headers.get("content-length")).toBe(bodyBytes.byteLength.toString());
  expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
});

import.meta.vitest?.test("createResponse keeps an inner Response's cache-control and does not fabricate a content-length for streams", async ({ expect }) => {
  const response = await createResponse(null, "test-request-id", {
    statusCode: 200,
    bodyType: "response",
    body: new Response("streamed body", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store, no-transform",
      },
    }),
  });
  expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
  expect(response.headers.get("content-length")).toBeNull();
  expect(await response.text()).toBe("streamed body");
});
