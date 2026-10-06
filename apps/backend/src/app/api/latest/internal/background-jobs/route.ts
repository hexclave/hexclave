import { globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupNumber, yupObject, yupString, yupTuple, jsonSchema } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";

type BackgroundJobStatsRow = {
  job_type: string | null,
  total: bigint | number | string,
  pending: bigint | number | string,
  in_flight: bigint | number | string,
  stale: bigint | number | string,
  oldest_created_at: Date | null,
  newest_created_at: Date | null,
};

function toCountString(value: unknown, label: string): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value.toString();
  if (typeof value === "string" && /^\d+$/u.test(value)) return value;
  throwErr(`Background job stats returned an invalid ${label}`);
}

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Read durable background-job backlog",
    description: "Returns retry and age counters for the shared QStash outbox.",
    tags: ["Internal"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({}).nullable().optional(),
    method: yupString().oneOf(["GET"]).defined(),
    headers: yupObject({
      authorization: yupTuple([yupString()]).defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: jsonSchema.defined(),
  }),
  handler: async ({ headers }) => {
    if (headers.authorization[0] !== `Bearer ${getEnvVariable("CRON_SECRET")}`) {
      throw new StatusError(401, "Unauthorized");
    }

    const rows = await globalPrismaClient.$replica().$queryRaw<BackgroundJobStatsRow[]>`
      SELECT
        "qstashOptions"->'job'->>'jobType' AS job_type,
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE "startedFulfillingAt" IS NULL)::bigint AS pending,
        COUNT(*) FILTER (WHERE "startedFulfillingAt" IS NOT NULL)::bigint AS in_flight,
        COUNT(*) FILTER (
          WHERE "startedFulfillingAt" IS NOT NULL
            AND "startedFulfillingAt" < NOW() - INTERVAL '1 minute'
        )::bigint AS stale,
        MIN("createdAt") AS oldest_created_at,
        MAX("createdAt") AS newest_created_at
      FROM "OutgoingRequest"
      GROUP BY 1
      ORDER BY 1
    `;

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        ok: true,
        generated_at_millis: Date.now(),
        jobs: rows.map((row) => ({
          job_type: row.job_type,
          total: toCountString(row.total, "total"),
          pending: toCountString(row.pending, "pending"),
          in_flight: toCountString(row.in_flight, "in_flight"),
          stale: toCountString(row.stale, "stale"),
          oldest_created_at_millis: row.oldest_created_at?.getTime() ?? null,
          newest_created_at_millis: row.newest_created_at?.getTime() ?? null,
        })),
      },
    };
  },
});
