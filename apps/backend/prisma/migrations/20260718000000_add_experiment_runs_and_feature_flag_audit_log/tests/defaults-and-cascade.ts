import { randomUUID } from 'crypto';
import type { Sql } from 'postgres';
import { expect } from 'vitest';

export const preMigration = async (sql: Sql) => {
  const projectId = `test-project-${randomUUID()}`;
  await sql`INSERT INTO "Project" ("id", "displayName", "isProductionMode", "updatedAt") VALUES (${projectId}, 'Experiment defaults test', false, NOW())`;
  return { projectId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const { projectId } = ctx;

  // Minimal insert exercises the defaults: state DRAFT, revisionNumber 1, createdAt now.
  const runId = randomUUID();
  await sql`
    INSERT INTO "ExperimentRun" ("id", "projectId", "branchId", "experimentId", "configRevisionHash", "configSnapshot", "updatedAt")
    VALUES (${runId}::uuid, ${projectId}, 'main', 'exp-1', 'hash-1', '{"flag_id":"f"}'::jsonb, NOW())
  `;
  const runs = await sql`SELECT "state", "revisionNumber", "createdAt", "scheduledStartAt", "startedAt", "createdByUserId" FROM "ExperimentRun" WHERE "id" = ${runId}::uuid`;
  expect(runs).toHaveLength(1);
  expect(runs[0].state).toBe('DRAFT');
  expect(Number(runs[0].revisionNumber)).toBe(1);
  expect(runs[0].createdAt).toBeInstanceOf(Date);
  expect(runs[0].scheduledStartAt).toBeNull();
  expect(runs[0].startedAt).toBeNull();
  expect(runs[0].createdByUserId).toBeNull();

  // Different experiments cannot concurrently assign the same frozen flag.
  await sql`
    INSERT INTO "ExperimentRun" ("id", "projectId", "branchId", "experimentId", "configRevisionHash", "configSnapshot", "state", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${projectId}, 'main', 'active-exp-1', 'active-hash-1', '{"flag_id":"shared-flag"}'::jsonb, 'RUNNING', NOW())
  `;
  await expect(sql`
    INSERT INTO "ExperimentRun" ("id", "projectId", "branchId", "experimentId", "configRevisionHash", "configSnapshot", "state", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${projectId}, 'main', 'active-exp-2', 'active-hash-2', '{"flag_id":"shared-flag"}'::jsonb, 'PAUSED', NOW())
  `).rejects.toThrow(/ExperimentRun_active_flag_key/);

  // Only the four known states are accepted.
  await expect(sql`
    INSERT INTO "ExperimentRun" ("id", "projectId", "branchId", "experimentId", "configRevisionHash", "configSnapshot", "state", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${projectId}, 'main', 'exp-2', 'hash-2', '{}'::jsonb, 'ARCHIVED'::"ExperimentRunState", NOW())
  `).rejects.toThrow(/invalid input value for enum/);

  // An unknown project is rejected by the foreign key.
  await expect(sql`
    INSERT INTO "ExperimentRun" ("id", "projectId", "branchId", "experimentId", "configRevisionHash", "configSnapshot", "updatedAt")
    VALUES (${randomUUID()}::uuid, ${'nonexistent-' + randomUUID()}, 'main', 'exp-3', 'hash-3', '{}'::jsonb, NOW())
  `).rejects.toThrow(/ExperimentRun_projectId_fkey/);

  const receiptId = randomUUID();
  const eventId = randomUUID();
  const evaluationId = randomUUID();
  const batchId = randomUUID();
  const nonce = randomUUID();
  await sql`
    INSERT INTO "FeatureFlagExposureReceipt" ("id", "projectId", "branchId", "eventId", "evaluationId", "batchId", "batchPayloadHash", "ingestionNonce")
    VALUES (${receiptId}::uuid, ${projectId}, 'main', ${eventId}::uuid, ${evaluationId}::uuid, ${batchId}::uuid, 'sha256:batch', ${nonce}::uuid)
  `;
  const exposureReceipts = await sql`
    SELECT "processingStartedAt", "billingNonce", "billingStartedAt", "billingCompletedAt", "completedAt"
    FROM "FeatureFlagExposureReceipt" WHERE "id" = ${receiptId}::uuid
  `;
  expect(exposureReceipts).toHaveLength(1);
  expect(exposureReceipts[0].processingStartedAt).toBeNull();
  expect(exposureReceipts[0].billingNonce).toBeNull();
  expect(exposureReceipts[0].billingStartedAt).toBeNull();
  expect(exposureReceipts[0].billingCompletedAt).toBeNull();
  expect(exposureReceipts[0].completedAt).toBeNull();
  await expect(sql`
    INSERT INTO "FeatureFlagExposureReceipt" ("id", "projectId", "branchId", "eventId", "evaluationId", "batchId", "batchPayloadHash", "ingestionNonce")
    VALUES (${randomUUID()}::uuid, ${projectId}, 'main', ${eventId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'sha256:other', ${randomUUID()}::uuid)
  `).rejects.toThrow(/FeatureFlagExposureReceipt_project_event_key/);
  await expect(sql`
    INSERT INTO "FeatureFlagExposureReceipt" ("id", "projectId", "branchId", "eventId", "evaluationId", "batchId", "batchPayloadHash", "ingestionNonce")
    VALUES (${randomUUID()}::uuid, ${projectId}, 'main', ${randomUUID()}::uuid, ${evaluationId}::uuid, ${randomUUID()}::uuid, 'sha256:other', ${randomUUID()}::uuid)
  `).rejects.toThrow(/FeatureFlagExposureReceipt_project_evaluation_key/);

  // Deleting the project cascades to every new project-owned table.
  await sql`DELETE FROM "Project" WHERE "id" = ${projectId}`;
  const remainingRuns = await sql`SELECT COUNT(*) AS count FROM "ExperimentRun" WHERE "projectId" = ${projectId}`;
  expect(Number(remainingRuns[0].count)).toBe(0);
  const remainingReceipts = await sql`SELECT COUNT(*) AS count FROM "FeatureFlagExposureReceipt" WHERE "projectId" = ${projectId}`;
  expect(Number(remainingReceipts[0].count)).toBe(0);
};
