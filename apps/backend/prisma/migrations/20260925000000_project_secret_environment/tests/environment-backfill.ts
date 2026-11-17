import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Secret Environment Backfill', '', false)
  `;
  await sql`
    INSERT INTO "ProjectSecret" ("projectId", "id", "createdAt", "updatedAt", "key", "encrypted")
    VALUES (${projectId}, ${randomUUID()}::uuid, NOW(), NOW(), 'OPENAI_API_KEY', ${sql.json({ edkBase64: "e", ciphertextBase64: "c" })})
  `;
  return { projectId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const rows = await sql`
    SELECT "key", "environment"
    FROM "ProjectSecret"
    WHERE "projectId" = ${ctx.projectId}
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0].key).toBe("OPENAI_API_KEY");
  expect(rows[0].environment).toBe("DEFAULT");

  // The enum type rejects anything outside the four environments, including
  // the lowercase API spelling and the pre-rename name `all`.
  for (const environment of ["staging", "default", "all", "ALL"]) {
    await expect(sql`
      INSERT INTO "ProjectSecret" ("projectId", "id", "createdAt", "updatedAt", "key", "environment", "encrypted")
      VALUES (${ctx.projectId}, ${randomUUID()}::uuid, NOW(), NOW(), 'OTHER_KEY', ${environment}, ${sql.json({ edkBase64: "e", ciphertextBase64: "c" })})
    `).rejects.toThrow(/invalid input value for enum "?ProjectSecretEnvironment"?/);
  }

  const enumValues = await sql`
    SELECT e.enumlabel
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'ProjectSecretEnvironment' AND n.nspname = current_schema()
    ORDER BY e.enumsortorder
  `;
  expect(enumValues.map((row) => row.enumlabel)).toEqual(["DEFAULT", "PRODUCTION", "PREVIEW", "DEVELOPMENT"]);

  const serviceColumns = await sql`
    SELECT column_default
    FROM information_schema.columns
    WHERE table_name = 'DeploymentService' AND column_name = 'envPerEnvironment'
  `;
  expect(serviceColumns).toHaveLength(1);
  expect(serviceColumns[0].column_default).toBe("'{}'::jsonb");
};
