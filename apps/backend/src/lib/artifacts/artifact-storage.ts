import { downloadBytes, headBytes, uploadBytesIfAbsent, createPresignedUploadUrl } from "@/s3";
import { S3ServiceException } from "@aws-sdk/client-s3";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { ArtifactServiceError } from "./artifact-errors";

export type ArtifactUploadContentType = "application/javascript" | "application/json";

export type ArtifactStorageObject = {
  key: string,
  body: Uint8Array,
  contentType: ArtifactUploadContentType,
  contentEncoding?: "gzip",
};

export type ArtifactStorageObjectInfo = {
  byteLength: number,
  eTag?: string,
};

export type ArtifactObjectStorage = {
  putImmutableObject(object: ArtifactStorageObject): Promise<boolean>;
  createUploadUrl(options: {
    key: string,
    contentType: ArtifactUploadContentType,
    contentEncoding?: "gzip",
  }): Promise<string>;
  headObject(key: string): Promise<ArtifactStorageObjectInfo | null>;
  readObject(key: string, expectedETag?: string): Promise<Uint8Array | null>;
};

export function createS3ArtifactObjectStorage(): ArtifactObjectStorage {
  return {
    async putImmutableObject(object) {
      try {
        return await uploadBytesIfAbsent({
          key: object.key,
          body: object.body,
          contentType: object.contentType,
          contentEncoding: object.contentEncoding,
          private: true,
        });
      } catch (error) {
        rethrowStorageConfigurationError(error);
      }
    },
    async createUploadUrl(options) {
      try {
        return await createPresignedUploadUrl({
          key: options.key,
          expiresInSeconds: 15 * 60,
          contentType: options.contentType,
          contentEncoding: options.contentEncoding,
          createOnly: true,
          private: true,
        });
      } catch (error) {
        rethrowStorageConfigurationError(error);
      }
    },
    async headObject(key) {
      try {
        const result = await headBytes({ key, private: true });
        return result === null ? null : { byteLength: result.byteLength, eTag: result.eTag };
      } catch (error) {
        rethrowStorageConfigurationError(error);
      }
    },
    async readObject(key, expectedETag) {
      try {
        const eTag = expectedETag ?? (await headBytes({ key, private: true }))?.eTag;
        if (eTag === undefined) return null;
        try {
          return await downloadBytes({ key, private: true, ifMatch: eTag });
        } catch (error) {
          if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
            return null;
          }
          if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
            throw new ArtifactServiceError("integrity_mismatch", "The artifact object changed while it was being read.");
          }
          throw error;
        }
      } catch (error) {
        rethrowStorageConfigurationError(error);
      }
    },
  };
}

const STORAGE_NOT_CONFIGURED_MESSAGES = [
  "S3 is not configured",
  "S3 bucket is not configured",
  "S3 private bucket is not configured",
];

function rethrowStorageConfigurationError(error: unknown): never {
  const isNotConfigured = error instanceof HexclaveAssertionError
    && STORAGE_NOT_CONFIGURED_MESSAGES.some((message) => error.message === message || error.message.startsWith(`${message}\n`));
  if (isNotConfigured) {
    throw new ArtifactServiceError(
      "storage_unavailable",
      "Artifact object storage is not configured on this Hexclave instance.",
    );
  }
  throw error;
}
