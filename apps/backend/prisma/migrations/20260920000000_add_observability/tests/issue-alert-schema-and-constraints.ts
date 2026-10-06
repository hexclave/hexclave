import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

const seedTenancy = async (sql: Sql, label: string) => {
  const projectId = `issue-alert-${randomUUID()}`;
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

export const preMigration = async (sql: Sql) => {
  const primary = await seedTenancy(sql, "Issue alert persistence test");
  const other = await seedTenancy(sql, "Issue alert persistence scope test");
  return { primary, other };
};

export const postMigration = async (
  sql: Sql,
  ctx: Awaited<ReturnType<typeof preMigration>>,
) => {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('IssueAlertRule', 'IssueAlertCooldownClaim', 'IssueAlertDelivery')
    ORDER BY table_name COLLATE "C"
  `;
  expect(tables.map((row) => row.table_name)).toMatchInlineSnapshot(`
    [
      "IssueAlertCooldownClaim",
      "IssueAlertDelivery",
      "IssueAlertRule",
    ]
  `);

  const payloadColumns = await sql<{ column_name: string, data_type: string }[]>`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'IssueAlertDelivery'
      AND column_name = 'workflowPayload'
  `;
  expect(payloadColumns).toEqual([{ column_name: "workflowPayload", data_type: "jsonb" }]);

  const enumLabels = await sql<{ typname: string, enumlabel: string }[]>`
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname IN ('IssueAlertEventKind', 'IssueAlertDeliveryState', 'IssueAlertDeliveryOutcome')
    ORDER BY t.typname, e.enumsortorder
  `;
  expect(enumLabels.map((row) => `${row.typname}.${row.enumlabel}`)).toMatchInlineSnapshot(`
    [
      "IssueAlertDeliveryOutcome.NONE",
      "IssueAlertDeliveryOutcome.COOLDOWN_ACTIVE",
      "IssueAlertDeliveryOutcome.WORKFLOW_ENQUEUED",
      "IssueAlertDeliveryOutcome.WORKFLOW_DELIVERED",
      "IssueAlertDeliveryOutcome.WORKFLOW_FAILED",
      "IssueAlertDeliveryOutcome.WORKFLOW_DROPPED",
      "IssueAlertDeliveryOutcome.INVALID_RULE",
      "IssueAlertDeliveryState.CLAIMED",
      "IssueAlertDeliveryState.SUPPRESSED",
      "IssueAlertDeliveryState.ENQUEUED",
      "IssueAlertDeliveryState.DELIVERED",
      "IssueAlertDeliveryState.FAILED",
      "IssueAlertDeliveryState.DROPPED",
      "IssueAlertEventKind.NEW",
      "IssueAlertEventKind.REGRESSION",
      "IssueAlertEventKind.OCCURRENCE",
    ]
  `);

  const indexes = await sql<{ indexname: string }[]>`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('IssueAlertRule', 'IssueAlertCooldownClaim', 'IssueAlertDelivery')
    ORDER BY indexname COLLATE "C"
  `;
  expect(indexes.map((row) => row.indexname)).toMatchInlineSnapshot(`
    [
      "IssueAlertCooldownClaim_pkey",
      "IssueAlertCooldownClaim_scope_expiresAt_idx",
      "IssueAlertCooldownClaim_scope_key",
      "IssueAlertCooldownClaim_tenancyId_cooldownKey_key",
      "IssueAlertDelivery_pkey",
      "IssueAlertDelivery_retry_idx",
      "IssueAlertDelivery_scope_createdAt_idx",
      "IssueAlertDelivery_tenancyId_deduplicationKey_key",
      "IssueAlertDelivery_workflowEvent_idx",
      "IssueAlertRule_active_scope_idx",
      "IssueAlertRule_pkey",
      "IssueAlertRule_scope_ruleKey_version_key",
      "IssueAlertRule_tenancyId_id_scope_key",
    ]
  `);

  const ruleId = randomUUID();
  const issueId = randomUUID();
  const cooldownId = randomUUID();
  const deliveryId = randomUUID();
  const now = new Date();
  const ruleConfig = JSON.stringify({
    schemaVersion: 1,
    id: "first-sighting",
    version: 1,
    enabled: true,
    conditions: {},
    cooldown: { durationSeconds: 60, keyBy: "issue" },
    action: { type: "email", userIds: ["user-1"], subject: "Issue", html: "<p>Issue</p>" },
  });

  await sql`
    INSERT INTO "Issue" ("id", "tenancyId", "shortId", "type", "value", "culprit", "platform", "firstSeenAt", "lastSeenAt", "updatedAt")
    VALUES (${issueId}::uuid, ${ctx.primary.tenancyId}::uuid, 1, 'TypeError', 'boom', 'app.ts', 'node', NOW(), NOW(), NOW())
  `;
  await sql`
    INSERT INTO "IssueAlertRule" ("tenancyId", "projectId", "branchId", "id", "ruleKey", "version", "schemaVersion", "enabled", "config", "updatedAt")
    VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${ruleId}::uuid, 'first-sighting', 1, 1, true, ${ruleConfig}::text::jsonb, NOW())
  `;
  await sql`
    INSERT INTO "IssueAlertCooldownClaim" ("tenancyId", "projectId", "branchId", "id", "ruleId", "cooldownKey", "expiresAt", "lastClaimedAt", "updatedAt")
    VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${cooldownId}::uuid, ${ruleId}::uuid, 'cooldown-1', ${new Date(now.getTime() + 60_000)}, ${now}, NOW())
  `;
  await sql`
    INSERT INTO "IssueAlertDelivery" (
      "tenancyId", "projectId", "branchId", "id", "ruleId", "issueId", "occurrenceId", "ruleVersion", "eventKind",
      "deduplicationKey", "cooldownKey", "cooldownDurationSeconds", "cooldownExpiresAt", "state", "outcome", "updatedAt"
    ) VALUES (
      ${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${deliveryId}::uuid, ${ruleId}::uuid, ${issueId}::uuid,
      'occurrence-1', 1, 'NEW', 'dedupe-1', 'cooldown-1', 60, ${new Date(now.getTime() + 60_000)}, 'ENQUEUED', 'WORKFLOW_ENQUEUED', NOW()
    )
  `;

  await expect(sql`
    INSERT INTO "IssueAlertDelivery" (
      "tenancyId", "projectId", "branchId", "id", "ruleId", "issueId", "occurrenceId", "ruleVersion", "eventKind",
      "deduplicationKey", "cooldownKey", "cooldownDurationSeconds", "updatedAt"
    ) VALUES (
      ${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${randomUUID()}::uuid, ${ruleId}::uuid, ${issueId}::uuid,
      'occurrence-2', 1, 'OCCURRENCE', 'dedupe-1', 'cooldown-1', 60, NOW()
    )
  `).rejects.toThrow(/IssueAlertDelivery_tenancyId_deduplicationKey_key/);

  await expect(sql`
    INSERT INTO "IssueAlertCooldownClaim" ("tenancyId", "projectId", "branchId", "id", "ruleId", "cooldownKey", "expiresAt", "lastClaimedAt", "updatedAt")
    VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${randomUUID()}::uuid, ${ruleId}::uuid, 'cooldown-1', NOW(), NOW(), NOW())
  `).rejects.toThrow(/IssueAlertCooldownClaim_tenancyId_cooldownKey_key/);

  await expect(sql`
    INSERT INTO "IssueAlertRule" ("tenancyId", "projectId", "branchId", "id", "ruleKey", "version", "schemaVersion", "enabled", "config", "updatedAt")
    VALUES (${ctx.primary.tenancyId}::uuid, ${ctx.primary.projectId}, ${ctx.primary.branchId}, ${randomUUID()}::uuid, 'oversized', 1, 1, true,
      ${JSON.stringify({ value: "x".repeat(66_000) })}::text::jsonb, NOW())
  `).rejects.toThrow(/IssueAlertRule_config_size_check/);

  await expect(sql`
    INSERT INTO "IssueAlertDelivery" (
      "tenancyId", "projectId", "branchId", "id", "ruleId", "issueId", "occurrenceId", "ruleVersion", "eventKind",
      "deduplicationKey", "cooldownKey", "cooldownDurationSeconds", "updatedAt"
    ) VALUES (
      ${ctx.other.tenancyId}::uuid, ${ctx.other.projectId}, ${ctx.other.branchId}, ${randomUUID()}::uuid, ${ruleId}::uuid, ${issueId}::uuid,
      'wrong-scope', 1, 'OCCURRENCE', 'dedupe-wrong-scope', 'cooldown-wrong-scope', 60, NOW()
    )
  `).rejects.toThrow(/IssueAlertDelivery_rule_scope_fkey|IssueAlertDelivery_issue_fkey/);

  await sql`DELETE FROM "Project" WHERE "id" = ${ctx.primary.projectId}`;
  const remaining = await sql<{ table_name: string, count: number }[]>`
    SELECT table_name, count
    FROM (
      SELECT 'IssueAlertRule' AS table_name, count(*)::int AS count FROM "IssueAlertRule" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
      UNION ALL
      SELECT 'IssueAlertCooldownClaim', count(*)::int FROM "IssueAlertCooldownClaim" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
      UNION ALL
      SELECT 'IssueAlertDelivery', count(*)::int FROM "IssueAlertDelivery" WHERE "tenancyId" = ${ctx.primary.tenancyId}::uuid
    ) AS counts
    ORDER BY table_name COLLATE "C"
  `;
  expect(remaining.every((row) => row.count === 0)).toBe(true);
};
