import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `phone-contact-channel-test-${randomUUID()}`;
  const tenancyId = randomUUID();
  const userId1 = randomUUID();
  const userId2 = randomUUID();

  await sql`INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode") VALUES (${projectId}, NOW(), NOW(), 'Test', '', false)`;
  await sql`INSERT INTO "Tenancy" ("id", "createdAt", "updatedAt", "projectId", "branchId", "hasNoOrganization") VALUES (${tenancyId}::uuid, NOW(), NOW(), ${projectId}, 'main', 'TRUE'::"BooleanTrue")`;
  for (const userId of [userId1, userId2]) {
    await sql`INSERT INTO "ProjectUser" ("projectUserId", "tenancyId", "mirroredProjectId", "mirroredBranchId", "createdAt", "updatedAt", "lastActiveAt") VALUES (${userId}::uuid, ${tenancyId}::uuid, ${projectId}, 'main', NOW(), NOW(), NOW())`;
  }

  // An existing primary email channel must be unaffected by the migration
  await sql`
    INSERT INTO "ContactChannel" ("tenancyId", "projectUserId", "id", "createdAt", "updatedAt", "type", "isPrimary", "usedForAuth", "isVerified", "value")
    VALUES (${tenancyId}::uuid, ${userId1}::uuid, ${randomUUID()}::uuid, NOW(), NOW(), 'EMAIL', 'TRUE', 'TRUE', true, 'user1@example.com')
  `;

  return { projectId, tenancyId, userId1, userId2 };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  const enumLabels = await sql<{ enumlabel: string }[]>`
    SELECT enumlabel FROM pg_enum WHERE enumtypid = '"ContactChannelType"'::regtype ORDER BY enumsortorder
  `;
  expect(enumLabels.map((r) => r.enumlabel)).toEqual(["EMAIL", "PHONE"]);

  const verificationCodeTypes = await sql<{ enumlabel: string }[]>`
    SELECT enumlabel FROM pg_enum
    WHERE enumtypid = '"VerificationCodeType"'::regtype AND enumlabel IN ('SMS_ONE_TIME_PASSWORD', 'PHONE_NUMBER_VERIFICATION')
    ORDER BY enumlabel
  `;
  expect(verificationCodeTypes.map((r) => r.enumlabel)).toEqual(["PHONE_NUMBER_VERIFICATION", "SMS_ONE_TIME_PASSWORD"]);

  const insertPhone = async (userId: string, value: string, options: { isPrimary: boolean, usedForAuth: boolean }) => {
    await sql`
      INSERT INTO "ContactChannel" ("tenancyId", "projectUserId", "id", "createdAt", "updatedAt", "type", "isPrimary", "usedForAuth", "isVerified", "value")
      VALUES (
        ${ctx.tenancyId}::uuid, ${userId}::uuid, ${randomUUID()}::uuid, NOW(), NOW(), 'PHONE',
        ${options.isPrimary ? "TRUE" : null}::"BooleanTrue", ${options.usedForAuth ? "TRUE" : null}::"BooleanTrue", true, ${value}
      )
    `;
  };

  try {
    // A user can have a primary phone alongside their primary email (the primary uniqueness is per type)
    await insertPhone(ctx.userId1, "+15555550100", { isPrimary: true, usedForAuth: true });

    // ...but not two primary phones
    await expect(insertPhone(ctx.userId1, "+15555550101", { isPrimary: true, usedForAuth: false })).rejects.toThrow(/unique/i);

    // The same phone number can't be used for auth by two users in the same tenancy
    await expect(insertPhone(ctx.userId2, "+15555550100", { isPrimary: true, usedForAuth: true })).rejects.toThrow(/unique/i);

    // ...but it can be attached to another user if it is not used for auth
    await insertPhone(ctx.userId2, "+15555550100", { isPrimary: true, usedForAuth: false });

    // A phone number and an email with the same string value don't conflict, since uniqueness is scoped by type
    await insertPhone(ctx.userId1, "user1@example.com", { isPrimary: false, usedForAuth: true });

    const rows = await sql<{ type: string, value: string, isPrimary: string | null }[]>`
      SELECT "type", "value", "isPrimary" FROM "ContactChannel"
      WHERE "tenancyId" = ${ctx.tenancyId}::uuid AND "projectUserId" = ${ctx.userId1}::uuid
      ORDER BY "type", "value"
    `;
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { type: "EMAIL", value: "user1@example.com", isPrimary: "TRUE" },
      { type: "PHONE", value: "+15555550100", isPrimary: "TRUE" },
      { type: "PHONE", value: "user1@example.com", isPrimary: null },
    ]);
  } finally {
    await sql`DELETE FROM "Project" WHERE "id" = ${ctx.projectId}`;
  }
};
