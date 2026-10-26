import "server-only";

import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { z } from "zod";
import { spacetimeDbName } from "../spacetimedb-constants";
import { spacetimedbHttpBase } from "../spacetimedb-http";
import { privateTableHint, SQL_MAX_ROWS, sqlResultSchema, validateConsoleSql, type SqlResult } from "../sql-console";
import { callReducerStrict } from "./spacetimedb-client";

const MAX_RESPONSE_BYTES = 5_000_000;
const statementSchema = z.array(z.object({
  schema: z.object({ elements: z.array(z.object({ name: z.object({ some: z.string().optional() }).nullable() })) }),
  rows: z.array(z.array(z.unknown())).max(SQL_MAX_ROWS),
})).length(1);

async function readBoundedResponse(response: Response): Promise<string> {
  if (response.body == null) throw new HexclaveAssertionError("SQL response has no body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new StatusError(StatusError.BadRequest, "Results exceed 5 MB. Select fewer columns or use a smaller LIMIT.");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function executeConsoleSql(token: string, input: string, signal: AbortSignal): Promise<SqlResult> {
  let sql: string;
  try {
    sql = validateConsoleSql(input);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new StatusError(StatusError.BadRequest, error.message);
  }
  // HTTP callers must enroll the same member identity used by the view guards.
  await callReducerStrict(token, "touch_session", []);
  const start = performance.now();
  const response = await fetch(`${spacetimedbHttpBase()}/v1/database/${encodeURIComponent(spacetimeDbName())}/sql`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Authorization: `Bearer ${token}` },
    body: sql,
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    cache: "no-store",
  });
  if (response.status === 400) {
    throw new StatusError(StatusError.BadRequest, privateTableHint(sql) ?? "Query rejected. Check SQL syntax and column names. Full-history views require the latest SpacetimeDB module.");
  }
  if (!response.ok) {
    // Upstream errors can contain module internals; never echo their bodies.
    throw new HexclaveAssertionError(`SQL console upstream failed with status ${response.status}.`);
  }
  const parsed: unknown = JSON.parse(await readBoundedResponse(response), (_key: string, value: unknown, context?: { source: string }) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      // SATS can encode u64 values as JSON numbers. Preserve their source digits
      // instead of letting JavaScript round IDs before display or export.
      if (context == null) throw new HexclaveAssertionError("Lossless SQL integers require JSON reviver source support.");
      return context.source;
    }
    return value;
  });
  const validated = statementSchema.safeParse(parsed);
  if (!validated.success) throw new HexclaveAssertionError("Unexpected SQL response shape.");
  const statement = validated.data.at(0);
  if (statement == null) throw new HexclaveAssertionError("SQL query must return one statement result.");
  const result = sqlResultSchema.safeParse({
    columns: statement.schema.elements.map((column, index) => column.name?.some ?? `column_${index + 1}`),
    rows: statement.rows,
    elapsedMs: performance.now() - start,
  });
  if (!result.success) throw new HexclaveAssertionError("Unexpected SQL result dimensions.");
  return result.data;
}
