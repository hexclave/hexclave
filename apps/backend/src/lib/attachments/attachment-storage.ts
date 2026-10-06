import { downloadBytes, headBytes, uploadBytesIfAbsent } from "@/s3";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { getErrorAttachmentObjectKey, type ErrorAttachmentScope } from "./attachment-contract";

export type ErrorAttachmentObjectStorage = {
  putImmutableObject(object: { key: string, body: Uint8Array, contentType: string }): Promise<boolean>;
  readObject(key: string): Promise<Uint8Array | null>;
};

export function createS3ErrorAttachmentObjectStorage(): ErrorAttachmentObjectStorage {
  return {
    async putImmutableObject(object) {
      if (object.key !== object.key.trim() || object.key.length > 2_048) throw new Error("Invalid attachment object key");
      try {
        return await uploadBytesIfAbsent({ key: object.key, body: object.body, contentType: object.contentType, private: true });
      } catch (error) {
        if (error instanceof HexclaveAssertionError && /S3|object storage/i.test(error.message)) {
          throw new Error("Attachment object storage is not configured on this Hexclave instance.");
        }
        throw error;
      }
    },
    async readObject(key) {
      try {
        const info = await headBytes({ key, private: true });
        return info === null ? null : await downloadBytes({ key, private: true });
      } catch (error) {
        if (error instanceof HexclaveAssertionError && /S3|object storage/i.test(error.message)) {
          throw new Error("Attachment object storage is not configured on this Hexclave instance.");
        }
        throw error;
      }
    },
  };
}

export function attachmentObjectKeyForScope(scope: ErrorAttachmentScope, eventId: string, sha256: string): string {
  return getErrorAttachmentObjectKey(scope, eventId, sha256);
}
