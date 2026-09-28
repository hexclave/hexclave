import type { Sql } from "postgres";
import { expect } from "vitest";

export const postMigration = async (sql: Sql) => {
  const tables = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN (
        'TvDisplay',
        'TvDisplayPairingChallenge',
        'TvDisplayCredential',
        'TvDisplayPairingRateLimitBucket'
      )
  `;
  expect(tables).toHaveLength(4);

  const obsoleteDisplayColumns = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'TvDisplay'
      AND column_name IN ('revokedAt', 'revokedReason')
  `;
  expect(obsoleteDisplayColumns).toHaveLength(0);

  const firstProjectId = `tv-display-project-${crypto.randomUUID()}`;
  const secondProjectId = `tv-display-project-${crypto.randomUUID()}`;
  const firstTenancyId = crypto.randomUUID();
  const secondTenancyId = crypto.randomUUID();
  const deletedDisplayId = crypto.randomUUID();
  const siblingDisplayId = crypto.randomUUID();
  const otherTenancyDisplayId = crypto.randomUUID();
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES
      (${firstProjectId}, NOW(), NOW(), 'TV Display Test A', '', true),
      (${secondProjectId}, NOW(), NOW(), 'TV Display Test B', '', true)
  `;
  await sql`
    INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization")
    VALUES
      (${firstTenancyId}, NOW(), NOW(), ${firstProjectId}, 'main', 'TRUE'::"BooleanTrue"),
      (${secondTenancyId}, NOW(), NOW(), ${secondProjectId}, 'main', 'TRUE'::"BooleanTrue")
  `;
  await sql`
    INSERT INTO "TvDisplay" (
      "id", "tenancyId", "profileId", "displayName", "pairedByAdminUserId", "updatedAt"
    ) VALUES
      (${deletedDisplayId}, ${firstTenancyId}, 'company-pulse', 'Deleted Display', ${crypto.randomUUID()}, NOW()),
      (${siblingDisplayId}, ${firstTenancyId}, 'company-pulse', 'Sibling Display', ${crypto.randomUUID()}, NOW()),
      (${otherTenancyDisplayId}, ${secondTenancyId}, 'company-pulse', 'Other Tenancy Display', ${crypto.randomUUID()}, NOW())
  `;
  await sql`
    INSERT INTO "TvDisplayCredential" (
      "id", "displayId", "familyId", "tokenHash", "expiresAt"
    ) VALUES
      (${crypto.randomUUID()}, ${deletedDisplayId}, ${crypto.randomUUID()}, ${"a".repeat(64)}, NOW() + INTERVAL '1 day'),
      (${crypto.randomUUID()}, ${deletedDisplayId}, ${crypto.randomUUID()}, ${"b".repeat(64)}, NOW() + INTERVAL '1 day'),
      (${crypto.randomUUID()}, ${siblingDisplayId}, ${crypto.randomUUID()}, ${"c".repeat(64)}, NOW() + INTERVAL '1 day'),
      (${crypto.randomUUID()}, ${otherTenancyDisplayId}, ${crypto.randomUUID()}, ${"d".repeat(64)}, NOW() + INTERVAL '1 day')
  `;

  const wrongTenancyDeletedRows = await sql`
    DELETE FROM "TvDisplay"
    WHERE "id" = ${deletedDisplayId}
      AND "tenancyId" = ${secondTenancyId}
    RETURNING "id"
  `;
  expect(wrongTenancyDeletedRows).toHaveLength(0);
  await expect(sql`SELECT 1 FROM "TvDisplay" WHERE "id" = ${deletedDisplayId}`).resolves.toHaveLength(1);
  await expect(sql`SELECT 1 FROM "TvDisplayCredential" WHERE "displayId" = ${deletedDisplayId}`).resolves.toHaveLength(2);

  const deletedRows = await sql`
    DELETE FROM "TvDisplay"
    WHERE "id" = ${deletedDisplayId}
      AND "tenancyId" = ${firstTenancyId}
    RETURNING "id"
  `;
  expect(deletedRows).toEqual([{ id: deletedDisplayId }]);
  await expect(sql`SELECT 1 FROM "TvDisplayCredential" WHERE "displayId" = ${deletedDisplayId}`).resolves.toHaveLength(0);
  await expect(sql`SELECT 1 FROM "TvDisplay" WHERE "id" = ${siblingDisplayId}`).resolves.toHaveLength(1);
  await expect(sql`SELECT 1 FROM "TvDisplayCredential" WHERE "displayId" = ${siblingDisplayId}`).resolves.toHaveLength(1);
  await expect(sql`SELECT 1 FROM "TvDisplay" WHERE "id" = ${otherTenancyDisplayId}`).resolves.toHaveLength(1);
  await expect(sql`SELECT 1 FROM "TvDisplayCredential" WHERE "displayId" = ${otherTenancyDisplayId}`).resolves.toHaveLength(1);

  await sql`DELETE FROM "Project" WHERE "id" IN (${firstProjectId}, ${secondProjectId})`;
  await expect(sql`SELECT 1 FROM "TvDisplay" WHERE "tenancyId" IN (${firstTenancyId}, ${secondTenancyId})`).resolves.toHaveLength(0);
  await expect(sql`SELECT 1 FROM "TvDisplayCredential" WHERE "displayId" IN (${siblingDisplayId}, ${otherTenancyDisplayId})`).resolves.toHaveLength(0);

  const pairingCode = "ABC12345";
  await sql`
    INSERT INTO "TvDisplayPairingChallenge" (
      "id", "pairingCode", "deviceSecretHash", "expiresAt", "updatedAt"
    ) VALUES (
      ${crypto.randomUUID()}, ${pairingCode}, ${"b".repeat(64)}, NOW() + INTERVAL '10 minutes', NOW()
    )
  `;
  await expect(sql`
    INSERT INTO "TvDisplayPairingChallenge" (
      "id", "pairingCode", "deviceSecretHash", "expiresAt", "updatedAt"
    ) VALUES (
      ${crypto.randomUUID()}, ${pairingCode}, ${"c".repeat(64)}, NOW() + INTERVAL '10 minutes', NOW()
    )
  `).rejects.toThrow();
  await sql`DELETE FROM "TvDisplayPairingChallenge" WHERE "pairingCode" = ${pairingCode}`;
};
