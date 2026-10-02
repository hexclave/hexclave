import { reconcilePendingIssueAlertWorkflowDeliveries } from "@/lib/issues/issue-alerts/workflow-status";
import { reconcileIssues } from "@/lib/issues/issue-reconciler";
import { globalPrismaConnectionString } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupBoolean, yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import postgres from "postgres";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const RECONCILER_COOLDOWN_MS = 60 * 1000;

const RECONCILER_LOCK_ID = 59129036;

let lastRunAt: number | null = null;

async function withReconcilerLock<T>(fn: () => Promise<T>): Promise<{ ran: true, value: T } | { ran: false }> {
  const sql = postgres(globalPrismaConnectionString, { max: 1 });
  try {
    const connection = await sql.reserve();
    try {
      const [{ locked }] = await connection<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${RECONCILER_LOCK_ID}) AS locked`;
      if (!locked) return { ran: false };
      try {
        return { ran: true, value: await fn() };
      } finally {
        await connection`SELECT pg_advisory_unlock(${RECONCILER_LOCK_ID})`;
      }
    } finally {
      connection.release();
    }
  } finally {
    await sql.end();
  }
}

const NOT_RUN_BODY = {
  ok: true,
  ran: false,
  tenancies_scanned: 0,
  batches_repaired: 0,
  batches_deferred: 0,
  occurrences_skipped: 0,
  ledger_rows_pruned: 0,
};

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Reconcile unmaterialized issue batches",
    description: "Internal endpoint invoked by Vercel Cron to replay `$error` batches that never reached the Postgres issue ledger.",
    tags: ["Observability"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({}).nullable().optional(),
    method: yupString().oneOf(["GET"]).defined(),
    headers: yupObject({
      "authorization": yupTuple([yupString()]).defined(),
    }).defined(),
    query: yupObject({
      force: yupString().oneOf(["true", "false"]).optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      ok: yupBoolean().defined(),
      ran: yupBoolean().defined(),
      tenancies_scanned: yupNumber().defined(),
      batches_repaired: yupNumber().defined(),
      batches_deferred: yupNumber().defined(),
      occurrences_skipped: yupNumber().defined(),
      ledger_rows_pruned: yupNumber().defined(),
    }).defined(),
  }),
  handler: async ({ headers, query }) => {
    const authHeader = headers.authorization[0];
    if (authHeader !== `Bearer ${getEnvVariable('CRON_SECRET')}`) {
      throw new StatusError(401, "Unauthorized");
    }

    const nowTicks = performance.now();
    const cooling = lastRunAt !== null && nowTicks - lastRunAt < RECONCILER_COOLDOWN_MS;
    if (cooling && query.force !== "true") {
      return { statusCode: 200, bodyType: "json", body: NOT_RUN_BODY };
    }
    lastRunAt = nowTicks;

    const locked = await withReconcilerLock(async () => {
      const reconciled = await reconcileIssues();
      await reconcilePendingIssueAlertWorkflowDeliveries();
      return reconciled;
    });
    if (!locked.ran) {
      return { statusCode: 200, bodyType: "json", body: NOT_RUN_BODY };
    }
    const result = locked.value;
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        ok: true,
        ran: true,
        tenancies_scanned: result.tenanciesScanned,
        batches_repaired: result.batchesRepaired,
        batches_deferred: result.batchesDeferred,
        occurrences_skipped: result.occurrencesSkipped,
        ledger_rows_pruned: result.ledgerRowsPruned,
      },
    };
  },
});
