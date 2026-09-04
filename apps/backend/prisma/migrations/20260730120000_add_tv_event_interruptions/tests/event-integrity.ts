import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

async function createTenancy(sql: Sql): Promise<{ projectId: string, tenancyId: string }> {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();
  await sql`
    INSERT INTO "Project" (
      "id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode"
    )
    VALUES (${projectId}, NOW(), NOW(), 'TV Event Migration Test', '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" (
      "id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization"
    )
    VALUES (
      ${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue"
    )
  `;
  return { projectId, tenancyId };
}

export const preMigration = async (sql: Sql) => {
  return {
    first: await createTenancy(sql),
    second: await createTenancy(sql),
  };
};

async function insertOccurrence(sql: Sql, options: {
  tenancyId: string,
  occurrenceId?: string,
  deduplicationKey: string,
  eventType: "USER_MILESTONE" | "EMAIL_DELIVERY_DEGRADATION",
  presentationClass: "CELEBRATION" | "INCIDENT" | "CRITICAL_INCIDENT",
  lifecycle: "OCCURRED" | "ACTIVE" | "RESOLVED",
  resolvedAt?: Date | null,
}): Promise<string> {
  const occurrenceId = options.occurrenceId ?? randomUUID();
  const resolvedAt = options.resolvedAt === undefined
    ? options.lifecycle === "RESOLVED" ? new Date() : null
    : options.resolvedAt;
  await sql`
    INSERT INTO "TvEventOccurrence" (
      "id", "tenancyId", "eventType", "presentationClass", "lifecycle",
      "deduplicationKey", "title", "summary", "metricLabel", "metricValue",
      "sourceLabel", "aggregateEvidence", "occurredAt", "detectedAt", "resolvedAt", "updatedAt"
    )
    VALUES (
      ${occurrenceId}::uuid,
      ${options.tenancyId}::uuid,
      ${options.eventType}::"TvEventType",
      ${options.presentationClass}::"TvEventPresentationClass",
      ${options.lifecycle}::"TvEventOccurrenceLifecycle",
      ${options.deduplicationKey},
      'Test event',
      'Office-safe test summary',
      'Test metric',
      '100',
      'Hexclave test',
      '{}'::jsonb,
      NOW(),
      NOW(),
      ${resolvedAt},
      NOW()
    )
  `;
  return occurrenceId;
}

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const validCombinations = [
    ["USER_MILESTONE", "CELEBRATION", "OCCURRED"],
    ["EMAIL_DELIVERY_DEGRADATION", "INCIDENT", "ACTIVE"],
    ["EMAIL_DELIVERY_DEGRADATION", "INCIDENT", "RESOLVED"],
    ["EMAIL_DELIVERY_DEGRADATION", "CRITICAL_INCIDENT", "ACTIVE"],
    ["EMAIL_DELIVERY_DEGRADATION", "CRITICAL_INCIDENT", "RESOLVED"],
  ] as const;
  for (const [eventType, presentationClass, lifecycle] of validCombinations) {
    await insertOccurrence(sql, {
      tenancyId: ctx.first.tenancyId,
      deduplicationKey: `valid-${eventType}-${presentationClass}-${lifecycle}`,
      eventType,
      presentationClass,
      lifecycle,
    });
  }

  const invalidLifecycles = [
    ["USER_MILESTONE", "CELEBRATION", "ACTIVE"],
    ["USER_MILESTONE", "CELEBRATION", "RESOLVED"],
    ["EMAIL_DELIVERY_DEGRADATION", "INCIDENT", "OCCURRED"],
    ["EMAIL_DELIVERY_DEGRADATION", "CRITICAL_INCIDENT", "OCCURRED"],
  ] as const;
  for (const [eventType, presentationClass, lifecycle] of invalidLifecycles) {
    await expect(insertOccurrence(sql, {
      tenancyId: ctx.first.tenancyId,
      deduplicationKey: `invalid-lifecycle-${eventType}-${presentationClass}-${lifecycle}`,
      eventType,
      presentationClass,
      lifecycle,
    })).rejects.toThrow(/TvEventOccurrence_lifecycle_class_check/);
  }

  await expect(insertOccurrence(sql, {
    tenancyId: ctx.first.tenancyId,
    deduplicationKey: "invalid-active-resolution-timestamp",
    eventType: "EMAIL_DELIVERY_DEGRADATION",
    presentationClass: "INCIDENT",
    lifecycle: "ACTIVE",
    resolvedAt: new Date(),
  })).rejects.toThrow(/TvEventOccurrence_lifecycle_class_check/);
  await expect(insertOccurrence(sql, {
    tenancyId: ctx.first.tenancyId,
    deduplicationKey: "invalid-resolved-missing-timestamp",
    eventType: "EMAIL_DELIVERY_DEGRADATION",
    presentationClass: "INCIDENT",
    lifecycle: "RESOLVED",
    resolvedAt: null,
  })).rejects.toThrow(/TvEventOccurrence_lifecycle_class_check/);
  await expect(insertOccurrence(sql, {
    tenancyId: ctx.first.tenancyId,
    deduplicationKey: "invalid-celebration-resolution-timestamp",
    eventType: "USER_MILESTONE",
    presentationClass: "CELEBRATION",
    lifecycle: "OCCURRED",
    resolvedAt: new Date(),
  })).rejects.toThrow(/TvEventOccurrence_lifecycle_class_check/);

  const invalidClasses = [
    ["USER_MILESTONE", "INCIDENT", "ACTIVE"],
    ["USER_MILESTONE", "CRITICAL_INCIDENT", "ACTIVE"],
    ["EMAIL_DELIVERY_DEGRADATION", "CELEBRATION", "OCCURRED"],
  ] as const;
  for (const [eventType, presentationClass, lifecycle] of invalidClasses) {
    await expect(insertOccurrence(sql, {
      tenancyId: ctx.first.tenancyId,
      deduplicationKey: `invalid-class-${eventType}-${presentationClass}`,
      eventType,
      presentationClass,
      lifecycle,
    })).rejects.toThrow(/TvEventOccurrence_event_type_class_check/);
  }

  const activeOccurrenceId = await insertOccurrence(sql, {
    tenancyId: ctx.first.tenancyId,
    deduplicationKey: "active-email-occurrence",
    eventType: "EMAIL_DELIVERY_DEGRADATION",
    presentationClass: "INCIDENT",
    lifecycle: "ACTIVE",
  });
  await sql`
    INSERT INTO "TvEventEvaluatorState" (
      "tenancyId", "evaluatorKey", "nextEvaluationAt", "typedState",
      "activeOccurrenceId", "updatedAt"
    )
    VALUES (
      ${ctx.first.tenancyId}::uuid, 'email-delivery', NOW(), '{}'::jsonb,
      ${activeOccurrenceId}::uuid, NOW()
    )
  `;
  await sql`
    INSERT INTO "TvProfileEventPresentation" (
      "tenancyId", "profileId", "occurrenceId", "updatedAt"
    )
    VALUES (
      ${ctx.first.tenancyId}::uuid, 'company-pulse',
      ${activeOccurrenceId}::uuid, NOW()
    )
  `;

  expect(await sql`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conname = 'TvEventEvaluatorState_activeOccurrence_fkey'
  `).toEqual([{
    definition: expect.stringContaining('ON DELETE SET NULL ("activeOccurrenceId")'),
  }]);

  await expect(sql`
    INSERT INTO "TvEventEvaluatorState" (
      "tenancyId", "evaluatorKey", "nextEvaluationAt", "typedState",
      "activeOccurrenceId", "updatedAt"
    )
    VALUES (
      ${ctx.second.tenancyId}::uuid, 'cross-tenant-email', NOW(), '{}'::jsonb,
      ${activeOccurrenceId}::uuid, NOW()
    )
  `).rejects.toThrow(/TvEventEvaluatorState_activeOccurrence_fkey/);
  await expect(sql`
    INSERT INTO "TvProfileEventPresentation" (
      "tenancyId", "profileId", "occurrenceId", "updatedAt"
    )
    VALUES (
      ${ctx.second.tenancyId}::uuid, 'company-pulse',
      ${activeOccurrenceId}::uuid, NOW()
    )
  `).rejects.toThrow(/TvProfileEventPresentation_occurrence_fkey/);

  await sql`
    DELETE FROM "TvEventOccurrence"
    WHERE "tenancyId" = ${ctx.first.tenancyId}::uuid
      AND "id" = ${activeOccurrenceId}::uuid
  `;
  expect(await sql`
    SELECT "activeOccurrenceId" FROM "TvEventEvaluatorState"
    WHERE "tenancyId" = ${ctx.first.tenancyId}::uuid
      AND "evaluatorKey" = 'email-delivery'
  `).toEqual([{ activeOccurrenceId: null }]);
  expect(await sql`
    SELECT 1 FROM "TvProfileEventPresentation"
    WHERE "tenancyId" = ${ctx.first.tenancyId}::uuid
      AND "occurrenceId" = ${activeOccurrenceId}::uuid
  `).toHaveLength(0);

  const tenantCascadeOccurrenceId = await insertOccurrence(sql, {
    tenancyId: ctx.second.tenancyId,
    deduplicationKey: "tenant-cascade-occurrence",
    eventType: "EMAIL_DELIVERY_DEGRADATION",
    presentationClass: "CRITICAL_INCIDENT",
    lifecycle: "ACTIVE",
  });
  await sql`
    INSERT INTO "TvEventEvaluatorState" (
      "tenancyId", "evaluatorKey", "nextEvaluationAt", "typedState",
      "activeOccurrenceId", "updatedAt"
    )
    VALUES (
      ${ctx.second.tenancyId}::uuid, 'email-delivery', NOW(), '{}'::jsonb,
      ${tenantCascadeOccurrenceId}::uuid, NOW()
    )
  `;
  await sql`DELETE FROM "Tenancy" WHERE "id" = ${ctx.second.tenancyId}::uuid`;
  expect(await sql`
    SELECT 1 FROM "TvEventOccurrence"
    WHERE "tenancyId" = ${ctx.second.tenancyId}::uuid
  `).toHaveLength(0);
  expect(await sql`
    SELECT 1 FROM "TvEventEvaluatorState"
    WHERE "tenancyId" = ${ctx.second.tenancyId}::uuid
  `).toHaveLength(0);
};
