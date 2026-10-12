import type { Sql } from "postgres";
import { expect } from "vitest";

export const postMigration = async (sql: Sql) => {
  const definition = await sql`
    SELECT pg_get_constraintdef(oid) AS definition, convalidated FROM pg_constraint
    WHERE conname = 'TvEventOccurrence_event_type_class_check'
      AND conrelid = '"TvEventOccurrence"'::regclass
  `;
  expect(definition).toHaveLength(1);
  expect(definition[0].definition).toContain("SUBSCRIPTION_COLLECTION_DEGRADATION");
  expect(definition[0].convalidated).toBe(false);
};
