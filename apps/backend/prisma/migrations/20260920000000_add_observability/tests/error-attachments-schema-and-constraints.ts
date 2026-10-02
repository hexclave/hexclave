import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

const seedTenancy = async (sql: Sql, label: string) => {
  const projectId = `error-attachment-${randomUUID()}`;
  const tenancyId = randomUUID();
  const branchId = "main";
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), ${label}, '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
    VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, ${branchId}, 'TRUE'::"BooleanTrue")
  `;
  return { projectId, tenancyId, branchId };
};

export const preMigration = async (sql: Sql) => ({
  primary: await seedTenancy(sql, "Error attachment persistence test"),
  other: await seedTenancy(sql, "Error attachment scope test"),
});

export const postMigration = async (
  sql: Sql,
  ctx: Awaited<ReturnType<typeof preMigration>>,
) => {
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ErrorAttachment'
    ORDER BY ordinal_position
  `;
  expect(columns.map((row) => row.column_name)).toMatchInlineSnapshot(`
    [
      "tenancyId",
      "projectId",
      "branchId",
      "id",
      "eventId",
      "occurrenceId",
      "idempotencyKey",
      "filename",
      "contentType",
      "attachmentType",
      "byteLength",
      "sha256",
      "storageKey",
      "createdAt",
    ]
  `);

  const attachmentId = randomUUID();
  const values = {
    tenancyId: ctx.primary.tenancyId,
    projectId: ctx.primary.projectId,
    branchId: ctx.primary.branchId,
    eventId: "abcdefabcdef4abc8defabcdefabcdef",
    idempotencyKey: "attachment-key-1",
    filename: "report.json",
    contentType: "application/json",
    attachmentType: "event.attachment",
    sha256: "a".repeat(64),
    storageKey: "error-attachments/v1/private-object",
  };
  await sql`
    INSERT INTO "ErrorAttachment" (
      "tenancyId", "projectId", "branchId", "id", "eventId", "idempotencyKey",
      "filename", "contentType", "attachmentType", "byteLength", "sha256", "storageKey"
    ) VALUES (
      ${values.tenancyId}::uuid, ${values.projectId}, ${values.branchId}, ${attachmentId}::uuid,
      ${values.eventId}, ${values.idempotencyKey}, ${values.filename}, ${values.contentType},
      ${values.attachmentType}, 4, ${values.sha256}, ${values.storageKey}
    )
  `;
  await expect(sql`
    INSERT INTO "ErrorAttachment" (
      "tenancyId", "projectId", "branchId", "id", "eventId", "idempotencyKey",
      "filename", "contentType", "attachmentType", "byteLength", "sha256", "storageKey"
    ) VALUES (
      ${values.tenancyId}::uuid, ${values.projectId}, ${values.branchId}, ${randomUUID()}::uuid,
      ${values.eventId}, ${values.idempotencyKey}, ${values.filename}, ${values.contentType},
      ${values.attachmentType}, 4, ${values.sha256}, ${values.storageKey}
    )
  `).rejects.toThrow(/ErrorAttachment_scope_idempotency_key/);
  await expect(sql`
    INSERT INTO "ErrorAttachment" (
      "tenancyId", "projectId", "branchId", "id", "eventId", "idempotencyKey",
      "filename", "contentType", "attachmentType", "byteLength", "sha256", "storageKey"
    ) VALUES (
      ${ctx.primary.tenancyId}::uuid, ${ctx.other.projectId}, ${ctx.other.branchId}, ${randomUUID()}::uuid,
      ${values.eventId}, 'cross-scope', ${values.filename}, ${values.contentType}, ${values.attachmentType},
      4, ${values.sha256}, ${values.storageKey}
    )
  `).rejects.toThrow(/ErrorAttachment_tenancyId_projectId_branchId_fkey|ErrorAttachment_projectId_fkey/);
  await expect(sql`
    INSERT INTO "ErrorAttachment" (
      "tenancyId", "projectId", "branchId", "id", "eventId", "idempotencyKey",
      "filename", "contentType", "attachmentType", "byteLength", "sha256", "storageKey"
    ) VALUES (
      ${values.tenancyId}::uuid, ${values.projectId}, ${values.branchId}, ${randomUUID()}::uuid,
      ${values.eventId}, 'invalid-length', ${values.filename}, ${values.contentType}, ${values.attachmentType},
      0, ${values.sha256}, ${values.storageKey}
    )
  `).rejects.toThrow(/ErrorAttachment_byteLength_check/);

  await sql`DELETE FROM "Project" WHERE "id" = ${ctx.primary.projectId}`;
  const remaining = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "ErrorAttachment" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
  `;
  expect(remaining[0].count).toBe(0);
};
