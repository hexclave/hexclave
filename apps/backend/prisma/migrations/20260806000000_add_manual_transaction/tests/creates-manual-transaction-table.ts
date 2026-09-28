import { randomUUID } from "crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const preMigration = async (_sql: Sql) => {
  return {};
};

export const postMigration = async (sql: Sql) => {
  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'ManualTransaction'
  `;
  expect(Array.from(tables)).toMatchInlineSnapshot(`
    [
      {
        "table_name": "ManualTransaction",
      },
    ]
  `);

  const tenancyId = randomUUID();
  const txnId = `refund:sub-start:${randomUUID()}:${randomUUID()}`;

  await sql`
    INSERT INTO "ManualTransaction" (
      "tenancyId", "txnId", "type", "customerId", "customerType",
      "paymentProvider", "effectiveAt", "createdAt", "entries"
    )
    VALUES (
      ${tenancyId}::uuid,
      ${txnId},
      'refund',
      'user-1',
      'USER'::"CustomerType",
      'stripe',
      NOW(),
      NOW(),
      '[{"type":"money-transfer","customerType":"user","customerId":"user-1","chargedAmount":{"USD":"-1.00"}}]'::jsonb
    )
  `;

  // Composite primary key rejects duplicates.
  await expect(sql`
    INSERT INTO "ManualTransaction" (
      "tenancyId", "txnId", "type", "customerId", "customerType",
      "paymentProvider", "effectiveAt", "createdAt", "entries"
    )
    VALUES (
      ${tenancyId}::uuid,
      ${txnId},
      'refund',
      'user-1',
      'USER'::"CustomerType",
      'stripe',
      NOW(),
      NOW(),
      '[]'::jsonb
    )
  `).rejects.toThrow(/ManualTransaction_pkey/);

  // Same txnId under a different tenancy is allowed.
  await sql`
    INSERT INTO "ManualTransaction" (
      "tenancyId", "txnId", "type", "customerId", "customerType",
      "paymentProvider", "effectiveAt", "createdAt", "entries"
    )
    VALUES (
      ${randomUUID()}::uuid,
      ${txnId},
      'refund',
      'user-2',
      'TEAM'::"CustomerType",
      NULL,
      NOW(),
      NOW(),
      '[]'::jsonb
    )
  `;

  await expect(sql`
    INSERT INTO "ManualTransaction" (
      "tenancyId", "txnId", "type", "customerId", "customerType",
      "paymentProvider", "effectiveAt", "createdAt", "entries"
    )
    VALUES (
      ${randomUUID()}::uuid,
      ${`refund:${randomUUID()}`},
      'refund',
      'user-3',
      'NOT_A_TYPE'::"CustomerType",
      NULL,
      NOW(),
      NOW(),
      '[]'::jsonb
    )
  `).rejects.toThrow();
};
