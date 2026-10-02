import { describe, expect, it } from "vitest";
import type { Json } from "@hexclave/shared/dist/utils/json";
import type {
  JavaScriptSymbolicationRequest,
  JavaScriptSymbolicationResult,
} from "../symbolication";
import { PublicIssueOccurrenceSchema } from "@/app/api/latest/issues/contract";
import {
  projectResolvedOccurrenceReplayIds,
  projectPublicIssueOccurrence,
  type PublicOccurrenceRow,
} from "./occurrence-projection";
import type { PublicIssueSymbolicator } from "./occurrence-symbolication";

const DEBUG_ID = "01234567-89ab-cdef-0123-456789abcdef";
const SCOPE = {
  tenantId: "tenant-public-issues",
  projectId: "project-public-issues",
  branchId: "main",
};

function occurrenceRow(data: Record<string, Json>): PublicOccurrenceRow {
  return {
    occurrence_id: "occurrence-1",
    event_at: "2026-08-06 12:00:00",
    message: "boom",
    level: "error",
    data,
    error_envelope: JSON.stringify({
      schema: "hexclave.error-envelope",
      version: 1,
      event_id: "0123456789abcdef0123456789abcdef",
      kind: "exception",
      level: "error",
      handled: false,
      message: "boom",
      extra: { safe: "retained", token: "should-not-leak" },
      request: { url: "https://example.test/path?token=should-not-leak" },
    }),
    issue_grouping_provenance: "[]",
    error_frames: JSON.stringify([{
      filename: "static/chunk.js",
      function: "a",
      module: "static/chunk",
      absPath: "static/chunk.js",
      lineno: 2,
      colno: 1,
      inApp: true,
    }]),
    trace_id: null,
    span_id: null,
    page_view_span_id: null,
    session_replay_id: null,
    session_replay_segment_id: null,
    user_id: null,
    service_name: "web",
    deployment_environment_name: "production",
  };
}

describe("public issue occurrence symbolication", () => {
  it("recovers replay links from retained segment projections without guessing on collisions", () => {
    const linked = occurrenceRow({});
    linked.session_replay_segment_id = "segment-1";
    const ambiguous = occurrenceRow({});
    ambiguous.occurrence_id = "occurrence-2";
    ambiguous.session_replay_segment_id = "segment-2";

    expect(projectResolvedOccurrenceReplayIds([linked, ambiguous], [
      { id: "segment-1", sessionReplayId: "replay-1" },
      { id: "segment-2", sessionReplayId: "replay-2" },
      { id: "segment-2", sessionReplayId: "replay-3" },
    ]).map((row) => row.session_replay_id)).toEqual(["replay-1", null]);
  });

  it("passes exact occurrence metadata to the bounded symbolicator and exposes scrubbed source context", async () => {
    let request: JavaScriptSymbolicationRequest | null = null;
    const symbolicator: PublicIssueSymbolicator = {
      symbolicate: async (nextRequest): Promise<JavaScriptSymbolicationResult> => {
        request = nextRequest;
        const raw = nextRequest.frames[0];
        return {
          frames: [{
            raw,
            location: {
              source: "src/error.ts?token=source-secret",
              line: 8,
              column: 4,
              name: "run",
              sourceContext: {
                pre: ["const safe = true;"],
                line: "throw new Error(\"boom\");",
                post: ["Authorization: Bearer source-secret"],
              },
              artifact: {
                manifestSha256: "a".repeat(64),
                debugId: DEBUG_ID,
                codeFile: "static/chunk.js",
              },
            },
            diagnostics: [],
          }],
          diagnostics: [],
          truncatedFrameCount: 0,
        };
      },
    };

    const result = await projectPublicIssueOccurrence(
      occurrenceRow({
        release: "web@2026.08.06",
        dist: "production",
        debug_images: [{ code_file: "static/chunk.js", debug_id: DEBUG_ID }],
        stack: "Error: boom\n    at a (static/chunk.js:2:1)",
        request: { authorization: "Bearer should-not-persist" },
      }),
      { scope: SCOPE, symbolicator },
    );

    expect(request).toMatchObject({
      scope: SCOPE,
      release: "web@2026.08.06",
      dist: "production",
      frames: [{
        codeFile: "static/chunk.js",
        debugId: DEBUG_ID,
        lineno: 2,
        colno: 1,
      }],
    });
    expect(result.frames[0]).toMatchObject({
      filename: "static/chunk.js",
      lineno: 2,
      colno: 1,
      symbolication: {
        status: "symbolicated",
        source_file: "src/error.ts?token=[Filtered]",
        original_line: 8,
        original_column: 4,
        name: "run",
        context: {
          pre: ["const safe = true;"],
          line: "throw new Error(\"boom\");",
          post: ["Authorization: Bearer [Filtered]"],
        },
        diagnostics: [],
      },
    });
    expect(result.frames[0]?.symbolication).not.toHaveProperty("artifact");
    expect(JSON.stringify(result.data)).not.toContain("should-not-persist");
    expect(result.error_envelope).toMatchObject({
      schema: "hexclave.error-envelope",
      extra: { safe: "retained" },
      request: { url: "https://example.test/path" },
    });
    expect(JSON.stringify(result.error_envelope)).not.toContain("should-not-leak");
    expect(result.symbolication_diagnostics).toEqual([]);
    await PublicIssueOccurrenceSchema.validate(result);
  });

  it("returns a typed no-op diagnostic when the occurrence projection has no exact release", async () => {
    let called = false;
    const symbolicator: PublicIssueSymbolicator = {
      symbolicate: async () => {
        called = true;
        throw new Error("symbolicator should not run without exact release metadata");
      },
    };

    const result = await projectPublicIssueOccurrence(
      occurrenceRow({
        debug_images: [{ code_file: "static/chunk.js", debug_id: DEBUG_ID }],
      }),
      { scope: SCOPE, symbolicator },
    );

    expect(called).toBe(false);
    expect(result.frames[0]?.symbolication).toEqual({
      status: "not_attempted",
      source_file: null,
      original_line: null,
      original_column: null,
      name: null,
      context: null,
      diagnostics: [{
        code: "missing_release_metadata",
        message: "The occurrence projection and canonical error envelope do not contain an exact release value, so source-map lookup was not attempted.",
      }],
    });
    expect(result.symbolication_diagnostics).toEqual(result.frames[0]?.symbolication.diagnostics);
  });

  it("projects stored primary and secondary grouping provenance with scrubbing", async () => {
    const row = occurrenceRow({});
    row.issue_grouping_provenance = JSON.stringify([{
      hash: "a".repeat(32),
      role: "primary",
      config_id: "hexclave-js:2026-08-01",
      variant: "app",
      fingerprint: {
        type: "default",
        source: "event",
        tokens: ["{{ type }}"],
        resolved_tokens: ["Authorization: Bearer grouping-secret"],
      },
    }, {
      hash: "b".repeat(32),
      role: "secondary",
      config_id: "hexclave-js:2026-08-01",
      variant: "system",
      fingerprint: {
        type: "default",
        source: "default",
        tokens: [],
        resolved_tokens: [],
      },
    }]);

    const result = await projectPublicIssueOccurrence(row, { scope: SCOPE });

    expect(result.grouping_provenance).toEqual([{
      hash: "a".repeat(32),
      role: "primary",
      config_id: "hexclave-js:2026-08-01",
      variant: "app",
      fingerprint: {
        type: "default",
        source: "event",
        tokens: ["{{ type }}"],
        resolved_tokens: ["Authorization: Bearer [Filtered]"],
      },
    }, {
      hash: "b".repeat(32),
      role: "secondary",
      config_id: "hexclave-js:2026-08-01",
      variant: "system",
      fingerprint: {
        type: "default",
        source: "default",
        tokens: [],
        resolved_tokens: [],
      },
    }]);
    await PublicIssueOccurrenceSchema.validate(result);
  });

  it("uses exact release, dist, and debug-image metadata from the parsed envelope when flat data omits it", async () => {
    let request: JavaScriptSymbolicationRequest | null = null;
    const symbolicator: PublicIssueSymbolicator = {
      symbolicate: async (nextRequest): Promise<JavaScriptSymbolicationResult> => {
        request = nextRequest;
        return {
          frames: nextRequest.frames.map((raw) => ({ raw, location: null, diagnostics: [] })),
          diagnostics: [],
          truncatedFrameCount: 0,
        };
      },
    };
    const row = occurrenceRow({ stack: "Error: boom" });
    row.error_envelope = JSON.stringify({
      release: "web@2026.08.06",
      dist: "production",
      debug_meta: { images: [{ code_file: "static/chunk.js", debug_id: DEBUG_ID }] },
    });

    await projectPublicIssueOccurrence(row, { scope: SCOPE, symbolicator });

    expect(request).toMatchObject({
      release: "web@2026.08.06",
      dist: "production",
      frames: [{ codeFile: "static/chunk.js", debugId: DEBUG_ID }],
    });
  });

  it("drops malformed or oversized envelopes without changing raw_stack or data compatibility", async () => {
    const row = occurrenceRow({ stack: "Error: boom", safe: "retained" });
    row.error_envelope = "{".repeat(256 * 1024 + 1);

    const result = await projectPublicIssueOccurrence(row, { scope: SCOPE });

    expect(result.error_envelope).toBeNull();
    expect(result.raw_stack).toBe("Error: boom");
    expect(result.data).toMatchObject({ stack: "Error: boom", safe: "retained" });
  });

  it("preserves raw frames when the bounded symbolicator reports an artifact mismatch", async () => {
    const symbolicator: PublicIssueSymbolicator = {
      symbolicate: async (request): Promise<JavaScriptSymbolicationResult> => {
        const raw = request.frames[0];
        return {
          frames: [{
            raw,
            location: null,
            diagnostics: [{
              code: "artifact_mismatch",
              message: "The resolved artifact does not match the exact frame contract.",
              debugId: DEBUG_ID,
              codeFile: raw.codeFile,
              line: raw.lineno,
              column: raw.colno,
            }],
          }],
          diagnostics: [],
          truncatedFrameCount: 0,
        };
      },
    };

    const result = await projectPublicIssueOccurrence(
      occurrenceRow({
        release: "web@2026.08.06",
        debug_images: [{ code_file: "static/chunk.js", debug_id: DEBUG_ID }],
      }),
      { scope: SCOPE, symbolicator },
    );

    expect(result.frames[0]).toMatchObject({
      filename: "static/chunk.js",
      abs_path: "static/chunk.js",
      lineno: 2,
      colno: 1,
      symbolication: {
        status: "unsymbolicated",
        source_file: null,
        original_line: null,
        original_column: null,
        diagnostics: [{
          code: "artifact_mismatch",
          debug_id: DEBUG_ID,
          code_file: "static/chunk.js",
          line: 2,
          column: 1,
        }],
      },
    });
  });
});
