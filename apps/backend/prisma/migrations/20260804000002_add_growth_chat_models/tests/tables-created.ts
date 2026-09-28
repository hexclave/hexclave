import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

// Both tables in this migration are new, so preMigration only has to prove that the migration
// applies on a database that already has data (a project row) without disturbing it.
export const preMigration = async (sql: Sql) => {
  const projectId = `growth-chat-tables-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth chat models migration test', '', false)
  `;
  return { projectId };
};

export const postMigration = async (sql: Sql, context: Awaited<ReturnType<typeof preMigration>>) => {
  const { projectId } = context;

  const tables = await sql<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('GrowthChatConversation', 'GrowthChatMessage')
  `;
  expect(tables.map((row) => row.table_name).sort()).toEqual(["GrowthChatConversation", "GrowthChatMessage"]);

  const columnsOf = async (table: string) => (await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY column_name
  `).map((row) => row.column_name);

  expect(await columnsOf("GrowthChatConversation")).toEqual([
    "branchId", "createdAt", "id", "projectId", "title", "updatedAt",
  ]);
  expect(await columnsOf("GrowthChatMessage")).toEqual([
    "content", "conversationId", "createdAt", "id", "position", "role",
  ]);

  // A conversation is insertable with only the columns lib/growth/chat.ts actually supplies; id and
  // createdAt default.
  const [conversation] = await sql<{ id: string, title: string }[]>`
    INSERT INTO "GrowthChatConversation" ("projectId", "branchId", "title", "updatedAt")
    VALUES (${projectId}, 'main', 'How is retention trending?', NOW())
    RETURNING "id"::text AS id, "title"
  `;
  expect(conversation.title).toBe("How is retention trending?");

  // One turn is a user message followed by an assistant message, both carrying opaque UIMessage JSON.
  await sql`
    INSERT INTO "GrowthChatMessage" ("conversationId", "position", "role", "content")
    VALUES
      (${conversation.id}::uuid, 0, 'user', ${sql.json({ id: randomUUID(), role: "user", parts: [{ type: "text", text: "hi" }] })}),
      (${conversation.id}::uuid, 1, 'assistant', ${sql.json({ id: randomUUID(), role: "assistant", parts: [{ type: "text", text: "hello" }] })})
  `;
  const messages = await sql<{ role: string, position: number }[]>`
    SELECT "role", "position" FROM "GrowthChatMessage"
    WHERE "conversationId" = ${conversation.id}::uuid
    ORDER BY "position" ASC
  `;
  expect(messages).toMatchObject([{ role: "user", position: 0 }, { role: "assistant", position: 1 }]);

  // Deleting the project cascades conversation -> messages, so growth chat leaves nothing behind
  // when a project goes away.
  await sql`DELETE FROM "Project" WHERE "id" = ${projectId}`;
  for (const table of ["GrowthChatConversation", "GrowthChatMessage"]) {
    const leftover = await sql`SELECT 1 FROM ${sql(table)}`;
    expect(leftover.length, `${table} should have been cascaded away`).toBe(0);
  }
};
