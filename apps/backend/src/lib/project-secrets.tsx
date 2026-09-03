// The project secret store: per-project, write-only credential values, kept
// envelope-encrypted with the data vault's server-side KMS flow
// (`encryptWithKms`) so plaintext never touches the ProjectSecret table.
//
// "Write-only" means exactly that: no API path returns a value. Values are set,
// overwritten, and deleted through /project-secrets, and decrypted here only by
// the feature that consumes them. Note that this protects the DASHBOARD surface,
// not a privilege boundary — a holder of the project's secret server key can
// already have a secret resolved into a deployment it controls.
//
// Scoped by project, not tenancy: these are infrastructure credentials that
// branches share by design, and a per-organization copy of an API key would be
// meaningless. If a consumer ever needs per-branch values, the intended shape is
// a nullable `branchId` (null = applies to every branch) resolved
// exact-match-then-project-wide — cheap while this table is small, but it needs
// a partial unique index for the NULL case, which Prisma can't express.
//
// Deployments are the only consumer today (`secret()` env vars in the deploy
// file's `deploy` export name a key here), but nothing in this module knows
// that; keep it that way.

import { globalPrismaClient } from "@/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import { decryptWithKms } from "@hexclave/shared/dist/helpers/vault/server-side";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

export { MAX_PROJECT_SECRET_KEY_LENGTH, PROJECT_SECRET_KEY_REGEX } from "@hexclave/shared/dist/project-secrets";

// Secret values are meant to be things like API keys, not blobs; the bound
// exists so a hostile client can't stuff megabytes into a KMS-encrypted row.
export const MAX_SECRET_VALUE_LENGTH = 32 * 1024;
// Bounds the per-read KMS decryption work of consumers that decrypt EVERY
// stored secret at once — today the deployments build-log redaction pass, which
// does so on each log read.
export const MAX_SECRETS_PER_PROJECT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decrypts one stored `{ edkBase64, ciphertextBase64 }` payload. */
export async function decryptProjectSecret(encrypted: Prisma.JsonValue, secretKey: string): Promise<string> {
  if (!isRecord(encrypted) || typeof encrypted.edkBase64 !== "string" || typeof encrypted.ciphertextBase64 !== "string") {
    throw new HexclaveAssertionError(`Stored project secret ${JSON.stringify(secretKey)} has an invalid encrypted payload; the set route should have written { edkBase64, ciphertextBase64 }`);
  }
  return await decryptWithKms({ edkBase64: encrypted.edkBase64, ciphertextBase64: encrypted.ciphertextBase64 });
}

/**
 * Decrypts the stored value of one project secret, or returns null when no
 * value is stored. Only for server-side consumers (a deploy, log redaction) —
 * values are write-only everywhere else.
 */
export async function readProjectSecretValue(projectId: string, secretKey: string): Promise<string | null> {
  const row = await globalPrismaClient.projectSecret.findUnique({
    where: {
      projectId_key: {
        projectId,
        key: secretKey,
      },
    },
  });
  if (row == null) return null;
  return await decryptProjectSecret(row.encrypted, secretKey);
}

/** The project's secret keys and timestamps — never their values. */
export async function listProjectSecrets(projectId: string): Promise<{ key: string, createdAt: Date, updatedAt: Date }[]> {
  return await globalPrismaClient.projectSecret.findMany({
    where: { projectId },
    select: { key: true, createdAt: true, updatedAt: true },
    orderBy: { key: "asc" },
  });
}
