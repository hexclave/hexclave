import type { Sql } from "postgres";
import { expect } from "vitest";

const PROJECT_ID = "vc-team-invitation-index-test";
const TEAM_ID = "0b6c2a8e-6a55-4a0e-9a54-6f1d6f1f3c01";

export const preMigration = async (sql: Sql) => {
  // Simulate the leftover of a previously failed CREATE INDEX CONCURRENTLY run: the index exists but
  // is INVALID. The migration must drop and rebuild it instead of keeping it via IF NOT EXISTS.
  await sql`
    CREATE INDEX "VerificationCode_team_invitation_team_id_idx"
      ON "VerificationCode" ("projectId", "branchId", ("data"->>'team_id'))
      WHERE "type" = 'TEAM_INVITATION'
  `;
  await sql`
    UPDATE pg_index SET indisvalid = false
    WHERE indexrelid = '"VerificationCode_team_invitation_team_id_idx"'::regclass
  `;
  return {};
};

export const postMigration = async (sql: Sql) => {
  const indexes = await sql<{ indisvalid: boolean, indisready: boolean, definition: string }[]>`
    SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'VerificationCode_team_invitation_team_id_idx'
  `;
  expect(indexes.map(({ indisvalid, indisready, definition }) => ({
    indisvalid,
    indisready,
    definition: definition.replace(/ ON \S+\."VerificationCode"/, ' ON "VerificationCode"'),
  }))).toMatchInlineSnapshot(`
    [
      {
        "definition": "CREATE INDEX "VerificationCode_team_invitation_team_id_idx" ON "VerificationCode" USING btree ("projectId", "branchId", ((data ->> 'team_id'::text))) WHERE (type = 'TEAM_INVITATION'::"VerificationCodeType")",
        "indisready": true,
        "indisvalid": true,
      },
    ]
  `);

  // The planner must actually pick the index for the sequencer's lookup shape. Fill the project with
  // many non-invitation codes so the primary-key prefix scan is clearly the more expensive option.
  try {
    await sql`
      INSERT INTO "VerificationCode" ("projectId", "branchId", "id", "updatedAt", "type", "code", "expiresAt", "data")
      SELECT ${PROJECT_ID}, 'main', gen_random_uuid(), NOW(), 'ONE_TIME_PASSWORD', 'otp-' || g, NOW() + INTERVAL '1 day', '{}'::jsonb
      FROM generate_series(1, 5000) AS g
    `;
    await sql`
      INSERT INTO "VerificationCode" ("projectId", "branchId", "id", "updatedAt", "type", "code", "expiresAt", "data")
      SELECT ${PROJECT_ID}, 'main', gen_random_uuid(), NOW(), 'TEAM_INVITATION', 'invite-' || g, NOW() + INTERVAL '1 day',
        jsonb_build_object('team_id', CASE WHEN g = 1 THEN ${TEAM_ID} ELSE gen_random_uuid()::text END)
      FROM generate_series(1, 50) AS g
    `;
    await sql`ANALYZE "VerificationCode"`;

    const plan = await sql.unsafe<{ "QUERY PLAN": string }[]>(`
      EXPLAIN
      SELECT "id" FROM "VerificationCode"
      WHERE "projectId" = '${PROJECT_ID}'
        AND "branchId" = 'main'
        AND "type" = 'TEAM_INVITATION'
        AND "data"->>'team_id' = '${TEAM_ID}'
    `);
    expect(plan.map((row) => row["QUERY PLAN"]).join("\n")).toContain("VerificationCode_team_invitation_team_id_idx");
  } finally {
    await sql`DELETE FROM "VerificationCode" WHERE "projectId" = ${PROJECT_ID}`;
  }
};
