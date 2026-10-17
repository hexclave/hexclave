import { randomUUID } from 'crypto';
import type { Sql } from 'postgres';
import { expect } from 'vitest';

const insertSubscription = async (sql: Sql, options: {
  tenancyId: string,
  status: string,
  endedAt: Date | null,
}) => {
  const id = randomUUID();
  await sql`
    INSERT INTO "Subscription" (
      "id", "tenancyId", "customerId", "customerType", "product", "quantity",
      "stripeSubscriptionId", "status", "currentPeriodStart", "currentPeriodEnd",
      "cancelAtPeriodEnd", "endedAt", "creationSource", "createdAt", "updatedAt"
    ) VALUES (
      ${id}::uuid, ${options.tenancyId}::uuid, ${`customer-${id}`}, 'TEAM',
      ${sql.json({ displayName: 'Test Product', customerType: 'team' })}, 1,
      ${`sub_${id}`}, ${options.status}::"SubscriptionStatus",
      '2026-01-01', '2026-02-01',
      false, ${options.endedAt}, 'PURCHASE_PAGE', NOW() AT TIME ZONE 'UTC', NOW() AT TIME ZONE 'UTC'
    )
  `;
  return id;
};

export const preMigration = async (sql: Sql) => {
  const tenancyId = randomUUID();
  const existingEndedAt = new Date('2026-01-15T12:00:00Z');

  // Non-terminal rows with null endedAt: live subscriptions, must stay null.
  const activeId = await insertSubscription(sql, { tenancyId, status: 'active', endedAt: null });
  const trialingId = await insertSubscription(sql, { tenancyId, status: 'trialing', endedAt: null });
  // `incomplete` is non-terminal (Stripe expires it to incomplete_expired
  // within ~24h, which arrives via webhook) — deliberately not backfilled.
  const incompleteId = await insertSubscription(sql, { tenancyId, status: 'incomplete', endedAt: null });
  const pastDueId = await insertSubscription(sql, { tenancyId, status: 'past_due', endedAt: null });

  // Terminal row whose endedAt is already set: must keep its original value.
  const alreadyEndedId = await insertSubscription(sql, { tenancyId, status: 'canceled', endedAt: existingEndedAt });

  return { tenancyId, activeId, trialingId, incompleteId, pastDueId, alreadyEndedId, existingEndedAt };
};

export const postMigration = async (sql: Sql, ctx: Awaited<ReturnType<typeof preMigration>>) => {
  // Compare the already-set endedAt in SQL against the same JS Date param used
  // at insert time — both cross the driver's tz-naive conversion identically,
  // so equality holds regardless of the session time zone.
  const rows = await sql`
    SELECT "id", "endedAt", ("endedAt" = ${ctx.existingEndedAt}) AS "matchesOriginal"
    FROM "Subscription" WHERE "tenancyId" = ${ctx.tenancyId}::uuid
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));

  for (const id of [ctx.activeId, ctx.trialingId, ctx.incompleteId, ctx.pastDueId]) {
    expect(byId.get(id)?.endedAt).toBeNull();
  }

  expect(byId.get(ctx.alreadyEndedId)?.matchesOriginal).toBe(true);
};
