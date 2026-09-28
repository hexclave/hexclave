import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `growth-active-run-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth active-run migration test', '', false)
  `;
  return { projectId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const { projectId } = context;
  const insertRun = async (status: string) => await sql`
    INSERT INTO "GrowthAnalysisRun" ("projectId", "branchId", "trigger", "status", "updatedAt")
    VALUES (${projectId}, 'main', 'initial', ${status}::"GrowthRunStatus", NOW())
    RETURNING "id"::text AS id, "isActive"
  `;

  // The generated column marks non-terminal runs active...
  const [first] = await insertRun("PENDING");
  expect(first.isActive).toBe(true);

  // ...and the unique index refuses a second active run for the same branch, regardless of which
  // non-terminal status it is in.
  await expect(insertRun("RUNNING")).rejects.toThrow(/GrowthAnalysisRun_active_run/);
  await expect(insertRun("AWAITING_INTERVIEW")).rejects.toThrow(/GrowthAnalysisRun_active_run/);

  // Terminal runs are NULL-active, so any number of them can coexist...
  const [completed] = await insertRun("COMPLETED");
  expect(completed.isActive).toBeNull();
  const [failed] = await insertRun("FAILED");
  expect(failed.isActive).toBeNull();

  // ...and flipping the active run to a terminal status releases the slot for the next run.
  await sql`UPDATE "GrowthAnalysisRun" SET "status" = 'CANCELLED' WHERE "id" = ${first.id}::uuid`;
  const [second] = await insertRun("RUNNING");
  expect(second.isActive).toBe(true);

  await sql`DELETE FROM "Project" WHERE "id" = ${projectId}`;
};
