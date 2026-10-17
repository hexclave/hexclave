import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

const encrypted = { edkBase64: "e", ciphertextBase64: "c" };

export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Secret Environment Uniqueness', '', false)
  `;
  await sql`
    INSERT INTO "ProjectSecret" ("projectId", "id", "createdAt", "updatedAt", "key", "encrypted")
    VALUES (${projectId}, ${randomUUID()}::uuid, NOW(), NOW(), 'OPENAI_API_KEY', ${sql.json(encrypted)})
  `;
  // Before this migration the old (projectId, key) index still applies.
  await expect(sql`
    INSERT INTO "ProjectSecret" ("projectId", "id", "createdAt", "updatedAt", "key", "environment", "encrypted")
    VALUES (${projectId}, ${randomUUID()}::uuid, NOW(), NOW(), 'OPENAI_API_KEY', 'DEVELOPMENT', ${sql.json(encrypted)})
  `).rejects.toThrow(/ProjectSecret_projectId_key_key/);
  return { projectId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const insert = (key: string, environment: string) => sql`
    INSERT INTO "ProjectSecret" ("projectId", "id", "createdAt", "updatedAt", "key", "environment", "encrypted")
    VALUES (${ctx.projectId}, ${randomUUID()}::uuid, NOW(), NOW(), ${key}, ${environment}, ${sql.json(encrypted)})
  `;

  await insert("OPENAI_API_KEY", "DEVELOPMENT");
  await insert("OPENAI_API_KEY", "PRODUCTION");
  await insert("OPENAI_API_KEY", "PREVIEW");
  const rows = await sql`
    SELECT "environment" FROM "ProjectSecret"
    WHERE "projectId" = ${ctx.projectId} AND "key" = 'OPENAI_API_KEY'
    ORDER BY "environment"
  `;
  // Enum columns sort in declaration order, not alphabetically.
  expect(rows.map((row) => row.environment)).toEqual(["DEFAULT", "PRODUCTION", "PREVIEW", "DEVELOPMENT"]);

  await expect(insert("OPENAI_API_KEY", "DEFAULT")).rejects.toThrow(/ProjectSecret_projectId_key_environment_key/);
  await expect(insert("OPENAI_API_KEY", "DEVELOPMENT")).rejects.toThrow(/ProjectSecret_projectId_key_environment_key/);

  const oldIndex = await sql`SELECT 1 FROM pg_class WHERE relname = 'ProjectSecret_projectId_key_key'`;
  expect(oldIndex).toHaveLength(0);
};
