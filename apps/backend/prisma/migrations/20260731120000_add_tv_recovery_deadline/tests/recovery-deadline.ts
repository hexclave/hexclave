import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();
  const occurrenceId = randomUUID();
  await sql`
    INSERT INTO "Project" (
      "id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode"
    )
    VALUES (${projectId}, NOW(), NOW(), 'TV Recovery Migration Test', '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" (
      "id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization"
    )
    VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue")
  `;
  await sql`
    INSERT INTO "TvEventOccurrence" (
      "id", "tenancyId", "eventType", "presentationClass", "lifecycle",
      "deduplicationKey", "title", "summary", "metricLabel", "metricValue",
      "sourceLabel", "aggregateEvidence", "occurredAt", "detectedAt", "updatedAt"
    )
    VALUES (
      ${occurrenceId}::uuid, ${tenancyId}::uuid,
      'EMAIL_DELIVERY_DEGRADATION'::"TvEventType",
      'INCIDENT'::"TvEventPresentationClass",
      'ACTIVE'::"TvEventOccurrenceLifecycle",
      ${`recovery-migration:${occurrenceId}`}, 'Test incident', 'Test summary',
      'Delivery rate', '90%', 'Hexclave email', '{}'::jsonb, NOW(), NOW(), NOW()
    )
  `;
  await sql`
    INSERT INTO "TvProfileEventPresentation" (
      "tenancyId", "profileId", "occurrenceId", "takeoverStartedAt", "takeoverEndsAt", "updatedAt"
    )
    VALUES (
      ${tenancyId}::uuid, 'company-pulse', ${occurrenceId}::uuid,
      NOW(), NOW() + INTERVAL '60 seconds', NOW()
    )
  `;
  return { tenancyId, occurrenceId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const rows = await sql`
    SELECT "takeoverStartedAt", "takeoverEndsAt", "recoveryEndsAt"
    FROM "TvProfileEventPresentation"
    WHERE "tenancyId" = ${context.tenancyId}::uuid
      AND "occurrenceId" = ${context.occurrenceId}::uuid
  `;
  expect(rows).toHaveLength(1);
  expect(rows[0].takeoverStartedAt).not.toBeNull();
  expect(rows[0].takeoverEndsAt).not.toBeNull();
  expect(rows[0].recoveryEndsAt).toBeNull();

  await sql`
    UPDATE "TvProfileEventPresentation"
    SET "recoveryEndsAt" = NOW() + INTERVAL '30 seconds'
    WHERE "tenancyId" = ${context.tenancyId}::uuid
      AND "occurrenceId" = ${context.occurrenceId}::uuid
  `;
  const updated = await sql`
    SELECT "recoveryEndsAt"
    FROM "TvProfileEventPresentation"
    WHERE "tenancyId" = ${context.tenancyId}::uuid
      AND "occurrenceId" = ${context.occurrenceId}::uuid
  `;
  expect(updated[0].recoveryEndsAt).not.toBeNull();
};
