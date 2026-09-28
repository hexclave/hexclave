import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { expect } from "vitest";

// The database-level guarantees the transcript relies on, each checked by trying to violate it.
export const postMigration = async (sql: Sql) => {
  const projectId = `growth-chat-constraints-${randomUUID()}`;
  await sql`
    INSERT INTO "Project" ("id", "createdAt", "updatedAt", "displayName", "description", "isProductionMode")
    VALUES (${projectId}, NOW(), NOW(), 'Growth chat constraints migration test', '', false)
  `;
  const [conversation] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthChatConversation" ("projectId", "branchId", "title", "updatedAt")
    VALUES (${projectId}, 'main', 'Constraints', NOW())
    RETURNING "id"::text AS id
  `;

  const insertMessage = (position: number, role: string) => sql`
    INSERT INTO "GrowthChatMessage" ("conversationId", "position", "role", "content")
    VALUES (${conversation.id}::uuid, ${position}, ${role}, ${sql.json({ parts: [] })})
  `;

  await insertMessage(0, "user");

  // Two turns racing on one conversation both derive the same position from a COUNT; the unique
  // index is what stops that from silently scrambling the transcript order.
  await expect(insertMessage(0, "assistant")).rejects.toThrow(/GrowthChatMessage_conversationId_position_key/);

  // Only the two roles the code can actually produce are storable.
  await expect(insertMessage(1, "system")).rejects.toThrow(/GrowthChatMessage_role_check/);
  await expect(insertMessage(-1, "user")).rejects.toThrow(/GrowthChatMessage_position_check/);

  // The same position is fine in a different conversation — the guarantee is per-conversation, not
  // global, so two chats can both have a message at position 0.
  const [otherConversation] = await sql<{ id: string }[]>`
    INSERT INTO "GrowthChatConversation" ("projectId", "branchId", "title", "updatedAt")
    VALUES (${projectId}, 'main', 'Another chat', NOW())
    RETURNING "id"::text AS id
  `;
  await sql`
    INSERT INTO "GrowthChatMessage" ("conversationId", "position", "role", "content")
    VALUES (${otherConversation.id}::uuid, 0, 'user', ${sql.json({ parts: [] })})
  `;

  // Deleting one conversation leaves the other's transcript intact (cascade is per-conversation).
  await sql`DELETE FROM "GrowthChatConversation" WHERE "id" = ${conversation.id}::uuid`;
  const surviving = await sql`
    SELECT 1 FROM "GrowthChatMessage" WHERE "conversationId" = ${otherConversation.id}::uuid
  `;
  expect(surviving).toHaveLength(1);

  await sql`DELETE FROM "Project" WHERE "id" = ${projectId}`;
};
