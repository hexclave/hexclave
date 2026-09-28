import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const postMigration = async (sql: Sql) => {
  const columns = await sql<{ column_name: string, data_type: string, is_nullable: string }[]>`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'AskHexclaveCall'
      AND column_name IN ('context', 'user', 'project')
    ORDER BY column_name
  `;
  expect(Array.from(columns)).toEqual([
    { column_name: "context", data_type: "text", is_nullable: "YES" },
    { column_name: "project", data_type: "text", is_nullable: "YES" },
    { column_name: "user", data_type: "text", is_nullable: "YES" },
  ]);

  const id = randomUUID();
  await sql`
    INSERT INTO "AskHexclaveCall" (
      "id", "transport", "conversationId", "question", "response", "reason",
      "userPrompt", "context", "user", "project", "modelId", "stepCount",
      "durationMs", "innerToolCalls"
    )
    VALUES (
      ${id}::uuid, 'skill-ask', 'conversation-1', 'How do I configure OAuth?',
      'Configure an OAuth provider.', 'OAuth documentation was needed.',
      'Help me configure OAuth.', 'Adding authentication to a dashboard.',
      'Ada Lovelace', 'Analytical Engine dashboard, TypeScript and Next.js',
      'test-model', 2, 123, '[]'::jsonb
    )
  `;

  const rows = await sql<{ context: string | null, user: string | null, project: string | null }[]>`
    SELECT "context", "user", "project"
    FROM "AskHexclaveCall"
    WHERE "id" = ${id}::uuid
  `;
  expect(rows).toEqual([{
    context: "Adding authentication to a dashboard.",
    user: "Ada Lovelace",
    project: "Analytical Engine dashboard, TypeScript and Next.js",
  }]);

  const nullableId = randomUUID();
  await sql`
    INSERT INTO "AskHexclaveCall" (
      "id", "transport", "conversationId", "question", "response", "reason",
      "userPrompt", "modelId", "stepCount", "durationMs", "innerToolCalls"
    )
    VALUES (
      ${nullableId}::uuid, 'mcp-ask-hexclave', 'conversation-2', 'Question',
      'Response', 'Reason', 'Prompt', 'test-model', 1, 0, '[]'::jsonb
    )
  `;

  const nullableRows = await sql<{ context: string | null, user: string | null, project: string | null }[]>`
    SELECT "context", "user", "project"
    FROM "AskHexclaveCall"
    WHERE "id" = ${nullableId}::uuid
  `;
  expect(nullableRows).toEqual([{ context: null, user: null, project: null }]);
};
