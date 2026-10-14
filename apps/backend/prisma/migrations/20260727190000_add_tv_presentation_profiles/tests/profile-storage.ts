import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `test-${randomUUID()}`;
  const tenancyId = randomUUID();
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'TV Profile Migration Test', '', false)
  `;
  await sql`
    INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
    VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue")
  `;
  return { tenancyId };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const playlist = JSON.stringify([{ screenId: "live-pulse", durationSecondsOverride: 15 }]);
  const preferences = JSON.stringify({
    incidentLevels: { critical: "persistent-takeover", high: "temporary-takeover", medium: "banner" },
    incidentTypes: { emailDeliveryDegradation: true },
    celebrations: { userMilestone: true, revenueMilestone: false },
  });
  const profileId = randomUUID();

  await sql`
    INSERT INTO "TvPresentationProfile" (
      "id", "tenancyId", "displayName", "normalizedDisplayName",
      "defaultDurationSeconds", "playlist", "interruptionPreferences", "updatedAt"
    )
    VALUES (
      ${profileId}::uuid, ${ctx.tenancyId}::uuid, 'Lobby TV', 'lobby tv',
      20, ${playlist}::jsonb, ${preferences}::jsonb, NOW()
    )
  `;

  await expect(sql`
    INSERT INTO "TvPresentationProfile" (
      "tenancyId", "displayName", "normalizedDisplayName",
      "defaultDurationSeconds", "playlist", "interruptionPreferences", "updatedAt"
    )
    VALUES (
      ${ctx.tenancyId}::uuid, 'LOBBY TV', 'lobby tv',
      20, ${playlist}::jsonb, ${preferences}::jsonb, NOW()
    )
  `).rejects.toThrow(/TvPresentationProfile_tenancy_name_key/);

  const rows = await sql`
    SELECT "version", "financialVisibility"
    FROM "TvPresentationProfile"
    WHERE "id" = ${profileId}::uuid
  `;
  expect(Array.from(rows)).toEqual([{ version: 1, financialVisibility: "REDACTED" }]);

  await sql`DELETE FROM "Tenancy" WHERE "id" = ${ctx.tenancyId}::uuid`;
  const afterCascade = await sql`
    SELECT 1 FROM "TvPresentationProfile" WHERE "id" = ${profileId}::uuid
  `;
  expect(afterCascade).toHaveLength(0);
};
