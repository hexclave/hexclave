import { expect } from "vitest";
import type { Sql } from "postgres";

export const postMigration = async (sql: Sql) => {
  const columns = await sql`
    SELECT column_name, is_nullable, data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'SubscriptionInvoice'
      AND column_name = 'paymentOutcomeEventAt'
  `;
  expect(columns).toEqual([{
    column_name: "paymentOutcomeEventAt",
    is_nullable: "YES",
    data_type: "timestamp without time zone",
  }]);
};
