// The project secret store: per-project, write-only credential values, kept
// envelope-encrypted with the data vault's server-side KMS flow
// (`encryptWithKms`) so plaintext never touches the ProjectSecret table.
//
// "Write-only" means the list/GET surfaces never return a value. Values are
// set, overwritten, and deleted through /project-secrets. They are decrypted
// here by a deploy (into a container) and by the admin-only resolve endpoint
// that `hexclave dev` uses (`dev` / `all` rows only) — never by the dashboard
// list. This protects the DASHBOARD surface, not a privilege boundary: a
// holder of the project's secret server key can already have a secret resolved
// into a deployment it controls.
//
// Scoped by project, not tenancy: these are infrastructure credentials that
// branches share by design. Values are partitioned by `environment`
// (`all` / `prod` / `preview` / `dev`): a more specific row wins, otherwise
// `all`.

import { globalPrismaClient } from "@/prisma-client";
import type { Prisma } from "@/generated/prisma/client";
import { decryptWithKms } from "@hexclave/shared/dist/helpers/vault/server-side";
import { PROJECT_SECRET_ENVIRONMENTS, type ProjectSecretEnvironment } from "@hexclave/shared/dist/project-secrets";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

export { MAX_PROJECT_SECRET_KEY_LENGTH, PROJECT_SECRET_ENVIRONMENTS, PROJECT_SECRET_KEY_REGEX } from "@hexclave/shared/dist/project-secrets";
export type { ProjectSecretEnvironment } from "@hexclave/shared/dist/project-secrets";

// Secret values are meant to be things like API keys, not blobs; the bound
// exists so a hostile client can't stuff megabytes into a KMS-encrypted row.
export const MAX_SECRET_VALUE_LENGTH = 32 * 1024;
// Bounds distinct KEYS, not rows: each key may have up to four environment
// rows. A 100-row cap would 400 the first extra-env write on a full project.
export const MAX_SECRETS_PER_PROJECT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProjectSecretEnvironment(value: unknown): value is ProjectSecretEnvironment {
  return typeof value === "string" && (PROJECT_SECRET_ENVIRONMENTS as readonly string[]).includes(value);
}

/** Decrypts one stored `{ edkBase64, ciphertextBase64 }` payload. */
export async function decryptProjectSecret(encrypted: Prisma.JsonValue, secretKey: string): Promise<string> {
  if (!isRecord(encrypted) || typeof encrypted.edkBase64 !== "string" || typeof encrypted.ciphertextBase64 !== "string") {
    throw new HexclaveAssertionError(`Stored project secret ${JSON.stringify(secretKey)} has an invalid encrypted payload; the set route should have written { edkBase64, ciphertextBase64 }`);
  }
  return await decryptWithKms({ edkBase64: encrypted.edkBase64, ciphertextBase64: encrypted.ciphertextBase64 });
}

/**
 * Decrypts the stored value of one project secret for an environment, or
 * returns null when neither that environment nor `all` is stored. Only for
 * server-side consumers (a deploy, admin resolve-for-dev).
 */
export async function readProjectSecretValue(projectId: string, secretKey: string, environment: Exclude<ProjectSecretEnvironment, "all">): Promise<string | null> {
  const values = await readProjectSecretValues(projectId, [secretKey], environment);
  return values.get(secretKey) ?? null;
}

/**
 * Bulk form of readProjectSecretValue: one query for every key, then the KMS
 * decryptions in parallel. Keys with neither an `environment` nor an `all` row
 * are absent from the result.
 */
export async function readProjectSecretValues(projectId: string, secretKeys: readonly string[], environment: Exclude<ProjectSecretEnvironment, "all">): Promise<Map<string, string>> {
  if (secretKeys.length === 0) return new Map();
  const rows = await globalPrismaClient.projectSecret.findMany({
    where: {
      projectId,
      key: { in: [...new Set(secretKeys)] },
      environment: { in: [environment, "all"] },
    },
    select: { key: true, environment: true, encrypted: true },
  });
  // The exact environment wins over `all`, whichever order the rows come back in.
  const winningRowByKey = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const current = winningRowByKey.get(row.key);
    if (current == null || row.environment === environment) winningRowByKey.set(row.key, row);
  }
  const decrypted = await Promise.all([...winningRowByKey].map(async ([key, row]) => [key, await decryptProjectSecret(row.encrypted, key)] as const));
  return new Map(decrypted);
}

/** The project's secret keys, environments, and timestamps — never their values. */
export async function listProjectSecrets(projectId: string): Promise<{ key: string, environment: ProjectSecretEnvironment, createdAt: Date, updatedAt: Date }[]> {
  const rows = await globalPrismaClient.projectSecret.findMany({
    where: { projectId },
    select: { key: true, environment: true, createdAt: true, updatedAt: true },
    orderBy: [{ key: "asc" }, { environment: "asc" }],
  });
  return rows.map((row) => {
    if (!isProjectSecretEnvironment(row.environment)) {
      throw new HexclaveAssertionError(`Stored project secret ${JSON.stringify(row.key)} has invalid environment ${JSON.stringify(row.environment)}`);
    }
    return {
      key: row.key,
      environment: row.environment,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

export async function countDistinctProjectSecretKeys(projectId: string): Promise<number> {
  const rows = await globalPrismaClient.projectSecret.findMany({
    where: { projectId },
    select: { key: true },
    distinct: ["key"],
  });
  return rows.length;
}
