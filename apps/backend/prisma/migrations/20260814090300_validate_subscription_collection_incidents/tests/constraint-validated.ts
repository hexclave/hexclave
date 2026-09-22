import type { Sql } from "postgres";
import { expect } from "vitest";

export const postMigration = async (sql: Sql) => {
  const constraints = await sql`
    SELECT convalidated
    FROM pg_constraint
    WHERE conname = 'TvEventOccurrence_event_type_class_check'
      AND conrelid = '"TvEventOccurrence"'::regclass
  `;

  expect(constraints).toEqual([{ convalidated: true }]);
};
