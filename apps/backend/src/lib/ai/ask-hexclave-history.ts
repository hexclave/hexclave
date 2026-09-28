import { globalPrismaClient } from "@/prisma-client";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { parseJson, type Json } from "@hexclave/shared/dist/utils/json";

export type AskHexclaveTransport = "skill-ask" | "mcp-ask-hexclave";

export type AskHexclaveRequestMetadata = {
  transport: AskHexclaveTransport,
  requestIp: string | null,
  requestIpSource: string | null,
  userAgent: string | null,
  requestHost: string | null,
  mcpProtocolVersion: string | null,
};

function parseTransport(value: string): AskHexclaveTransport {
  if (value === "skill-ask" || value === "mcp-ask-hexclave") {
    return value;
  }
  throw new HexclaveAssertionError("AskHexclaveCall has an invalid transport", { transport: value });
}

export type AskHexclaveHistoryRow = {
  id: string,
  createdAt: string,
  transport: AskHexclaveTransport,
  conversationId: string,
  question: string,
  response: string,
  reason: string,
  userPrompt: string,
  context: string | null,
  user: string | null,
  project: string | null,
  requestIp: string | null,
  requestIpSource: string | null,
  userAgent: string | null,
  requestHost: string | null,
  mcpProtocolVersion: string | null,
  modelId: string,
  stepCount: number,
  durationMs: number,
  innerToolCalls: Exclude<Json, null>,
};

function normalizeStoredJson(value: unknown): Exclude<Json, null> {
  const parsed = parseJson(JSON.stringify(value));
  if (parsed.status === "error" || parsed.data === null) {
    throw new HexclaveAssertionError("AskHexclaveCall.innerToolCalls must contain non-null JSON", {
      cause: parsed.status === "error" ? parsed.error : undefined,
    });
  }
  return parsed.data;
}

export async function logAskHexclaveCall(options: {
  id: string,
  conversationId: string,
  question: string,
  response: string,
  reason: string,
  userPrompt: string,
  context: string | null,
  user: string | null,
  project: string | null,
  requestMetadata: AskHexclaveRequestMetadata,
  modelId: string,
  stepCount: number,
  durationMs: number,
  innerToolCalls: Json[],
}): Promise<void> {
  await globalPrismaClient.askHexclaveCall.create({
    data: {
      id: options.id,
      conversationId: options.conversationId,
      question: options.question,
      response: options.response,
      reason: options.reason,
      userPrompt: options.userPrompt,
      context: options.context,
      user: options.user,
      project: options.project,
      transport: options.requestMetadata.transport,
      requestIp: options.requestMetadata.requestIp,
      requestIpSource: options.requestMetadata.requestIpSource,
      userAgent: options.requestMetadata.userAgent,
      requestHost: options.requestMetadata.requestHost,
      mcpProtocolVersion: options.requestMetadata.mcpProtocolVersion,
      modelId: options.modelId,
      stepCount: options.stepCount,
      durationMs: options.durationMs,
      innerToolCalls: options.innerToolCalls,
    },
  });
}

export async function listAskHexclaveCalls(options: {
  transport: AskHexclaveTransport | "all",
  query: string,
  cursor: string | null,
  limit: number,
}): Promise<{ calls: AskHexclaveHistoryRow[], nextCursor: string | null }> {
  const rows = await globalPrismaClient.$replica().askHexclaveCall.findMany({
    where: {
      ...(options.transport === "all" ? {} : { transport: options.transport }),
      ...(options.query === "" ? {} : {
        OR: [
          { question: { contains: options.query, mode: "insensitive" } },
          { response: { contains: options.query, mode: "insensitive" } },
          { userPrompt: { contains: options.query, mode: "insensitive" } },
          { context: { contains: options.query, mode: "insensitive" } },
          { user: { contains: options.query, mode: "insensitive" } },
          { project: { contains: options.query, mode: "insensitive" } },
          { conversationId: { contains: options.query, mode: "insensitive" } },
          { requestIp: { contains: options.query, mode: "insensitive" } },
          { userAgent: { contains: options.query, mode: "insensitive" } },
        ],
      }),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    ...(options.cursor == null ? {} : {
      cursor: { id: options.cursor },
      skip: 1,
    }),
    take: options.limit + 1,
  });
  const pageRows = rows.slice(0, options.limit);
  return {
    calls: pageRows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      transport: parseTransport(row.transport),
      conversationId: row.conversationId,
      question: row.question,
      response: row.response,
      reason: row.reason,
      userPrompt: row.userPrompt,
      context: row.context,
      user: row.user,
      project: row.project,
      requestIp: row.requestIp,
      requestIpSource: row.requestIpSource,
      userAgent: row.userAgent,
      requestHost: row.requestHost,
      mcpProtocolVersion: row.mcpProtocolVersion,
      modelId: row.modelId,
      stepCount: row.stepCount,
      durationMs: row.durationMs,
      innerToolCalls: normalizeStoredJson(row.innerToolCalls),
    })),
    nextCursor: rows.length > options.limit ? pageRows.at(-1)?.id ?? null : null,
  };
}
