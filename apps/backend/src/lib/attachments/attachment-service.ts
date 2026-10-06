import { Prisma } from "@/generated/prisma/client";
import { getPrismaClientForTenancy, type PrismaClientTransaction } from "@/prisma-client";
import type { Tenancy } from "@/lib/tenancies";
import { createHash, randomUUID } from "node:crypto";
import {
  getErrorAttachmentObjectKey,
  MAX_ERROR_ATTACHMENTS_PER_EVENT,
  validateErrorAttachmentScope,
  validateErrorAttachmentUpload,
  type ErrorAttachmentMetadata,
  type ErrorAttachmentScope,
  type ErrorAttachmentUploadResult,
  type ValidatedErrorAttachmentUpload,
} from "./attachment-contract";
import { createS3ErrorAttachmentObjectStorage, type ErrorAttachmentObjectStorage } from "./attachment-storage";

export type ErrorAttachmentRepository = {
  findByIdempotency(scope: ErrorAttachmentScope, idempotencyKey: string): Promise<ErrorAttachmentMetadata | null>;
  findByDigestAndFilename(scope: ErrorAttachmentScope, eventId: string, sha256: string, filename: string): Promise<ErrorAttachmentMetadata | null>;
  findById(scope: ErrorAttachmentScope, id: string): Promise<ErrorAttachmentMetadata | null>;
  listByEvent(scope: ErrorAttachmentScope, eventId: string): Promise<ErrorAttachmentMetadata[]>;
  create(metadata: ErrorAttachmentMetadata): Promise<ErrorAttachmentMetadata>;
};

export type ErrorAttachmentBytes = {
  attachment: ErrorAttachmentMetadata,
  bytes: Uint8Array,
};

export class ErrorAttachmentConflictError extends Error {
  public readonly code = "attachment_conflict";
}

export class ErrorAttachmentNotFoundError extends Error {
  public readonly code = "attachment_not_found";
}

export class ErrorAttachmentIntegrityError extends Error {
  public readonly code = "attachment_integrity_error";
}

export class ErrorAttachmentService {
  public constructor(
    private readonly repository: ErrorAttachmentRepository,
    private readonly storage: ErrorAttachmentObjectStorage,
  ) {}

  public static async production(tenancy: Tenancy): Promise<ErrorAttachmentService> {
    return new ErrorAttachmentService(
      createPrismaErrorAttachmentRepository(await getPrismaClientForTenancy(tenancy)),
      createS3ErrorAttachmentObjectStorage(),
    );
  }

  public async upload(scopeInput: ErrorAttachmentScope, input: unknown): Promise<ErrorAttachmentUploadResult> {
    const scope = validateErrorAttachmentScope(scopeInput);
    const upload = validateErrorAttachmentUpload(input);
    return await this.uploadValidated(scope, upload);
  }

  public async uploadBytes(
    scopeInput: ErrorAttachmentScope,
    upload: ValidatedErrorAttachmentUpload,
  ): Promise<ErrorAttachmentUploadResult> {
    const scope = validateErrorAttachmentScope(scopeInput);
    return await this.uploadValidated(scope, upload);
  }

  private async uploadValidated(
    scope: ErrorAttachmentScope,
    upload: ValidatedErrorAttachmentUpload,
  ): Promise<ErrorAttachmentUploadResult> {
    const existingByKey = await this.repository.findByIdempotency(scope, upload.idempotencyKey);
    if (existingByKey !== null) {
      assertSameUpload(existingByKey, upload);
      return { status: "already_uploaded", attachment: existingByKey };
    }

    const existingByDigest = await this.repository.findByDigestAndFilename(scope, upload.eventId, upload.sha256, upload.filename);
    if (existingByDigest !== null) {
      assertSameUpload(existingByDigest, upload);
      return { status: "already_uploaded", attachment: existingByDigest };
    }

    const storageKey = getErrorAttachmentObjectKey(scope, upload.eventId, upload.sha256);
    const createdObject = await this.storage.putImmutableObject({
      key: storageKey,
      body: upload.bytes,
      contentType: upload.contentType,
    });
    if (!createdObject) await verifyStoredBytes(this.storage, storageKey, upload.bytes, upload.sha256);

    const metadata: ErrorAttachmentMetadata = {
      tenancyId: scope.tenantId,
      projectId: scope.projectId,
      branchId: scope.branchId,
      id: randomUUID(),
      eventId: upload.eventId,
      occurrenceId: upload.occurrenceId,
      idempotencyKey: upload.idempotencyKey,
      filename: upload.filename,
      contentType: upload.contentType,
      attachmentType: upload.attachmentType,
      byteLength: upload.bytes.byteLength,
      sha256: upload.sha256,
      storageKey,
      createdAt: new Date(),
    };
    try {
      return { status: "uploaded", attachment: await this.repository.create(metadata) };
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
      const raced = await this.repository.findByIdempotency(scope, upload.idempotencyKey)
        ?? await this.repository.findByDigestAndFilename(scope, upload.eventId, upload.sha256, upload.filename);
      if (raced === null) throw error;
      assertSameUpload(raced, upload);
      return { status: "already_uploaded", attachment: raced };
    }
  }

  public async list(scopeInput: ErrorAttachmentScope, eventId: string): Promise<ErrorAttachmentMetadata[]> {
    const scope = validateErrorAttachmentScope(scopeInput);
    return (await this.repository.listByEvent(scope, eventId)).slice(0, MAX_ERROR_ATTACHMENTS_PER_EVENT);
  }

  public async download(scopeInput: ErrorAttachmentScope, id: string): Promise<ErrorAttachmentBytes> {
    const scope = validateErrorAttachmentScope(scopeInput);
    const attachment = await this.repository.findById(scope, id);
    if (attachment === null) throw new ErrorAttachmentNotFoundError("Attachment not found");
    if (attachment.tenancyId !== scope.tenantId || attachment.projectId !== scope.projectId || attachment.branchId !== scope.branchId) {
      throw new ErrorAttachmentNotFoundError("Attachment not found");
    }
    const bytes = await this.storage.readObject(attachment.storageKey);
    if (bytes === null) throw new ErrorAttachmentNotFoundError("Attachment bytes are not available");
    if (bytes.byteLength !== attachment.byteLength || sha256Hex(bytes) !== attachment.sha256) {
      throw new ErrorAttachmentIntegrityError("Attachment bytes failed the stored integrity check");
    }
    return { attachment, bytes };
  }
}

export async function createProductionErrorAttachmentService(tenancy: Tenancy): Promise<ErrorAttachmentService> {
  return await ErrorAttachmentService.production(tenancy);
}

function createPrismaErrorAttachmentRepository(client: PrismaClientTransaction): ErrorAttachmentRepository {
  return {
    async findByIdempotency(scope, idempotencyKey) {
      return toMetadata(await client.errorAttachment.findFirst({ where: { ...scopeWhere(scope), idempotencyKey } }));
    },
    async findByDigestAndFilename(scope, eventId, sha256, filename) {
      return toMetadata(await client.errorAttachment.findFirst({ where: { ...scopeWhere(scope), eventId, sha256, filename } }));
    },
    async findById(scope, id) {
      return toMetadata(await client.errorAttachment.findFirst({ where: { ...scopeWhere(scope), id } }));
    },
    async listByEvent(scope, eventId) {
      const rows = await client.errorAttachment.findMany({
        where: { ...scopeWhere(scope), eventId },
        orderBy: { createdAt: "desc" },
        take: MAX_ERROR_ATTACHMENTS_PER_EVENT,
      });
      return rows.map((row) => toMetadata(row)).filter((row): row is ErrorAttachmentMetadata => row !== null);
    },
    async create(metadata) {
      return toMetadata(await client.errorAttachment.create({ data: metadata })) ?? throwMissingMetadata();
    },
  };
}

function scopeWhere(scope: ErrorAttachmentScope): { tenancyId: string, projectId: string, branchId: string } {
  return { tenancyId: scope.tenantId, projectId: scope.projectId, branchId: scope.branchId };
}

function toMetadata(row: {
  tenancyId: string,
  projectId: string,
  branchId: string,
  id: string,
  eventId: string,
  occurrenceId: string | null,
  idempotencyKey: string,
  filename: string,
  contentType: string,
  attachmentType: string,
  byteLength: number,
  sha256: string,
  storageKey: string,
  createdAt: Date,
} | null): ErrorAttachmentMetadata | null {
  if (row === null) return null;
  return row;
}

function assertSameUpload(existing: ErrorAttachmentMetadata, upload: ValidatedErrorAttachmentUpload): void {
  if (
    existing.eventId !== upload.eventId
    || existing.occurrenceId !== upload.occurrenceId
    || existing.filename !== upload.filename
    || existing.contentType !== upload.contentType
    || existing.attachmentType !== upload.attachmentType
    || existing.byteLength !== upload.bytes.byteLength
    || existing.sha256 !== upload.sha256
  ) {
    throw new ErrorAttachmentConflictError("Attachment idempotency key or content identity conflicts with an existing attachment");
  }
}

async function verifyStoredBytes(storage: ErrorAttachmentObjectStorage, key: string, expected: Uint8Array, expectedSha256: string): Promise<void> {
  const actual = await storage.readObject(key);
  if (actual === null || actual.byteLength !== expected.byteLength || sha256Hex(actual) !== expectedSha256 || !bytesEqual(actual, expected)) {
    throw new ErrorAttachmentConflictError("An immutable attachment object already exists with different contents");
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function throwMissingMetadata(): never {
  throw new Error("Created attachment metadata disappeared before it could be read");
}
