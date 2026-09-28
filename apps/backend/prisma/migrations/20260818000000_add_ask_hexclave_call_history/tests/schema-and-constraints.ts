import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

export const postMigration = async (sql: Sql) => {
  const columns = await sql<{ column_name: string, data_type: string, is_nullable: string }[]>`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'AskHexclaveCall'
    ORDER BY ordinal_position
  `;
  expect(Array.from(columns)).toEqual([
    { column_name: "id", data_type: "uuid", is_nullable: "NO" },
    { column_name: "createdAt", data_type: "timestamp without time zone", is_nullable: "NO" },
    { column_name: "transport", data_type: "text", is_nullable: "NO" },
    { column_name: "conversationId", data_type: "text", is_nullable: "NO" },
    { column_name: "question", data_type: "text", is_nullable: "NO" },
    { column_name: "response", data_type: "text", is_nullable: "NO" },
    { column_name: "reason", data_type: "text", is_nullable: "NO" },
    { column_name: "userPrompt", data_type: "text", is_nullable: "NO" },
    { column_name: "requestIp", data_type: "text", is_nullable: "YES" },
    { column_name: "requestIpSource", data_type: "text", is_nullable: "YES" },
    { column_name: "userAgent", data_type: "text", is_nullable: "YES" },
    { column_name: "requestHost", data_type: "text", is_nullable: "YES" },
    { column_name: "mcpProtocolVersion", data_type: "text", is_nullable: "YES" },
    { column_name: "modelId", data_type: "text", is_nullable: "NO" },
    { column_name: "stepCount", data_type: "integer", is_nullable: "NO" },
    { column_name: "durationMs", data_type: "integer", is_nullable: "NO" },
    { column_name: "innerToolCalls", data_type: "jsonb", is_nullable: "NO" },
  ]);

  const indexes = await sql<{ indexname: string, indexdef: string }[]>`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'AskHexclaveCall'
    ORDER BY indexname
  `;
  expect(Array.from(indexes).map((row) => row.indexname)).toEqual([
    "AskHexclaveCall_conversationId_createdAt_id_idx",
    "AskHexclaveCall_createdAt_id_idx",
    "AskHexclaveCall_pkey",
    "AskHexclaveCall_transport_createdAt_id_idx",
  ]);
  expect(indexes.find((row) => row.indexname === "AskHexclaveCall_createdAt_id_idx")?.indexdef)
    .toContain('"createdAt" DESC, id DESC');

  const id = randomUUID();
  await sql`
    INSERT INTO "AskHexclaveCall" (
      "id", "transport", "conversationId", "question", "response", "reason",
      "userPrompt", "requestIp", "requestIpSource", "userAgent", "requestHost",
      "mcpProtocolVersion", "modelId", "stepCount", "durationMs", "innerToolCalls"
    )
    VALUES (
      ${id}::uuid, 'mcp-ask-hexclave', 'conversation-1', 'How do I configure OAuth?',
      'Configure an OAuth provider.', 'OAuth documentation was needed.',
      'Help me configure OAuth.', '203.0.113.10', 'x-forwarded-for',
      'test-agent/1.0', 'mcp.hexclave.test', '2025-06-18', 'test-model',
      2, 123, ${sql.json([{ toolName: "docs", result: { url: "https://docs.example.test" } }])}
    )
  `;

  const rows = await sql<{
    id: string,
    transport: string,
    requestIp: string | null,
    innerToolCalls: unknown,
  }[]>`
    SELECT "id", "transport", "requestIp", "innerToolCalls"
    FROM "AskHexclaveCall"
    WHERE "id" = ${id}::uuid
  `;
  expect(rows).toEqual([{
    id,
    transport: "mcp-ask-hexclave",
    requestIp: "203.0.113.10",
    innerToolCalls: [{ toolName: "docs", result: { url: "https://docs.example.test" } }],
  }]);

  await expect(sql`
    INSERT INTO "AskHexclaveCall" (
      "transport", "conversationId", "question", "response", "reason", "userPrompt",
      "modelId", "stepCount", "durationMs", "innerToolCalls"
    )
    VALUES ('unknown', 'conversation-2', 'Question', 'Response', 'Reason', 'Prompt', 'model', 1, 1, '[]')
  `).rejects.toThrow(/AskHexclaveCall_transport_check/);

  await expect(sql`
    INSERT INTO "AskHexclaveCall" (
      "transport", "conversationId", "question", "response", "reason", "userPrompt",
      "modelId", "stepCount", "durationMs", "innerToolCalls"
    )
    VALUES ('skill-ask', 'conversation-2', 'Question', 'Response', 'Reason', 'Prompt', 'model', 0, -1, '[]')
  `).rejects.toThrow();
};
