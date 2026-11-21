import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (sql: Sql) => {
  const projectId = `promo-codes-constraints-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Promo codes constraints migration test', '', false)
  `;
  return { projectId };
};

const insertPromo = (sql: Sql, overrides: {
  tenancyId?: string,
  codeName?: string,
  discountType?: string,
  discountAmount?: number,
  maxRedemptions?: number | null,
  subscriptionBehavior?: string,
  subscriptionDiscountDurationMonths?: number | null,
  availabilityType?: string,
  startsAt?: Date | null,
  endsAt?: Date | null,
} = {}) => {
  const id = randomUUID();
  const tenancyId = overrides.tenancyId ?? randomUUID();
  const codeName = overrides.codeName ?? "SAVE10";
  const discountType = overrides.discountType ?? "percent";
  const discountAmount = overrides.discountAmount ?? 10;
  const maxRedemptions = overrides.maxRedemptions === undefined ? null : overrides.maxRedemptions;
  const subscriptionBehavior = overrides.subscriptionBehavior ?? "first_payment";
  const subscriptionDiscountDurationMonths = overrides.subscriptionDiscountDurationMonths === undefined
    ? null
    : overrides.subscriptionDiscountDurationMonths;
  const availabilityType = overrides.availabilityType ?? "always";
  const startsAt = overrides.startsAt === undefined ? null : overrides.startsAt;
  const endsAt = overrides.endsAt === undefined ? null : overrides.endsAt;
  return sql`
    INSERT INTO "PromoCode" (
      "id", "tenancyId", "codeName", "discountType", "discountAmount",
      "maxRedemptions", "subscriptionBehavior", "subscriptionDiscountDurationMonths",
      "availabilityType", "startsAt", "endsAt", "stripeCouponId", "updatedAt"
    )
    VALUES (
      ${id}::uuid,
      ${tenancyId}::uuid,
      ${codeName},
      ${discountType},
      ${discountAmount},
      ${maxRedemptions},
      ${subscriptionBehavior},
      ${subscriptionDiscountDurationMonths},
      ${availabilityType},
      ${startsAt},
      ${endsAt},
      'coupon_test',
      NOW()
    )
    RETURNING "id"::text AS id, "tenancyId"::text AS "tenancyId"
  `;
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const { projectId } = context;
  const tenancyId = randomUUID();

  await insertPromo(sql, { tenancyId, codeName: "UNIQUE1" });
  await expect(insertPromo(sql, { tenancyId, codeName: "UNIQUE1" }))
    .rejects.toThrow(/PromoCode_tenancyId_codeName_key/);

  await expect(insertPromo(sql, { tenancyId, codeName: "lowercase" }))
    .rejects.toThrow(/PromoCode_codeName_check/);
  await expect(insertPromo(sql, { tenancyId, codeName: "  " }))
    .rejects.toThrow(/PromoCode_codeName_check/);
  await expect(insertPromo(sql, { tenancyId, codeName: " SAVE10 " }))
    .rejects.toThrow(/PromoCode_codeName_check/);

  await expect(insertPromo(sql, { tenancyId, codeName: "ZERO", discountAmount: 0 }))
    .rejects.toThrow(/PromoCode_discountAmount_check/);
  await expect(insertPromo(sql, { tenancyId, codeName: "OVER", discountType: "percent", discountAmount: 101 }))
    .rejects.toThrow(/PromoCode_percent_max_check/);
  await expect(insertPromo(sql, { tenancyId, codeName: "CENTS", discountType: "amount", discountAmount: 10.001 }))
    .rejects.toThrow(/PromoCode_amount_decimals_check/);
  const [amountOk] = await insertPromo(sql, { tenancyId, codeName: "TWODP", discountType: "amount", discountAmount: 10.25 });
  expect(amountOk.id).toBeTruthy();

  await expect(insertPromo(sql, { tenancyId, codeName: "FIXEDBAD", subscriptionBehavior: "fixed_duration" }))
    .rejects.toThrow(/PromoCode_fixed_duration_months_check/);
  await expect(insertPromo(sql, {
    tenancyId,
    codeName: "FOREVERMONTHS",
    subscriptionBehavior: "forever",
    subscriptionDiscountDurationMonths: 3,
  })).rejects.toThrow(/PromoCode_fixed_duration_months_check/);

  await expect(insertPromo(sql, { tenancyId, codeName: "WINDOWBAD", availabilityType: "between_dates" }))
    .rejects.toThrow(/PromoCode_availability_window_check/);
  await expect(insertPromo(sql, {
    tenancyId,
    codeName: "WINDOWFLIP",
    availabilityType: "between_dates",
    startsAt: new Date("2026-12-01"),
    endsAt: new Date("2026-01-01"),
  })).rejects.toThrow(/PromoCode_availability_window_check/);

  const [ok] = await insertPromo(sql, {
    tenancyId,
    codeName: "FIXEDOK",
    subscriptionBehavior: "fixed_duration",
    subscriptionDiscountDurationMonths: 3,
  });
  expect(ok.id).toBeTruthy();

  const [windowOk] = await insertPromo(sql, {
    tenancyId,
    codeName: "WINDOWOK",
    availabilityType: "between_dates",
    startsAt: new Date("2026-06-01"),
    endsAt: new Date("2026-08-31"),
  });
  expect(windowOk.id).toBeTruthy();

  await sql`DELETE FROM "Project" WHERE "id" = ${projectId}`;
};
