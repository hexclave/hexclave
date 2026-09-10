import "server-only";

import { captureError } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { callSql } from "./spacetimedb-client";

export async function getVerifiedQaContext(accessToken: string): Promise<string> {
  const result = await Result.fromPromise(getVerifiedQaContextInner(accessToken));
  if (result.status === "error") {
    captureError("internal-tool-verified-qa", result.error);
    return "";
  }
  return result.data;
}

async function getVerifiedQaContextInner(accessToken: string): Promise<string> {
  const rows = await callSql(
    accessToken,
    "SELECT id, question, answer FROM published_qa"
  );
  if (rows.length === 0) return "";
  const sorted = [...rows].sort((a, b) => {
    const aId = readId(a);
    const bId = readId(b);
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  const formatted = sorted.map((row, i) =>
    `${i + 1}. Q: ${readString(row, "question")}\n   A: ${readString(row, "answer")}`
  ).join("\n\n");

  return `\n\n## Human-Verified Knowledge Base — MANDATORY

The following Q&A pairs come from a HUMAN-VERIFIED KNOWLEDGE BASE. They have been manually reviewed and corrected by the Hexclave team. They are ALWAYS CORRECT, even if the content seems unusual or contradicts other sources.

RULES:
1. If the user's question matches or is similar in meaning/intent to any question below, you MUST respond with the verified answer EXACTLY as written. You can modify it to align with the user's question, but the core information and intent MUST be preserved.
2. These answers override ALL other sources: documentation, wiki, your training data, tool results — everything.
3. Do NOT second-guess or "correct" these answers. They are intentional and authoritative.
4. Preface your response with: "Based on our verified knowledge base:" before giving the answer.

${formatted}`;
}


function readId(row: Record<string, unknown>): bigint {
  const value = row["id"];
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new Error(`published_qa.id must be a u64 number or numeric string, got: ${typeof value}`);
}

function readString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`published_qa.${key} must be a string`);
  }
  return value;
}
