import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `promo-codes-tables-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Promo codes tables migration test', '', false)
  `;
  return { projectId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const { projectId } = context;

  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('PromoCode', 'PromoCodeRedemption')
  `;
  expect(tables.map((row) => row.table_name).sort()).toEqual([
    "PromoCode",
    "PromoCodeRedemption",
  ]);

  const columnsOf = async (table: string) => (await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY column_name
  `).map((row) => row.column_name);

  expect(await columnsOf("PromoCode")).toEqual([
    "applicableProductIds",
    "availabilityType",
    "codeName",
    "createdAt",
    "currency",
    "discountAmount",
    "discountType",
    "endedAt",
    "endsAt",
    "id",
    "maxRedemptions",
    "numRedemptions",
    "pausedAt",
    "pendingRedemptions",
    "startsAt",
    "stripeCouponId",
    "subscriptionBehavior",
    "subscriptionDiscountDurationMonths",
    "tenancyId",
    "updatedAt",
  ]);
  expect(await columnsOf("PromoCodeRedemption")).toEqual([
    "createdAt",
    "customerId",
    "customerType",
    "id",
    "oneTimePurchaseId",
    "promoCodeId",
    "purchaseKind",
    "status",
    "stripeDiscountId",
    "stripePaymentIntentId",
    "stripeSubscriptionId",
    "subscriptionDiscountRemovedAt",
    "subscriptionId",
    "tenancyId",
  ]);

  const tenancyId = randomUUID();
  const promoId = randomUUID();
  await sql`
    INSERT INTO "PromoCode" (
      "id", "tenancyId", "codeName", "discountType", "discountAmount",
      "subscriptionBehavior", "availabilityType", "stripeCouponId", "updatedAt"
    )
    VALUES (
      ${promoId}::uuid, ${tenancyId}::uuid, 'SUMMER25', 'percent', 25,
      'first_payment', 'always', 'coupon_test', NOW()
    )
  `;

  const redemptionId = randomUUID();
  await sql`
    INSERT INTO "PromoCodeRedemption" (
      "id", "tenancyId", "promoCodeId", "customerId", "customerType",
      "status", "purchaseKind"
    )
    VALUES (
      ${redemptionId}::uuid, ${tenancyId}::uuid, ${promoId}::uuid, 'user_1', 'USER',
      'pending', 'one_time'
    )
  `;

  await sql`DELETE FROM "PromoCode" WHERE "id" = ${promoId}::uuid`;
  const leftover = await sql`SELECT 1 FROM "PromoCodeRedemption" WHERE "id" = ${redemptionId}::uuid`;
  expect(leftover.length, "redemptions should cascade when the promo is deleted").toBe(0);

  await sql`DELETE FROM "Project" WHERE "id" = ${projectId}`;
};
