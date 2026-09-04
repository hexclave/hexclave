import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const IV_BYTES = 12;
export const DEVELOPMENT_DATA_ENCRYPTION_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

export function assertDataEncryptionKeyIsSafe(value: string, mocksAllowed: boolean): void {
  if (value.toLowerCase() === DEVELOPMENT_DATA_ENCRYPTION_KEY && !mocksAllowed) {
    throw new Error("marshal refuses to start: the public development data-encryption key requires MARSHAL_ALLOW_MOCKS=1");
  }
}

export type EncryptedString = {
  encryption_version: 1,
  iv_base64: string,
  auth_tag_base64: string,
  ciphertext_base64: string,
};

export function parseDataEncryptionRootKey(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("marshal refuses to start: HEXCLAVE_MARSHAL_DATA_ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes)");
  }
  return Buffer.from(value, "hex");
}

function deriveKey(rootKey: Buffer, purpose: "stored-spec-env" | "service-revision" | "control-plane-state"): Buffer {
  return createHmac("sha256", rootKey)
    .update(`hexclave-marshal/${purpose}/v1`, "utf8")
    .digest();
}

export function authenticateControlPlaneState(serializedValue: string, authenticatedContext: string, rootKey: Buffer): string {
  return createHmac("sha256", deriveKey(rootKey, "control-plane-state"))
    .update(authenticatedContext, "utf8")
    .update("\0", "utf8")
    .update(serializedValue, "utf8")
    .digest("base64");
}

export function verifyControlPlaneStateAuthentication(serializedValue: string, authenticatedContext: string, macBase64: string, rootKey: Buffer): boolean {
  const expected = Buffer.from(authenticateControlPlaneState(serializedValue, authenticatedContext, rootKey), "base64");
  const provided = Buffer.from(macBase64, "base64");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function serviceRevisionKey(rootKey: Buffer): Buffer {
  return deriveKey(rootKey, "service-revision");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEncryptedString(value: unknown): EncryptedString {
  if (!isRecord(value)
    || value.encryption_version !== 1
    || typeof value.iv_base64 !== "string"
    || typeof value.auth_tag_base64 !== "string"
    || typeof value.ciphertext_base64 !== "string") {
    throw new Error("stored service environment is not a supported encrypted payload");
  }
  return {
    encryption_version: 1,
    iv_base64: value.iv_base64,
    auth_tag_base64: value.auth_tag_base64,
    ciphertext_base64: value.ciphertext_base64,
  };
}

export function encryptString(plaintext: string, authenticatedContext: string, rootKey: Buffer): EncryptedString {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(rootKey, "stored-spec-env"), iv);
  cipher.setAAD(Buffer.from(authenticatedContext, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    encryption_version: 1,
    iv_base64: iv.toString("base64"),
    auth_tag_base64: cipher.getAuthTag().toString("base64"),
    ciphertext_base64: ciphertext.toString("base64"),
  };
}

export function decryptString(value: unknown, authenticatedContext: string, rootKey: Buffer): string {
  const encrypted = readEncryptedString(value);
  const iv = Buffer.from(encrypted.iv_base64, "base64");
  const authTag = Buffer.from(encrypted.auth_tag_base64, "base64");
  if (iv.length !== IV_BYTES || authTag.length !== 16) {
    throw new Error("stored service environment has invalid encryption metadata");
  }
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(rootKey, "stored-spec-env"), iv);
  decipher.setAAD(Buffer.from(authenticatedContext, "utf8"));
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext_base64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
