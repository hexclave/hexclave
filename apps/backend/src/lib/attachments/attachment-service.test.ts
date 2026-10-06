import { describe, expect, it } from "vitest";
import { ErrorAttachmentConflictError, ErrorAttachmentService, type ErrorAttachmentRepository } from "./attachment-service";
import type { ErrorAttachmentMetadata } from "./attachment-contract";
import type { ErrorAttachmentObjectStorage } from "./attachment-storage";

function createFixture() {
  const records: ErrorAttachmentMetadata[] = [];
  const objects = new Map<string, Uint8Array>();
  const repository: ErrorAttachmentRepository = {
    async findByIdempotency(scope, key) { return records.find((record) => record.tenancyId === scope.tenantId && record.projectId === scope.projectId && record.branchId === scope.branchId && record.idempotencyKey === key) ?? null; },
    async findByDigestAndFilename(scope, eventId, sha256, filename) { return records.find((record) => record.tenancyId === scope.tenantId && record.projectId === scope.projectId && record.branchId === scope.branchId && record.eventId === eventId && record.sha256 === sha256 && record.filename === filename) ?? null; },
    async findById(scope, id) { return records.find((record) => record.tenancyId === scope.tenantId && record.projectId === scope.projectId && record.branchId === scope.branchId && record.id === id) ?? null; },
    async listByEvent(scope, eventId) { return records.filter((record) => record.tenancyId === scope.tenantId && record.projectId === scope.projectId && record.branchId === scope.branchId && record.eventId === eventId); },
    async create(metadata) {
      records.push(metadata);
      return metadata;
    },
  };
  const storage: ErrorAttachmentObjectStorage = {
    async putImmutableObject(object) {
      if (objects.has(object.key)) return false;
      objects.set(object.key, new Uint8Array(object.body));
      return true;
    },
    async readObject(key) {
      const bytes = objects.get(key);
      return bytes === undefined ? null : new Uint8Array(bytes);
    },
  };
  return { service: new ErrorAttachmentService(repository, storage), records, objects };
}

const scope = { tenantId: "tenant", projectId: "project", branchId: "main" };
const eventId = "a".repeat(32);

describe("error attachment service", () => {
  it("stores bytes privately, returns metadata, and is idempotent on retry", async () => {
    const fixture = createFixture();
    const input = { event_id: eventId, filename: "event.json", content_type: "application/json", data_base64: "eyJvayI6dHJ1ZX0=" };
    const first = await fixture.service.upload(scope, input);
    const second = await fixture.service.upload(scope, input);
    expect(first.status).toBe("uploaded");
    expect(second.status).toBe("already_uploaded");
    expect(fixture.records).toHaveLength(1);
    expect(fixture.objects.size).toBe(1);
    const downloaded = await fixture.service.download(scope, first.attachment.id);
    expect(new TextDecoder().decode(downloaded.bytes)).toBe('{"ok":true}');
    expect(await fixture.service.list(scope, eventId)).toHaveLength(1);
  });

  it("does not let a reused idempotency key replace immutable bytes", async () => {
    const fixture = createFixture();
    const base = { event_id: eventId, filename: "event.json", content_type: "application/json", idempotency_key: "retry-key" };
    await fixture.service.upload(scope, { ...base, data_base64: "YQ==" });
    await expect(fixture.service.upload(scope, { ...base, data_base64: "Yg==" })).rejects.toBeInstanceOf(ErrorAttachmentConflictError);
    expect(fixture.records).toHaveLength(1);
    expect(fixture.objects.size).toBe(1);
  });

  it("keeps a same event id isolated across branches", async () => {
    const fixture = createFixture();
    const uploaded = await fixture.service.upload(scope, { event_id: eventId, filename: "event.txt", data_base64: "YQ==" });
    expect(await fixture.service.list({ ...scope, branchId: "other" }, eventId)).toEqual([]);
    await expect(fixture.service.download({ ...scope, branchId: "other" }, uploaded.attachment.id)).rejects.toThrow("not found");
  });
});
