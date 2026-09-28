import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

// The two generated columns on GrowthQuizGame are what make "one game under review" and "one game
// live" invariants rather than habits, so both slots get exercised here — including the transition
// that hands the live slot from one game to the next, which is the whole point of publishing.

export const preMigration = async (sql: Sql) => {
  const projectId = `growth-quiz-slots-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth quiz slot migration test', '', false)
  `;
  return { projectId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const { projectId } = context;
  const insertGame = async (status: string, options?: { gameKey?: string, branchId?: string }) => await sql<{ id: string, isUnpublished: boolean | null, isPublished: boolean | null }[]>`
    INSERT INTO "GrowthQuizGame" ("projectId", "branchId", "gameKey", "status", "questionCount", "publishedAt", "updatedAt")
    VALUES (
      ${projectId},
      ${options?.branchId ?? "main"},
      ${options?.gameKey ?? "know_your_users"},
      ${status},
      8,
      ${status === "published" ? new Date().toISOString() : null},
      NOW()
    )
    RETURNING "id"::text AS id, "isUnpublished", "isPublished"
  `;

  // ── The review slot ──
  const [generating] = await insertGame("generating");
  expect(generating.isUnpublished).toBe(true);
  expect(generating.isPublished).toBeNull();

  // Staff cannot accumulate two half-reviewed drafts for one project, in either review status.
  await expect(insertGame("generating")).rejects.toThrow(/GrowthQuizGame_unpublished_slot/);
  await expect(insertGame("draft")).rejects.toThrow(/GrowthQuizGame_unpublished_slot/);

  // ── The live slot ──
  // Publishing does not conflict with the game under review: the two slots are independent, which is
  // what lets staff prepare the next quiz while the current one is still live.
  const [published] = await insertGame("published");
  expect(published.isUnpublished).toBeNull();
  expect(published.isPublished).toBe(true);
  await expect(insertGame("published")).rejects.toThrow(/GrowthQuizGame_published_slot/);

  // Archived games are NULL in both slots, so the whole history can coexist.
  const [archived] = await insertGame("archived");
  expect(archived.isUnpublished).toBeNull();
  expect(archived.isPublished).toBeNull();
  const [failed] = await insertGame("failed");
  expect(failed.isUnpublished).toBeNull();
  expect(failed.isPublished).toBeNull();

  // A different game key, and a different branch, each get their own pair of slots.
  const [otherGame] = await insertGame("published", { gameKey: "some_future_game" });
  expect(otherGame.isPublished).toBe(true);
  const [otherBranch] = await insertGame("published", { branchId: "other-branch" });
  expect(otherBranch.isPublished).toBe(true);

  // ── The handover ──
  // Publishing the reviewed game means archiving the incumbent and promoting the draft. Done in the
  // wrong order this violates the live slot, which is exactly why publishQuizGame does both in one
  // transaction — this asserts the constraint that forces that.
  await expect(sql`UPDATE "GrowthQuizGame" SET "status" = 'published', "publishedAt" = NOW() WHERE "id" = ${generating.id}::uuid`)
    .rejects.toThrow(/GrowthQuizGame_published_slot/);
  await sql`UPDATE "GrowthQuizGame" SET "status" = 'archived' WHERE "id" = ${published.id}::uuid`;
  const [promoted] = await sql<{ isPublished: boolean | null }[]>`
    UPDATE "GrowthQuizGame" SET "status" = 'published', "publishedAt" = NOW() WHERE "id" = ${generating.id}::uuid
    RETURNING "isPublished"
  `;
  expect(promoted.isPublished).toBe(true);
  // ...and the review slot is free again for the next draft.
  const [next] = await insertGame("draft");
  expect(next.isUnpublished).toBe(true);

  // ── Vocabulary and attribution ──
  await expect(insertGame("in_review")).rejects.toThrow(/GrowthQuizGame_status_check/);
  // A published game must say when it went live — publishing is the one staff action a customer
  // sees, so it must never be anonymous.
  await expect(sql`
    INSERT INTO "GrowthQuizGame" ("projectId", "branchId", "gameKey", "status", "questionCount", "updatedAt")
    VALUES (${projectId}, 'attribution-branch', 'know_your_users', 'published', 8, NOW())
  `).rejects.toThrow(/GrowthQuizGame_published_attribution_check/);

  await sql`DELETE FROM "Project" WHERE "id" = ${projectId}`;
};
