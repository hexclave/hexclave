import type { Sql } from "postgres";
import { expect } from "vitest";

export const postMigration = async (sql: Sql) => {
  const columns = await sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND ((table_name = 'SubscriptionInvoice' AND column_name IN ('paidAt', 'markedUncollectibleAt', 'voidedAt', 'currency', 'amountPaid'))
        OR (table_name = 'OneTimePurchase' AND column_name IN ('amountReceived', 'currency', 'paidAt')))
  `;
  expect(columns).toHaveLength(8);
};
