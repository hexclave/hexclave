import type { Tenancy } from "@/lib/tenancies";
import type { SmartRequest } from "@/route-handlers/smart-request";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProductionErrorAttachmentService,
  ErrorAttachmentService,
  getErrorAttachmentObjectKey,
  type ErrorAttachmentMetadata,
  type ErrorAttachmentObjectStorage,
  type ErrorAttachmentRepository,
} from "@/lib/attachments";
import { POST as uploadAttachment, GET as listAttachments } from "./route";
import { GET as downloadAttachment } from "./[attachment_id]/route";

vi.mock("@/lib/attachments", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/attachments")>();
  return { ...original, createProductionErrorAttachmentService: vi.fn() };
});

const EVENT_ID = "a".repeat(32);

function createFixture(storageOverrides: Partial<ErrorAttachmentObjectStorage> = {}) {
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
    ...storageOverrides,
  };
  return { service: new ErrorAttachmentService(repository, storage), records, objects };
}

// SAFETY: the attachment routes only read tenancy.id, branchId, project.id, and the observability app gate from
// config; the rest of the Tenancy surface is unused. Starting from an empty base means any new Tenancy dependency
// of the routes fails loudly here instead of being silently satisfied.
const tenancy = Object.assign({} as Tenancy, {
  id: "11111111-2222-4333-8444-555555555555",
  branchId: "main",
  project: { id: "attachment-route-test-project" },
  config: { apps: { installed: { observability: { enabled: true } } } },
});

function request(options: { method: "GET" | "POST", body?: unknown, params?: Record<string, string>, query?: Record<string, string> }): SmartRequest {
  return {
    auth: {
      type: "server",
      project: tenancy.project,
      branchId: tenancy.branchId,
      tenancy,
    },
    url: "http://localhost/api/latest/analytics/attachments",
    method: options.method,
    body: options.body ?? {},
    bodyBuffer: new ArrayBuffer(0),
    headers: {},
    query: options.query ?? {},
    params: options.params ?? {},
    clientVersion: undefined,
  };
}

function useFixture(fixture: { service: ErrorAttachmentService }) {
  vi.mocked(createProductionErrorAttachmentService).mockImplementation(async () => fixture.service);
}

async function invokeExpectingRejection(invocation: Promise<unknown>): Promise<Error> {
  const outcome = await invocation.then(
    () => null,
    (error: unknown) => error,
  );
  if (outcome === null) throw new Error("Expected the route invocation to reject, but it resolved");
  if (!(outcome instanceof Error)) throw new Error("Expected the route invocation to reject with an Error");
  return outcome;
}

beforeEach(() => {
  vi.mocked(createProductionErrorAttachmentService).mockReset();
});

describe("error attachment upload route error mapping", () => {
  it("uploads a valid attachment and stays idempotent on retry", async () => {
    useFixture(createFixture());
    const body = { event_id: EVENT_ID, filename: "event.json", content_type: "application/json", data_base64: "eyJvayI6dHJ1ZX0=" };
    const first = await uploadAttachment.invoke(request({ method: "POST", body }));
    const second = await uploadAttachment.invoke(request({ method: "POST", body }));
    expect(first.body).toMatchObject({ status: "uploaded" });
    expect(second.body).toMatchObject({ status: "already_uploaded" });
  });

  it("returns 400 with the contract's fixed message for invalid payloads without touching the service", async () => {
    useFixture(createFixture());
    await expect(uploadAttachment.invoke(request({
      method: "POST",
      body: { event_id: EVENT_ID, filename: "../escape.json", data_base64: "YQ==" },
    }))).rejects.toMatchObject({ name: "StatusError", statusCode: 400, message: "filename must be a single safe path segment" });
    expect(vi.mocked(createProductionErrorAttachmentService)).not.toHaveBeenCalled();
  });

  it("returns 409 (not 400) when a reused idempotency key carries different content", async () => {
    useFixture(createFixture());
    const base = { event_id: EVENT_ID, filename: "event.json", content_type: "application/json", idempotency_key: "retry-key" };
    await uploadAttachment.invoke(request({ method: "POST", body: { ...base, data_base64: "YQ==" } }));
    await expect(uploadAttachment.invoke(request({ method: "POST", body: { ...base, data_base64: "Yg==" } })))
      .rejects.toMatchObject({ name: "StatusError", statusCode: 409 });
  });

  it("lets object storage failures bubble as internal faults instead of 4xx responses", async () => {
    useFixture(createFixture({
      async putImmutableObject() { throw new Error("object storage exploded"); },
    }));
    const error = await invokeExpectingRejection(uploadAttachment.invoke(request({
      method: "POST",
      body: { event_id: EVENT_ID, filename: "event.json", data_base64: "YQ==" },
    })));
    expect(StatusError.isStatusError(error)).toBe(false);
    expect(error.message).toBe("object storage exploded");
  });
});

describe("error attachment download route error mapping", () => {
  it("returns 404 for an unknown attachment id", async () => {
    useFixture(createFixture());
    await expect(downloadAttachment.invoke(request({
      method: "GET",
      params: { attachment_id: "11111111-1111-4111-8111-111111111111" },
    }))).rejects.toMatchObject({ name: "StatusError", statusCode: 404, message: "Attachment not found" });
  });

  it("returns 404 (not 500) when metadata exists but the backing bytes are gone", async () => {
    const fixture = createFixture();
    useFixture(fixture);
    const uploaded = await uploadAttachment.invoke(request({
      method: "POST",
      body: { event_id: EVENT_ID, filename: "event.json", data_base64: "YQ==" },
    }));
    fixture.objects.delete(getErrorAttachmentObjectKey(
      { tenantId: tenancy.id, projectId: tenancy.project.id, branchId: tenancy.branchId },
      EVENT_ID,
      uploaded.body.attachment.sha256,
    ));
    await expect(downloadAttachment.invoke(request({
      method: "GET",
      params: { attachment_id: uploaded.body.attachment.id },
    }))).rejects.toMatchObject({ name: "StatusError", statusCode: 404, message: "Attachment not found" });
  });

  it("lets storage read failures bubble as internal faults instead of a masked StatusError", async () => {
    const workingFixture = createFixture();
    useFixture(workingFixture);
    const uploaded = await uploadAttachment.invoke(request({
      method: "POST",
      body: { event_id: EVENT_ID, filename: "event.json", data_base64: "YQ==" },
    }));
    const brokenFixture = createFixture({
      async readObject() { throw new Error("object storage read exploded"); },
    });
    brokenFixture.records.push(...workingFixture.records);
    useFixture(brokenFixture);
    const error = await invokeExpectingRejection(downloadAttachment.invoke(request({
      method: "GET",
      params: { attachment_id: uploaded.body.attachment.id },
    })));
    expect(StatusError.isStatusError(error)).toBe(false);
    expect(error.message).toBe("object storage read exploded");
  });

  it("still lists attachments for an event", async () => {
    useFixture(createFixture());
    await uploadAttachment.invoke(request({
      method: "POST",
      body: { event_id: EVENT_ID, filename: "event.json", data_base64: "YQ==" },
    }));
    const listed = await listAttachments.invoke(request({ method: "GET", query: { event_id: EVENT_ID } }));
    expect(listed.body.attachments).toHaveLength(1);
  });
});
