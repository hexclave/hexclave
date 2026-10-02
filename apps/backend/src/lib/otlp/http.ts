import { decodeOtlpProtobufRequest, encodeOtlpProtobufResponse, type OtlpSignal } from "./protobuf";
import { OtlpJsonRequestError } from "./json";
import { OtlpProtobufError } from "./protobuf";
import { scrubErrorIngestPayload } from "@/lib/error-ingest";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { KnownErrors } from "@hexclave/shared";
import { StatusError } from "@hexclave/shared/dist/utils/errors";

export type OtlpHttpEncoding = "json" | "protobuf";

export class OtlpHttpError extends Error {}

const OTLP_ERROR_MESSAGE_LIMITS = {
  maxPayloadBytes: 512,
  maxStringBytes: 512,
};

export function scrubOtlpErrorMessage(message: string, fallback: string): string {
  const scrubbed = scrubErrorIngestPayload(message, OTLP_ERROR_MESSAGE_LIMITS);
  return typeof scrubbed.value === "string" && scrubbed.value.length > 0
    ? scrubbed.value
    : fallback;
}

export function getOtlpHttpEncoding(headers: Record<string, string[] | undefined>): OtlpHttpEncoding {
  const contentType = headers["content-type"]?.[0]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType === "application/json") return "json";
  if (contentType === "application/x-protobuf") return "protobuf";
  throw new OtlpHttpError("OTLP/HTTP requests must use application/json or application/x-protobuf");
}

function decodeOtlpProtobufBody(signal: OtlpSignal, body: unknown): Json {
  if (!(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) {
    throw new OtlpHttpError("OTLP protobuf request body must be binary");
  }
  return decodeOtlpProtobufRequest(signal, body);
}

export type OtlpClientContext = {
  userId: string | null,
  refreshTokenId: string | null,
};

// Shared by all OTLP export routes: browser (client) exporters must carry a
// user session and a refresh token id, which are used to attribute records to
// a user and correlate them with session replays. Server keys export
// anonymously.
export function resolveOtlpClientContext(
  kind: OtlpSignal,
  auth: { type: string, user?: { readonly id: string }, refreshTokenId?: string | null },
): OtlpClientContext {
  if (auth.type !== "client") return { userId: null, refreshTokenId: null };
  if (!auth.user) throw new KnownErrors.UserAuthenticationRequired();
  if (!auth.refreshTokenId) {
    throw new StatusError(StatusError.BadRequest, `A refresh token is required for browser OTLP ${kind}`);
  }
  return { userId: auth.user.id, refreshTokenId: auth.refreshTokenId };
}

// Decodes the request body for the given signal and normalizes it into the
// caller's canonical record type. Malformed requests (bad content-type, bad
// protobuf, invalid JSON structure) become a scrubbed BadRequest with a
// per-signal fallback message; any other error propagates unchanged.
export function parseOtlpHttpRequest<T>(options: {
  kind: OtlpSignal,
  headers: Record<string, string[] | undefined>,
  body: unknown,
  normalize: (decoded: unknown) => T,
}): { encoding: OtlpHttpEncoding, value: T } {
  try {
    const encoding = getOtlpHttpEncoding(options.headers);
    const value = options.normalize(encoding === "json" ? options.body : decodeOtlpProtobufBody(options.kind, options.body));
    return { encoding, value };
  } catch (error) {
    // Every signal's JSON parser throws the same OtlpJsonRequestError class;
    // protobuf and HTTP framing errors are shared by definition.
    if (error instanceof OtlpJsonRequestError || error instanceof OtlpProtobufError || error instanceof OtlpHttpError) {
      const fallback = error instanceof OtlpProtobufError
        ? "Invalid OTLP protobuf request"
        : `Invalid OTLP ${options.kind} request`;
      throw new StatusError(StatusError.BadRequest, scrubOtlpErrorMessage(error.message, fallback));
    }
    throw error;
  }
}

type OtlpPartialSuccess = {
  rejectedItems: number,
  errorMessage: string,
};

type OtlpJsonResponse = { [key: string]: Json };

type OtlpHttpResponse = {
  statusCode: 200,
  headers: { "content-type": [string] },
  body: OtlpJsonResponse | ArrayBuffer,
};

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(value.byteLength);
  new Uint8Array(result).set(value);
  return result;
}

export function createOtlpHttpResponse(
  signal: OtlpSignal,
  encoding: OtlpHttpEncoding,
  partialSuccess?: OtlpPartialSuccess,
): OtlpHttpResponse {
  let partialSuccessBody: OtlpJsonResponse = {};
  if (partialSuccess !== undefined) {
    const partialSuccessFields: OtlpJsonResponse = {
      errorMessage: partialSuccess.errorMessage,
    };
    if (signal === "traces") {
      partialSuccessFields.rejectedSpans = String(partialSuccess.rejectedItems);
    } else if (signal === "logs") {
      partialSuccessFields.rejectedLogRecords = String(partialSuccess.rejectedItems);
    } else {
      partialSuccessFields.rejectedDataPoints = String(partialSuccess.rejectedItems);
    }
    partialSuccessBody = { partialSuccess: partialSuccessFields };
  }

  if (encoding === "json") {
    return {
      statusCode: 200,
      body: partialSuccessBody,
      headers: { "content-type": ["application/json"] },
    };
  }
  return {
    statusCode: 200,
    body: toArrayBuffer(encodeOtlpProtobufResponse(signal, partialSuccessBody)),
    headers: { "content-type": ["application/x-protobuf"] },
  };
}
