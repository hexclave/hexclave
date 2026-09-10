import { describe, expect, it } from "vitest";
import { FEATURE_REQUEST_FLAG_TYPE, featureRequestFromFlagsJson, normalizeQaFlags } from "./feature-request-flag";

describe("feature request QA flags", () => {
  it("stores a capability gap without changing unrelated QA flags", () => {
    expect(normalizeQaFlags([
      { type: "incomplete_answer", severity: "medium", explanation: "Missing a step" },
    ], {
      detected: true,
      summary: "Support scheduled exports",
      evidence: "The user explicitly requested scheduled exports, which are not supported.",
    })).toEqual([
      { type: "incomplete_answer", severity: "medium", explanation: "Missing a step" },
      {
        type: FEATURE_REQUEST_FLAG_TYPE,
        severity: "low",
        explanation: "The user explicitly requested scheduled exports, which are not supported.",
        summary: "Support scheduled exports",
      },
    ]);
  });

  it("removes a previous capability verdict when a new review does not detect one", () => {
    expect(normalizeQaFlags([{
      type: FEATURE_REQUEST_FLAG_TYPE,
      severity: "low",
      explanation: "Old evidence",
      summary: "Old request",
    }], {
      detected: false,
      summary: "",
      evidence: "",
    })).toEqual([]);
  });

  it("reads valid flags and ignores malformed stored telemetry", () => {
    expect(featureRequestFromFlagsJson(JSON.stringify([{
      type: FEATURE_REQUEST_FLAG_TYPE,
      severity: "low",
      explanation: "Not currently supported",
      summary: "Add an audit-log export",
    }]))).toMatchObject({ summary: "Add an audit-log export" });
    expect(featureRequestFromFlagsJson("not json")).toBeNull();
    expect(featureRequestFromFlagsJson(JSON.stringify([{ type: FEATURE_REQUEST_FLAG_TYPE }]))).toBeNull();
  });

  it("rejects detected requests without evidence", () => {
    expect(() => normalizeQaFlags([], {
      detected: true,
      summary: "Add exports",
      evidence: "",
    })).toThrow("must include a summary and supporting evidence");
  });
});
