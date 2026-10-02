import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

const seedTenancy = async (sql: Sql, label: string) => {
  const projectId = `client-report-${randomUUID()}`;
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
  primary: await seedTenancy(sql, "Client report persistence test"),
  other: await seedTenancy(sql, "Client report scope test"),
});

export const postMigration = async (
  sql: Sql,
  ctx: Awaited<ReturnType<typeof preMigration>>,
) => {
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ErrorIngestClientReport'
    ORDER BY ordinal_position
  `;
  expect(columns.map((row) => row.column_name)).toMatchInlineSnapshot(`
    [
      "tenancyId",
      "projectId",
      "branchId",
      "id",
      "protocol",
      "bucket",
      "reason",
      "category",
      "quantity",
      "idempotencyKey",
      "reportedAt",
      "createdAt",
    ]
  `);

  const reportId = randomUUID();
  const report = {
    tenancyId: ctx.primary.tenancyId,
    projectId: ctx.primary.projectId,
    branchId: ctx.primary.branchId,
    id: reportId,
    protocol: "otlp_logs",
    bucket: "discarded_events",
    reason: "privacy",
    category: "error",
    quantity: 2,
    idempotencyKey: "report-key-1",
  };
  await sql`
    INSERT INTO "ErrorIngestClientReport" ("tenancyId", "projectId", "branchId", "id", "protocol", "bucket", "reason", "category", "quantity", "idempotencyKey")
    VALUES (${report.tenancyId}::uuid, ${report.projectId}, ${report.branchId}, ${report.id}::uuid, ${report.protocol}, ${report.bucket}, ${report.reason}, ${report.category}, ${report.quantity}, ${report.idempotencyKey})
  `;
  await expect(sql`
    INSERT INTO "ErrorIngestClientReport" ("tenancyId", "projectId", "branchId", "id", "protocol", "bucket", "reason", "category", "quantity", "idempotencyKey")
    VALUES (${report.tenancyId}::uuid, ${report.projectId}, ${report.branchId}, ${randomUUID()}::uuid, ${report.protocol}, ${report.bucket}, ${report.reason}, ${report.category}, ${report.quantity}, ${report.idempotencyKey})
  `).rejects.toThrow(/ErrorIngestClientReport_scope_idempotency_key/);
  await expect(sql`
    INSERT INTO "ErrorIngestClientReport" ("tenancyId", "projectId", "branchId", "id", "protocol", "bucket", "reason", "category", "quantity", "idempotencyKey")
    VALUES (${report.tenancyId}::uuid, ${report.projectId}, ${report.branchId}, ${randomUUID()}::uuid, ${report.protocol}, ${report.bucket}, ${report.reason}, ${report.category}, 0, 'invalid-quantity')
  `).rejects.toThrow(/ErrorIngestClientReport_quantity_check/);
  await expect(sql`
    INSERT INTO "ErrorIngestClientReport" ("tenancyId", "projectId", "branchId", "id", "protocol", "bucket", "reason", "category", "quantity", "idempotencyKey")
    VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.other.projectId}, ${ctx.primary.branchId}, ${randomUUID()}::uuid, ${report.protocol}, ${report.bucket}, ${report.reason}, ${report.category}, 1, 'cross-scope')
  `).rejects.toThrow(/ErrorIngestClientReport_projectId_fkey|ErrorIngestClientReport_tenancy_scope_fkey/);

  await sql`DELETE FROM "Project" WHERE "id" = ${ctx.primary.projectId}`;
  const remaining = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM "ErrorIngestClientReport"
    WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
  `;
  expect(remaining[0].count).toBe(0);
};
