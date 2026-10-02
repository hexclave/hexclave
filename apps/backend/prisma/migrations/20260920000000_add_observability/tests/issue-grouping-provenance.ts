import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

const PROVENANCE = [{
  hash: "a".repeat(32),
  role: "primary",
  config_id: "hexclave-js:2026-08-01",
  variant: "app",
  fingerprint: {
    type: "default",
    source: "default",
    tokens: [],
    resolved_tokens: [],
  },
}];

export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();

  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Issue grouping provenance DDL test', '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
    VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue")
  `;

  return { projectId, tenancyId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const columns = await sql<{ column_name: string, data_type: string, udt_name: string, is_nullable: string }[]>`
    SELECT column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'IssueHash'
      AND column_name IN ('groupingRole', 'groupingVariant', 'groupingProvenance')
    ORDER BY column_name COLLATE "C"
  `;
  expect(columns).toEqual([
    { column_name: "groupingProvenance", data_type: "jsonb", udt_name: "jsonb", is_nullable: "NO" },
    { column_name: "groupingRole", data_type: "USER-DEFINED", udt_name: "IssueHashGroupingRole", is_nullable: "NO" },
    { column_name: "groupingVariant", data_type: "character varying", udt_name: "varchar", is_nullable: "NO" },
  ]);

  const issueId = randomUUID();
  await sql`
    INSERT INTO "Issue" ("id", "tenancyId", "shortId", "type", "value", "culprit", "platform", "firstSeenAt", "lastSeenAt", "updatedAt")
    VALUES (${issueId}::uuid, ${ctx.tenancyId}::uuid, 1, 'TypeError', 'boom', 'app/page.tsx', 'javascript', NOW(), NOW(), NOW())
  `;

  const secondaryHash = "b".repeat(32);
  const secondaryProvenance = [{
    hash: secondaryHash,
    role: "secondary",
    config_id: "hexclave-js:2026-08-01",
    variant: "system",
    fingerprint: {
      type: "default",
      source: "default",
      tokens: ["{{ default }}"],
      resolved_tokens: [],
    },
  }];
  await sql`
    INSERT INTO "IssueHash" (
      "tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance"
    ) VALUES (
      ${ctx.tenancyId}::uuid, ${PROVENANCE[0].hash}, ${issueId}::uuid,
      'hexclave-js:2026-08-01', 'PRIMARY'::"IssueHashGroupingRole", 'app', ${JSON.stringify(PROVENANCE)}::jsonb
    ), (
      ${ctx.tenancyId}::uuid, ${secondaryHash}, ${issueId}::uuid,
      'hexclave-js:2026-08-01', 'SECONDARY'::"IssueHashGroupingRole", 'system', ${JSON.stringify(secondaryProvenance)}::jsonb
    )
  `;

  const stored = await sql<{
    hash: string,
    groupingConfigId: string,
    groupingRole: string,
    groupingVariant: string,
    groupingProvenance: string,
  }[]>`
    SELECT "hash", "groupingConfigId", "groupingRole"::text AS "groupingRole", "groupingVariant", "groupingProvenance"::text AS "groupingProvenance"
    FROM "IssueHash"
    WHERE "tenancyId" = ${ctx.tenancyId}::uuid
    ORDER BY "hash" COLLATE "C"
  `;
  expect(stored.map((row) => ({
    ...row,
    groupingProvenance: (() => {
      const parsed: unknown = JSON.parse(row.groupingProvenance);
      return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    })(),
  }))).toEqual([
    {
      hash: PROVENANCE[0].hash,
      groupingConfigId: "hexclave-js:2026-08-01",
      groupingRole: "PRIMARY",
      groupingVariant: "app",
      groupingProvenance: PROVENANCE,
    },
    {
      hash: secondaryHash,
      groupingConfigId: "hexclave-js:2026-08-01",
      groupingRole: "SECONDARY",
      groupingVariant: "system",
      groupingProvenance: secondaryProvenance,
    },
  ]);

  await expect(sql`
    INSERT INTO "IssueHash" ("tenancyId", "hash", "issueId", "groupingConfigId")
    VALUES (${ctx.tenancyId}::uuid, ${"c".repeat(32)}, ${issueId}::uuid, 'hexclave-js:2026-08-01')
  `).rejects.toThrow(/null value in column "groupingRole"/);

  await expect(sql`
    INSERT INTO "IssueHash" (
      "tenancyId", "hash", "issueId", "groupingConfigId", "groupingRole", "groupingVariant", "groupingProvenance"
    ) VALUES (
      ${ctx.tenancyId}::uuid, ${"d".repeat(32)}, ${issueId}::uuid,
      'hexclave-js:2026-08-01', 'INVALID'::text::"IssueHashGroupingRole", 'system', '[]'::jsonb
    )
  `).rejects.toThrow(/invalid input value for enum/);
};
