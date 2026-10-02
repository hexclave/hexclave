import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

const seedTenancy = async (sql: Sql, label: string) => {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), ${label}, '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
    VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue")
  `;
  return { projectId, tenancyId };
};

export const preMigration = async (sql: Sql) => {
  const a = await seedTenancy(sql, "Issues Constraint Test A");
  const b = await seedTenancy(sql, "Issues Constraint Test B");
  return { tenancyA: a.tenancyId, tenancyB: b.tenancyId };
};

const insertIssue = async (sql: Sql, tenancyId: string, shortId: number) => {
  const issueId = randomUUID();
  await sql`
    INSERT INTO "Issue" ("id", "tenancyId", "shortId", "type", "value", "culprit", "platform", "firstSeenAt", "lastSeenAt", "updatedAt")
    VALUES (${issueId}::uuid, ${tenancyId}::uuid, ${shortId}, 'TypeError', 'boom', 'app/page.tsx', 'javascript', NOW(), NOW(), NOW())
  `;
  return issueId;
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const sharedHash = "f".repeat(32);
  const issueA = await insertIssue(sql, ctx.tenancyA, 1);
  const issueB = await insertIssue(sql, ctx.tenancyB, 1);


  await sql`
    INSERT INTO "IssueHash" ("tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance")
    VALUES (${ctx.tenancyA}::uuid, ${sharedHash}, ${issueA}::uuid, 'v1', 'PRIMARY', 'app', '[]'::jsonb)
  `;

  await sql`
    INSERT INTO "IssueHash" ("tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance")
    VALUES (${ctx.tenancyB}::uuid, ${sharedHash}, ${issueB}::uuid, 'v1', 'PRIMARY', 'app', '[]'::jsonb)
  `;

  const secondIssueA = await insertIssue(sql, ctx.tenancyA, 2);
  await expect(sql`
    INSERT INTO "IssueHash" ("tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance")
    VALUES (${ctx.tenancyA}::uuid, ${sharedHash}, ${secondIssueA}::uuid, 'v1', 'PRIMARY', 'app', '[]'::jsonb)
  `).rejects.toThrow(/IssueHash_pkey/);

  const contended = await sql`
    INSERT INTO "IssueHash" ("tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance")
    VALUES (${ctx.tenancyA}::uuid, ${sharedHash}, ${secondIssueA}::uuid, 'v1', 'PRIMARY', 'app', '[]'::jsonb)
    ON CONFLICT ("tenancyId", "hash") DO NOTHING
    RETURNING "issueId"
  `;
  expect(contended).toHaveLength(0);
  const owner = await sql<{ issueId: string }[]>`
    SELECT "issueId" FROM "IssueHash" WHERE "tenancyId" = ${ctx.tenancyA}::uuid AND "hash" = ${sharedHash}
  `;
  expect(owner[0].issueId).toBe(issueA);


  await expect(sql`
    INSERT INTO "IssueHash" ("tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance")
    VALUES (${ctx.tenancyA}::uuid, ${"0".repeat(32)}, ${randomUUID()}::uuid, 'v1', 'PRIMARY', 'app', '[]'::jsonb)
  `).rejects.toThrow(/IssueHash_tenancyId_issueId_fkey/);

  await expect(sql`
    INSERT INTO "IssueHash" ("tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance")
    VALUES (${ctx.tenancyA}::uuid, ${"1".repeat(32)}, ${issueB}::uuid, 'v1', 'PRIMARY', 'app', '[]'::jsonb)
  `).rejects.toThrow(/IssueHash_tenancyId_issueId_fkey/);


  await sql`
    UPDATE "IssueHash" SET "state" = 'LOCKED', "lockedAt" = NOW()
    WHERE "tenancyId" = ${ctx.tenancyA}::uuid AND "hash" = ${sharedHash}
  `;
  const locked = await sql<{ hash: string, state: string | null, lockedAt: Date | null }[]>`
    SELECT "hash", "state", "lockedAt" FROM "IssueHash"
    WHERE "tenancyId" = ${ctx.tenancyA}::uuid AND "state" = 'LOCKED'
  `;
  expect(locked).toHaveLength(1);
  expect(locked[0].hash).toBe(sharedHash);
  expect(locked[0].state).toBe("LOCKED");
  expect(locked[0].lockedAt).not.toBeNull();

  await sql`
    UPDATE "IssueHash" SET "state" = NULL, "lockedAt" = NULL
    WHERE "tenancyId" = ${ctx.tenancyA}::uuid AND "hash" = ${sharedHash}
  `;
  const unlocked = await sql`
    SELECT 1 FROM "IssueHash" WHERE "tenancyId" = ${ctx.tenancyA}::uuid AND "state" IS NOT NULL
  `;
  expect(unlocked).toHaveLength(0);


  const batchId = randomUUID();
  const firstApply = await sql`
    INSERT INTO "IssueMaterialization" ("tenancyId", "batchId") VALUES (${ctx.tenancyA}::uuid, ${batchId}::uuid)
    ON CONFLICT DO NOTHING
    RETURNING "batchId"
  `;
  expect(firstApply).toHaveLength(1);

  const replayApply = await sql`
    INSERT INTO "IssueMaterialization" ("tenancyId", "batchId") VALUES (${ctx.tenancyA}::uuid, ${batchId}::uuid)
    ON CONFLICT DO NOTHING
    RETURNING "batchId"
  `;
  expect(replayApply).toHaveLength(0);

  await expect(sql`
    INSERT INTO "IssueMaterialization" ("tenancyId", "batchId") VALUES (${ctx.tenancyA}::uuid, ${batchId}::uuid)
  `).rejects.toThrow(/IssueMaterialization_pkey/);

  await sql`INSERT INTO "IssueMaterialization" ("tenancyId", "batchId") VALUES (${ctx.tenancyB}::uuid, ${batchId}::uuid)`;

  const transportBatchId = `sentry-envelope-${"a".repeat(64)}`;
  const transportApply = await sql`
    INSERT INTO "IssueMaterialization" ("tenancyId", "batchId") VALUES (${ctx.tenancyA}::uuid, ${transportBatchId})
    ON CONFLICT DO NOTHING
    RETURNING "batchId"
  `;
  expect(transportApply).toHaveLength(1);

  const sideEffectColumns = await sql<{ column_name: string, data_type: string }[]>`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'IssueMaterialization'
      AND column_name IN ('outcomes', 'webhooksDispatchedAt', 'alertsDispatchedAt')
    ORDER BY column_name COLLATE "C"
  `;
  expect(sideEffectColumns).toEqual([
    { column_name: "alertsDispatchedAt", data_type: "timestamp without time zone" },
    { column_name: "outcomes", data_type: "jsonb" },
    { column_name: "webhooksDispatchedAt", data_type: "timestamp without time zone" },
  ]);


  await expect(insertIssue(sql, ctx.tenancyA, 1)).rejects.toThrow(/Issue_tenancyId_shortId_key/);
  expect(await insertIssue(sql, ctx.tenancyB, 2)).toBeTruthy();

  const goneIssueId = randomUUID();
  await sql`
    INSERT INTO "IssueRedirect" ("tenancyId", "fromIssueId", "toIssueId", "fromShortId")
    VALUES (${ctx.tenancyA}::uuid, ${goneIssueId}::uuid, ${issueA}::uuid, 7)
  `;
  await expect(sql`
    INSERT INTO "IssueRedirect" ("tenancyId", "fromIssueId", "toIssueId", "fromShortId")
    VALUES (${ctx.tenancyA}::uuid, ${randomUUID()}::uuid, ${secondIssueA}::uuid, 7)
  `).rejects.toThrow(/IssueRedirect_tenancyId_fromShortId_key/);
  await expect(sql`
    INSERT INTO "IssueRedirect" ("tenancyId", "fromIssueId", "toIssueId", "fromShortId")
    VALUES (${ctx.tenancyA}::uuid, ${goneIssueId}::uuid, ${secondIssueA}::uuid, 8)
  `).rejects.toThrow(/IssueRedirect_pkey/);

  await sql`
    INSERT INTO "IssueRedirect" ("tenancyId", "fromIssueId", "toIssueId", "fromShortId")
    VALUES (${ctx.tenancyB}::uuid, ${randomUUID()}::uuid, ${issueB}::uuid, 7)
  `;

  const orphanRedirect = await sql`
    SELECT 1 FROM "IssueRedirect" WHERE "tenancyId" = ${ctx.tenancyA}::uuid AND "fromIssueId" = ${goneIssueId}::uuid
  `;
  expect(orphanRedirect).toHaveLength(1);


  await sql`INSERT INTO "IssueCounter" ("tenancyId", "nextShortId") VALUES (${ctx.tenancyA}::uuid, 3)`;
  await expect(sql`
    INSERT INTO "IssueCounter" ("tenancyId") VALUES (${ctx.tenancyA}::uuid)
  `).rejects.toThrow(/IssueCounter_pkey/);
  const allocated = await sql<{ nextShortId: string }[]>`
    UPDATE "IssueCounter" SET "nextShortId" = "nextShortId" + 1
    WHERE "tenancyId" = ${ctx.tenancyA}::uuid
    RETURNING "nextShortId"
  `;
  expect(String(allocated[0].nextShortId)).toBe("4");

  await sql`
    UPDATE "IssueCounter" SET "nextShortId" = 9223372036854775807 WHERE "tenancyId" = ${ctx.tenancyA}::uuid
  `;
  const maxed = await sql<{ nextShortId: string }[]>`
    SELECT "nextShortId" FROM "IssueCounter" WHERE "tenancyId" = ${ctx.tenancyA}::uuid
  `;
  expect(String(maxed[0].nextShortId)).toBe("9223372036854775807");
};
