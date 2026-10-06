import { describe, expect, it } from "vitest";
import { parsePublicSearchQuery } from "./contract";
import {
  toPublicSearchFacets,
  toPublicSearchAttachmentMetadata,
  toPublicSearchOccurrence,
  type PublicSearchOccurrenceRow,
} from "./projection";

const ISSUE_HASH = "a".repeat(32);
const EVENT_ID = "b".repeat(32);

describe("public observability search projection", () => {
  it("returns scrubbed metadata and never exposes envelope, user, request, or attachment content", () => {
    const filters = parsePublicSearchQuery({
      record: "event",
      tag_key: "region",
      tag_value: "production",
    });
    const row: PublicSearchOccurrenceRow = {
      occurrence_id: EVENT_ID,
      event_at: "2026-08-06 11:00:00.000",
      body: JSON.stringify({ type: "string", value: "fallback" }),
      level: "error",
      data: {
        event_id: EVENT_ID,
        handled: false,
        message: "Authorization: Bearer hidden https://example.test/path?token=hidden",
        tags: { region: "production" },
        user: { email: "person@example.test" },
        request: { url: "https://example.test/private?token=hidden" },
        attachments: [{
          id: "attachment-1",
          filename: "https://example.test/report.txt?token=hidden",
          content_type: "text/plain",
          size: 12,
          checksum: "checksum",
          attachment_type: "event",
          url: "https://example.test/download?token=hidden",
          content: "raw-secret-bytes",
        }],
        debug_meta: {
          images: [{
            code_file: "https://cdn.example.test/app.js?token=hidden",
            debug_id: "debug-1",
          }],
        },
      },
      error_envelope: JSON.stringify({
        event_id: EVENT_ID,
        message: "Authorization: Bearer hidden https://example.test/path?token=hidden",
        tags: { region: "production" },
        attachments: [{
          id: "attachment-1",
          filename: "https://example.test/report.txt?token=hidden",
          content_type: "text/plain",
          size: 12,
          checksum: "checksum",
          attachment_type: "event",
          url: "https://example.test/download?token=hidden",
          content: "raw-secret-bytes",
        }],
        debug_meta: {
          images: [{
            code_file: "https://cdn.example.test/app.js?token=hidden",
            debug_id: "debug-1",
          }],
        },
      }),
      error_frames: JSON.stringify([{
        absPath: "/Users/alice/project/src/app.ts",
        filename: "https://cdn.example.test/app.ts?token=hidden",
        function: "load",
        lineno: 12,
        colno: 3,
      }]),
      trace_id: "trace-id",
      span_id: "span-id",
      page_view_span_id: null,
      session_replay_id: null,
      user_id: "user-id-must-not-be-returned",
      service_name: "api",
      deployment_environment_name: "production",
      issue_hash: ISSUE_HASH,
    };

    const result = toPublicSearchOccurrence(row, filters);

    expect(result).toMatchObject({
      record_type: "event",
      issue_hash: ISSUE_HASH,
      event_id: EVENT_ID,
      occurrence_id: EVENT_ID,
      service: "api",
      environment: "production",
      matched_tag: { key: "region", value: "production" },
      handled: false,
    });
    expect(result.message).toBe("Authorization: Bearer [Filtered] https://example.test/path?token=[Filtered]");
    expect(result).not.toHaveProperty("data");
    expect(result).not.toHaveProperty("user");
    expect(result).not.toHaveProperty("user_id");
    expect(result).not.toHaveProperty("request");
    expect(result).not.toHaveProperty("trace_id");
    expect(result.attachments).toEqual([{
      id: "attachment-1",
      filename: "/report.txt",
      content_type: "text/plain",
      size: 12,
      checksum: "checksum",
      attachment_type: "event",
    }]);
    expect(result.attachments[0]).not.toHaveProperty("content");
    expect(result.attachments[0]).not.toHaveProperty("url");
    expect(result.source_links).toEqual([
      {
        path: "/<redacted-user>/project/src/app.ts",
        function: "load",
        module: null,
        line: 12,
        column: 3,
        debug_id: null,
      },
      {
        path: "/app.js",
        function: null,
        module: null,
        line: null,
        column: null,
        debug_id: "debug-1",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("hidden");
    expect(JSON.stringify(result)).not.toContain("person@example.test");
  });

  it("scrubs facet values and preserves bounded counts", () => {
    expect(toPublicSearchFacets([
      { facet_key: "tag:region", facet_value: "production", count: "3" },
      { facet_key: "tag:region", facet_value: "Authorization: Bearer hidden", count: 1 },
    ])).toEqual({
      "tag:region": [
        { value: "production", count: 3 },
        { value: "Authorization: Bearer [Filtered]", count: 1 },
      ],
    });
  });

  it("projects attachment metadata without private bytes or storage keys", () => {
    expect(toPublicSearchAttachmentMetadata({
      id: "attachment-1",
      filename: "screenshot.png",
      contentType: "image/png",
      byteLength: 128,
      sha256: "a".repeat(64),
      attachmentType: "event.screenshot",
      bytes: "private-payload",
      storageKey: "private/storage/key",
    })).toEqual({
      id: "attachment-1",
      filename: "screenshot.png",
      content_type: "image/png",
      size: 128,
      checksum: "a".repeat(64),
      attachment_type: "event.screenshot",
    });
  });

  it("uses the stored error message before the OTel log body", () => {
    const filters = parsePublicSearchQuery({});
    const row: PublicSearchOccurrenceRow = {
      occurrence_id: "c".repeat(32),
      event_at: "2026-08-06 11:00:00.000",
      body: JSON.stringify({ type: "string", value: "body-message" }),
      level: "error",
      data: { message: "envelope-message" },
      error_envelope: "{}",
      error_frames: "",
      trace_id: null,
      span_id: null,
      page_view_span_id: null,
      session_replay_id: null,
      user_id: null,
      service_name: null,
      deployment_environment_name: null,
      issue_hash: ISSUE_HASH,
    };

    expect(toPublicSearchOccurrence(row, filters).message).toBe("envelope-message");
  });
});
