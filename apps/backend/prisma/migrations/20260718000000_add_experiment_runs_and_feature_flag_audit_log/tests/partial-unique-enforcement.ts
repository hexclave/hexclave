import { randomUUID } from 'crypto';
import type { Sql } from 'postgres';
import { expect } from 'vitest';

export const preMigration = async (sql: Sql) => {
  // The new tables reference Project, so create one before the migration runs.
  const projectId = `test-project-${randomUUID()}`;
  await sql`INSERT INTO "Project" ("id", "displayName", "isProductionMode", "updatedAt") VALUES (${projectId}, 'Experiment migration test', false, NOW())`;
  return { projectId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const { projectId } = ctx;
  const experimentId = 'checkout-experiment';

  const insertRun = async (state: string, branchId = 'main', experiment = experimentId) => {
    const id = randomUUID();
    await sql`
      INSERT INTO "ExperimentRun" ("id", "projectId", "branchId", "experimentId", "configRevisionHash", "configSnapshot", "state", "updatedAt")
      VALUES (${id}::uuid, ${projectId}, ${branchId}, ${experiment}, 'hash-abc', '{"flagId":"my-flag"}'::jsonb, ${state}::"ExperimentRunState", NOW())
    `;
    return id;
  };

  // A RUNNING run can be created...
  const runningId = await insertRun('RUNNING');

  // ...but a second RUNNING or PAUSED run for the same project+branch+experiment is rejected.
  await expect(insertRun('RUNNING')).rejects.toThrow(/ExperimentRun_active_run_key/);
  await expect(insertRun('PAUSED')).rejects.toThrow(/ExperimentRun_active_run_key/);

  // DRAFT and COMPLETED runs are outside the partial index and can coexist freely.
  await insertRun('DRAFT');
  await insertRun('DRAFT');
  await insertRun('COMPLETED');
  await insertRun('COMPLETED');

  // A different experiment or a different branch is unaffected.
  await insertRun('RUNNING', 'main', 'other-experiment');
  await insertRun('RUNNING', 'preview', experimentId);

  // Transitioning RUNNING -> PAUSED keeps occupying the "active" slot...
  await sql`UPDATE "ExperimentRun" SET "state" = 'PAUSED' WHERE "id" = ${runningId}::uuid`;
  await expect(insertRun('RUNNING')).rejects.toThrow(/ExperimentRun_active_run_key/);

  // ...and completing it frees the slot for a new active run.
  await sql`UPDATE "ExperimentRun" SET "state" = 'COMPLETED' WHERE "id" = ${runningId}::uuid`;
  await insertRun('RUNNING');

  const activeRuns = await sql`
    SELECT COUNT(*) AS count FROM "ExperimentRun"
    WHERE "projectId" = ${projectId} AND "branchId" = 'main' AND "experimentId" = ${experimentId}
      AND "state" IN ('RUNNING', 'PAUSED')
  `;
  expect(Number(activeRuns[0].count)).toBe(1);
};
