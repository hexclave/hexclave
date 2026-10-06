import { describe, expect, it } from "vitest";
import { createOtlpHttpResponse, getOtlpHttpEncoding, OtlpHttpError, parseOtlpHttpRequest } from "./http";
import { decodeOtlpProtobufResponse, encodeOtlpProtobufRequest } from "./protobuf";

describe("OTLP/HTTP content negotiation", () => {
  it("recognizes only the two standard OTLP/HTTP media types", () => {
    expect(getOtlpHttpEncoding({ "content-type": ["application/json; charset=utf-8"] })).toBe("json");
    expect(getOtlpHttpEncoding({ "content-type": ["application/x-protobuf"] })).toBe("protobuf");
    expect(() => getOtlpHttpEncoding({ "content-type": ["application/octet-stream"] })).toThrow(OtlpHttpError);
  });

  it("decodes protobuf requests before the shared canonical normalizer", () => {
    const headers = { "content-type": ["application/x-protobuf"] };
    const encoded = encodeOtlpProtobufRequest("logs", { resourceLogs: [] });
    expect(parseOtlpHttpRequest({ kind: "logs", headers, body: encoded, normalize: (decoded) => decoded }).value).toEqual({ resourceLogs: [] });

    const metrics = encodeOtlpProtobufRequest("metrics", { resourceMetrics: [] });
    expect(parseOtlpHttpRequest({ kind: "metrics", headers, body: metrics, normalize: (decoded) => decoded }).value).toEqual({ resourceMetrics: [] });
  });

  it("returns standard empty JSON success and protobuf partial-success messages", () => {
    expect(createOtlpHttpResponse("traces", "json")).toEqual({
      statusCode: 200,
      body: {},
      headers: { "content-type": ["application/json"] },
    });

    const response = createOtlpHttpResponse("logs", "protobuf", {
      rejectedItems: 2,
      errorMessage: "invalid product markers",
    });
    expect(response.headers["content-type"]).toEqual(["application/x-protobuf"]);
    expect(response.body).toBeInstanceOf(ArrayBuffer);
    if (!(response.body instanceof ArrayBuffer)) throw new Error("Expected a protobuf ArrayBuffer response");
    expect(decodeOtlpProtobufResponse("logs", response.body)).toMatchObject({
      partialSuccess: {
        rejectedLogRecords: "2",
        errorMessage: "invalid product markers",
      },
    });

    const metricsResponse = createOtlpHttpResponse("metrics", "json", {
      rejectedItems: 4,
      errorMessage: "invalid data points",
    });
    expect(metricsResponse).toEqual({
      statusCode: 200,
      body: {
        partialSuccess: {
          rejectedDataPoints: "4",
          errorMessage: "invalid data points",
        },
      },
      headers: { "content-type": ["application/json"] },
    });
  });
});
