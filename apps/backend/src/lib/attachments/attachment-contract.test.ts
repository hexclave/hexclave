import { describe, expect, it } from "vitest";
import {
  MAX_ERROR_ATTACHMENT_BYTES,
  encodeErrorAttachmentBytes,
  getErrorAttachmentObjectKey,
  validateErrorAttachmentUpload,
} from "./attachment-contract";

describe("error attachment contract", () => {
  it("decodes bounded bytes and produces a scope-separated immutable key", () => {
    const upload = validateErrorAttachmentUpload({
      eventId: "ABCDEFABCDEF4ABC8DEFABCDEFABCDEF",
      occurrenceId: "batch-1:3",
      filename: "error.json",
      contentType: "Application/JSON",
      data_base64: encodeErrorAttachmentBytes(new TextEncoder().encode("{\"ok\":true}")),
    });
    expect(upload.eventId).toBe("abcdefabcdef4abc8defabcdefabcdef");
    expect(upload.contentType).toBe("application/json");
    expect(upload.bytes.byteLength).toBe(11);
    expect(getErrorAttachmentObjectKey({ tenantId: "tenant/a", projectId: "project", branchId: "main" }, upload.eventId, upload.sha256)).toContain("tenants/tenant%2Fa/");
    expect(getErrorAttachmentObjectKey({ tenantId: "tenant-a", projectId: "project", branchId: "other" }, upload.eventId, upload.sha256)).not.toBe(
      getErrorAttachmentObjectKey({ tenantId: "tenant-a", projectId: "project", branchId: "main" }, upload.eventId, upload.sha256),
    );
  });

  it("rejects storage keys that would exceed the persisted column bound", () => {
    const eventId = "a".repeat(32);
    const sha256 = "b".repeat(64);
    const scope = { tenantId: "/".repeat(400), projectId: "project", branchId: "main" };
    expect(() => getErrorAttachmentObjectKey(scope, eventId, sha256)).toThrow(/storage key exceeds/);
    expect(getErrorAttachmentObjectKey({ tenantId: "tenant-a", projectId: "project", branchId: "main" }, eventId, sha256).length).toBeLessThanOrEqual(1024);
  });

  it("rejects path traversal, active URL-shaped metadata, and oversized bytes", () => {
    expect(() => validateErrorAttachmentUpload({ eventId: "a".repeat(32), filename: "../secret", data_base64: "YQ==" })).toThrow();
    expect(() => validateErrorAttachmentUpload({ eventId: "a".repeat(32), filename: "report.json", contentType: "https://example.test", data_base64: "YQ==" })).toThrow();
    const oversized = new Uint8Array(MAX_ERROR_ATTACHMENT_BYTES + 1);
    expect(() => validateErrorAttachmentUpload({ eventId: "a".repeat(32), filename: "large.bin", data_base64: encodeErrorAttachmentBytes(oversized) })).toThrow(/bounded|between/);
  });

  it("does not accept non-canonical payload shapes or control characters", () => {
    expect(() => validateErrorAttachmentUpload({ eventId: "a".repeat(32), filename: "report\n.json", data_base64: "YQ==" })).toThrow();
    expect(() => validateErrorAttachmentUpload({ eventId: "a".repeat(32), filename: "report.json", data_base64: "data:text/plain;base64,YQ==" })).toThrow();
  });
});
