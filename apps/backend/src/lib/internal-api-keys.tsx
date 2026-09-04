// TODO remove and replace with CRUD handler

import { ApiKeySet, Prisma } from '@/generated/prisma/client';
import { RawQuery, globalPrismaClient, rawQuery } from '@/prisma-client';
import { InternalApiKeysCrud } from '@hexclave/shared/dist/interface/crud/internal-api-keys';
import { yupString } from '@hexclave/shared/dist/schema-fields';
import { typedIncludes } from '@hexclave/shared/dist/utils/arrays';
import { generateSecureRandomString } from '@hexclave/shared/dist/utils/crypto';
import { KnownError, KnownErrors } from '@hexclave/shared/dist/known-errors';
import { HexclaveAssertionError } from '@hexclave/shared/dist/utils/errors';
import { publishableClientKeyNotNecessarySentinel } from '@hexclave/shared/dist/utils/oauth';
import { Result } from '@hexclave/shared/dist/utils/results';
import { generateUuid } from '@hexclave/shared/dist/utils/uuids';
import { getRenderedProjectConfigQuery } from './config';

export const publishableClientKeyHeaderSchema = yupString().matches(/^[a-zA-Z0-9_-]*$/);
export const secretServerKeyHeaderSchema = publishableClientKeyHeaderSchema;
export const superSecretAdminKeyHeaderSchema = secretServerKeyHeaderSchema;

export type CheckApiKeySetError = "invalid-key" | "publishable-key-required";

export function throwCheckApiKeySetError(error: CheckApiKeySetError, projectId: string, invalidKeyError: KnownError): never {
  if (error === "publishable-key-required") {
    throw new KnownErrors.PublishableClientKeyRequiredForProject(projectId);
  }
  throw invalidKeyError;
}

export function checkApiKeySetQuery(projectId: string, key: KeyType): RawQuery<Promise<Result<void, CheckApiKeySetError>>> {
  key = validateKeyType(key);
  const keyType = Object.keys(key)[0] as keyof KeyType;
  const keyValue = key[keyType];

  if (keyType === "publishableClientKey" && keyValue === publishableClientKeyNotNecessarySentinel) {
    return RawQuery.then(
      getRenderedProjectConfigQuery({ projectId }),
      async (configPromise) => {
        const config = await configPromise;
        if (config.project.requirePublishableClientKey) {
          return Result.error("publishable-key-required" as const);
        }
        return Result.ok(undefined);
      },
    );
  }

  const whereClause = Prisma.sql`
    ${Prisma.raw(JSON.stringify(keyType))} = ${keyValue}
  `;

  return {
    supportedPrismaClients: ["global"],
    readOnlyQuery: true,
    sql: Prisma.sql`
      SELECT 't' AS "result"
      FROM "ApiKeySet"
      WHERE ${whereClause}
      AND "projectId" = ${projectId}
      AND "manuallyRevokedAt" IS NULL
      AND "expiresAt" > ${new Date()}
    `,
    postProcess: async (rows): Promise<Result<void, CheckApiKeySetError>> =>
      rows[0]?.result === "t" ? Result.ok(undefined) : Result.error("invalid-key"),
  };
}

export async function checkApiKeySet(projectId: string, key: KeyType): Promise<Result<void, CheckApiKeySetError>> {
  const result = await rawQuery(globalPrismaClient, checkApiKeySetQuery(projectId, key));

  return result;
}


type KeyType =
  | { publishableClientKey: string }
  | { secretServerKey: string }
  | { superSecretAdminKey: string };

function validateKeyType(obj: any): KeyType {
  if (typeof obj !== 'object' || obj === null) {
    throw new HexclaveAssertionError('Invalid key type', { obj });
  }
  const entries = Object.entries(obj);
  if (entries.length !== 1) {
    throw new HexclaveAssertionError('Invalid key type; must have exactly one entry', { obj });
  }
  const [key, value] = entries[0];
  if (!typedIncludes(['publishableClientKey', 'secretServerKey', 'superSecretAdminKey'], key)) {
    throw new HexclaveAssertionError('Invalid key type; field must be one of the three key types', { obj });
  }
  if (typeof value !== 'string') {
    throw new HexclaveAssertionError('Invalid key type; field must be a string', { obj });
  }
  return {
    [key]: value,
  } as KeyType;
}


export async function getApiKeySet(
  projectId: string,
  whereOrId:
    | string
    | KeyType,
): Promise<InternalApiKeysCrud["Admin"]["Read"] | null> {
  const where = typeof whereOrId === 'string'
    ? {
      projectId_id: {
        projectId,
        id: whereOrId,
      }
    }
    : {
      ...validateKeyType(whereOrId),
      projectId,
    };

  const set = await globalPrismaClient.apiKeySet.findUnique({
    where,
  });

  if (!set) {
    return null;
  }

  return createSummaryFromDbType(set);
}


function createSummaryFromDbType(set: ApiKeySet): InternalApiKeysCrud["Admin"]["Read"] {
  return {
    id: set.id,
    description: set.description,
    publishable_client_key: set.publishableClientKey === null ? undefined : {
      last_four: set.publishableClientKey.slice(-4),
    },
    secret_server_key: set.secretServerKey === null ? undefined : {
      last_four: set.secretServerKey.slice(-4),
    },
    super_secret_admin_key: set.superSecretAdminKey === null ? undefined : {
      last_four: set.superSecretAdminKey.slice(-4),
    },
    created_at_millis: set.createdAt.getTime(),
    expires_at_millis: set.expiresAt.getTime(),
    manually_revoked_at_millis: set.manuallyRevokedAt?.getTime() ?? undefined,
  };
}


export const createApiKeySet = async (data: {
  projectId: string,
  description: string,
  expires_at_millis: number,
  has_publishable_client_key: boolean,
  has_secret_server_key: boolean,
  has_super_secret_admin_key: boolean,
}) => {
  const set = await globalPrismaClient.apiKeySet.create({
    data: {
      id: generateUuid(),
      projectId: data.projectId,
      description: data.description,
      expiresAt: new Date(data.expires_at_millis),
      publishableClientKey: data.has_publishable_client_key ? `pck_${generateSecureRandomString()}` : undefined,
      secretServerKey: data.has_secret_server_key ? `ssk_${generateSecureRandomString()}` : undefined,
      superSecretAdminKey: data.has_super_secret_admin_key ? `sak_${generateSecureRandomString()}` : undefined,
    },
  });

  return {
    id: set.id,
    description: set.description,
    publishable_client_key: set.publishableClientKey || undefined,
    secret_server_key: set.secretServerKey || undefined,
    super_secret_admin_key: set.superSecretAdminKey || undefined,
    created_at_millis: set.createdAt.getTime(),
    expires_at_millis: set.expiresAt.getTime(),
    manually_revoked_at_millis: set.manuallyRevokedAt?.getTime(),
    // Flags for audit metadata — never persist the raw key material itself.
    has_publishable_client_key: set.publishableClientKey != null,
    has_secret_server_key: set.secretServerKey != null,
    has_super_secret_admin_key: set.superSecretAdminKey != null,
  };
};
