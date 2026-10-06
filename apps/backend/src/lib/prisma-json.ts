import type { Prisma } from "@/generated/prisma/client";

// The Prisma-typed sibling of `isRecord` from @hexclave/shared: narrows a
// stored jsonb value to a JSON object without widening it to a plain record,
// so callers keep Prisma.JsonValue field types.
export function isPrismaJsonObject(value: Prisma.JsonValue | undefined): value is Prisma.JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
