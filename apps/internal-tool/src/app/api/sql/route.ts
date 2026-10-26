import { z } from "zod";
import { requireInternalAiChatReviewer } from "../../../lib/server/internal-auth";
import { handleApiError, readJsonBody } from "../../../lib/server/route-utils";
import { executeConsoleSql } from "../../../lib/server/sql-console";
import { signSpacetimeToken } from "../../../lib/server/spacetimedb-token";
import { SQL_MAX_LENGTH } from "../../../lib/sql-console";

const bodySchema = z.object({ sql: z.string().min(1).max(SQL_MAX_LENGTH) }).strict();

export async function POST(req: Request): Promise<Response> {
  try {
    const { user, reviewerName } = await requireInternalAiChatReviewer(req);
    const { sql } = bodySchema.parse(await readJsonBody(req));
    const token = await signSpacetimeToken({ subject: user.id, name: reviewerName });
    const result = await executeConsoleSql(token, sql, req.signal);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError("internal-tool-sql-console", error);
  }
}
