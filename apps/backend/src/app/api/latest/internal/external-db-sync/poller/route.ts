import type { OutgoingRequest } from "@/generated/prisma/client";
import { getExternalDbSyncFusebox } from "@/lib/external-db-sync-metadata";
import { recoverStaleOutgoingRequests, type RecoverStaleResult } from "@/lib/external-db-sync-queue";
import { decodeQstashMessage } from "@/lib/qstash-outbox";
import { upstash } from "@/lib/upstash";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { traceSpan } from "@/utils/telemetry";
import {
  yupBoolean,
  yupNumber,
  yupObject,
  yupString,
  yupTuple,
} from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { wait } from "@hexclave/shared/dist/utils/promises";
import type { PublishBatchRequest } from "@upstash/qstash";

const DEFAULT_MAX_DURATION_MS = 3 * 60 * 1000;
const DIRECT_SYNC_ENV = "STACK_EXTERNAL_DB_SYNC_DIRECT";
const POLLER_CLAIM_LIMIT_ENV = "STACK_EXTERNAL_DB_SYNC_POLL_CLAIM_LIMIT";
const DEFAULT_POLL_CLAIM_LIMIT = 1000;
const STALE_REQUEST_THRESHOLD_MS = 60 * 1000;

function parseMaxDurationMs(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_DURATION_MS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new StatusError(400, "maxDurationMs must be a positive integer");
  }
  return parsed;
}

function directSyncEnabled(): boolean {
  return getEnvVariable(DIRECT_SYNC_ENV, "") === "true";
}

function getPollerClaimLimit(): number {
  const rawValue = getEnvVariable(POLLER_CLAIM_LIMIT_ENV, "");
  if (!rawValue) return DEFAULT_POLL_CLAIM_LIMIT;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HexclaveAssertionError(
      `${POLLER_CLAIM_LIMIT_ENV} must be a positive integer. Received: ${JSON.stringify(rawValue)}`
    );
  }
  return parsed;
}

export const GET = createSmartRouteHandler({
  metadata: {
    summary: "Poll outgoing requests and push to QStash",
    description:
      "Internal endpoint invoked by Vercel Cron to process pending outgoing requests.",
    tags: ["External DB Sync"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({}).nullable().optional(),
    method: yupString().oneOf(["GET"]).defined(),
    headers: yupObject({
      authorization: yupTuple([yupString().defined()]).optional(),
    }).defined(),
    query: yupObject({
      maxDurationMs: yupString().optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      ok: yupBoolean().defined(),
      requests_processed: yupNumber().defined(),
    }).defined(),
  }),
  handler: async ({ headers, query, auth }) => {
    const isAdmin = auth?.type === "admin" && auth.project.id === "internal";
    const authHeader = headers.authorization?.[0];
    if (!isAdmin && authHeader !== `Bearer ${getEnvVariable("CRON_SECRET")}`) {
      throw new StatusError(401, "Unauthorized");
    }


    return await traceSpan("external-db-sync.poller", async (span) => {
      const startTime = performance.now();
      const maxDurationMs = parseMaxDurationMs(query.maxDurationMs);
      const pollIntervalMs = 50;
      const pollerClaimLimit = getPollerClaimLimit();

      span.setAttribute("stack.external-db-sync.max-duration-ms", maxDurationMs);
      span.setAttribute("stack.external-db-sync.poll-interval-ms", pollIntervalMs);
      span.setAttribute("stack.external-db-sync.poller-claim-limit", pollerClaimLimit);

      let totalRequestsProcessed = 0;
      let totalRequestsFailed = 0;
      let iterationCount = 0;

      async function claimPendingRequests(): Promise<OutgoingRequest[]> {
        return await traceSpan("external-db-sync.poller.claimPendingRequests", async (claimSpan) => {
          const requests = await globalPrismaClient.$queryRaw<OutgoingRequest[]>`
              UPDATE "OutgoingRequest"
              SET "startedFulfillingAt" = NOW()
              WHERE "id" IN (
                SELECT id
                FROM "OutgoingRequest"
                WHERE "startedFulfillingAt" IS NULL
                LIMIT ${pollerClaimLimit}
                FOR UPDATE SKIP LOCKED
              )
              RETURNING *;
            `;
          claimSpan.setAttribute("stack.external-db-sync.claimed-count", requests.length);
          return requests;
        });
      }

      async function handleStaleRequests(): Promise<RecoverStaleResult> {
        return await traceSpan("external-db-sync.poller.handleStaleRequests", async (staleSpan) => {
          // Recovery is best-effort: any failure here must not abort the rest of the poller iteration,
          // because the loop still owns processing the pending queue.
          let result: RecoverStaleResult;
          try {
            result = await recoverStaleOutgoingRequests(STALE_REQUEST_THRESHOLD_MS);
          } catch (error) {
            staleSpan.setAttribute("stack.external-db-sync.stale-recovery-error", true);
            captureError("poller-stale-recovery-error", error);
            return { resetIds: [], deletedIds: [] };
          }
          const { resetIds, deletedIds } = result;
          const total = resetIds.length + deletedIds.length;

          staleSpan.setAttribute("stack.external-db-sync.stale-reset-count", resetIds.length);
          staleSpan.setAttribute("stack.external-db-sync.stale-deleted-count", deletedIds.length);

          if (total > 0) {
            const ID_SAMPLE_LIMIT = 10;
            captureError(
              "poller-stale-outgoing-requests",
              new HexclaveAssertionError(
                [
                  `Recovered ${total} stale outgoing request(s) (reset=${resetIds.length}, deleted=${deletedIds.length}) older than ${STALE_REQUEST_THRESHOLD_MS}ms.`,
                  `Stale rows are claims that never got cleared after publishing — the most likely cause is a poller lambda dying between the UPDATE that set startedFulfillingAt and the DELETE that should have removed the row.`,
                  `Recovery deletes the stale row if any active sibling (pending OR fresh-in-flight) already represents the work; among multiple stale rows for the same deduplicationKey it resets the oldest and deletes the rest; otherwise it resets startedFulfillingAt to NULL so the row can be re-claimed.`,
                  `If this fires repeatedly, look for nearby unhandled-promise-rejection events (which trigger process.exit(1) via the polyfill) or function-timeout signals on the external-db-sync poller route.`,
                ].join(" "),
                {
                  totalRecovered: total,
                  staleResetCount: resetIds.length,
                  staleDeletedCount: deletedIds.length,
                  staleResetIdsSample: resetIds.slice(0, ID_SAMPLE_LIMIT),
                  staleDeletedIdsSample: deletedIds.slice(0, ID_SAMPLE_LIMIT),
                  staleResetIdsSampleNote: resetIds.length > ID_SAMPLE_LIMIT
                    ? `Showing first ${ID_SAMPLE_LIMIT} of ${resetIds.length} reset ids; remainder omitted to bound payload size.`
                    : `All ${resetIds.length} reset ids included.`,
                  staleDeletedIdsSampleNote: deletedIds.length > ID_SAMPLE_LIMIT
                    ? `Showing first ${ID_SAMPLE_LIMIT} of ${deletedIds.length} deleted ids; remainder omitted to bound payload size.`
                    : `All ${deletedIds.length} deleted ids included.`,
                },
              ),
            );
          }
          return { resetIds, deletedIds };
        });
      }

      async function deleteOutgoingRequest(id: string): Promise<void> {
        await retryTransaction(globalPrismaClient, async (tx) => {
          await tx.outgoingRequest.delete({ where: { id } });
        });
      }

      async function deleteOutgoingRequests(ids: string[]): Promise<void> {
        if (ids.length === 0) return;
        await retryTransaction(globalPrismaClient, async (tx) => {
          await tx.outgoingRequest.deleteMany({ where: { id: { in: ids } } });
        });
      }
      async function processRequest(request: OutgoingRequest): Promise<void> {
        const options = decodeQstashMessage(request.qstashOptions);
        const baseUrl = getEnvVariable("NEXT_PUBLIC_SERVER_STACK_API_URL", "") || getEnvVariable("NEXT_PUBLIC_STACK_API_URL");

        let fullUrl = new URL(options.url, baseUrl).toString();

        // In dev/test, QStash runs in Docker so "localhost" won't work.
        // Replace with "host.docker.internal" to reach the host machine.
        if (getNodeEnvironment().includes("development") || getNodeEnvironment().includes("test")) {
          const url = new URL(fullUrl);
          if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
            url.hostname = "host.docker.internal";
            fullUrl = url.toString();
          }
        }

        const publishOptions: Parameters<typeof upstash.publishJSON>[0] = {
          url: fullUrl,
          body: options.body,
          flowControl: options.flowControl,
        };
        if (options.delay !== undefined) publishOptions.delay = options.delay;
        await upstash.publishJSON(publishOptions);
        await deleteOutgoingRequest(request.id);
      }

      type UpstashRequest = PublishBatchRequest<unknown>;

      function buildUpstashRequest(request: OutgoingRequest): UpstashRequest {
        const options = decodeQstashMessage(request.qstashOptions);
        const baseUrl = getEnvVariable("NEXT_PUBLIC_SERVER_STACK_API_URL", "") || getEnvVariable("NEXT_PUBLIC_STACK_API_URL");

        let fullUrl = new URL(options.url, baseUrl).toString();

        // In dev/test, QStash runs in Docker so "localhost" won't work.
        // Replace with "host.docker.internal" to reach the host machine.
        if (getNodeEnvironment().includes("development") || getNodeEnvironment().includes("test")) {
          const url = new URL(fullUrl);
          if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
            url.hostname = "host.docker.internal";
            fullUrl = url.toString();
          }
        }

        const upstashRequest: UpstashRequest = {
          url: fullUrl,
          body: options.body,
        };
        if (options.flowControl !== undefined) upstashRequest.flowControl = options.flowControl;
        if (options.delay !== undefined) upstashRequest.delay = options.delay;
        return upstashRequest;
      }

      async function processRequests(requests: OutgoingRequest[]): Promise<{ processed: number, failed: number }> {
        return await traceSpan({
          description: "external-db-sync.poller.processRequests",
          attributes: {
            "stack.external-db-sync.pending-count": requests.length,
            "stack.external-db-sync.direct-sync": directSyncEnabled(),
          },
        }, async (processSpan) => {
          let processed = 0;

          if (directSyncEnabled()) {
            let failed = 0;
            for (const request of requests) {
              try {
                await processRequest(request);
                processed++;
              } catch (error) {
                failed++;
                processSpan.setAttribute("stack.external-db-sync.iteration-error", true);
                captureError("poller-iteration-error", error);
              }
            }
            processSpan.setAttribute("stack.external-db-sync.processed-count", processed);
            processSpan.setAttribute("stack.external-db-sync.failed-count", failed);
            return { processed, failed };
          }

          if (requests.length === 0) {
            // Performance optimization: skip the upstash batch call when the
            // caller passed no claimed rows (i.e. claimPendingRequests returned
            // an empty array).
            processSpan.setAttribute("stack.external-db-sync.processed-count", 0);
            processSpan.setAttribute("stack.external-db-sync.failed-count", 0);
            return { processed: 0, failed: 0 };
          }

          try {
            const batchPayload = requests.map(buildUpstashRequest);
            await upstash.batchJSON(batchPayload);
            await deleteOutgoingRequests(requests.map((request) => request.id));
            processSpan.setAttribute("stack.external-db-sync.processed-count", requests.length);
            processSpan.setAttribute("stack.external-db-sync.failed-count", 0);
            console.log(`[Poller] Processed requests: ${requests.length}`);
            return { processed: requests.length, failed: 0 };
          } catch (error) {
            processSpan.setAttribute("stack.external-db-sync.iteration-error", true);
            captureError("poller-iteration-error", error);
            processSpan.setAttribute("stack.external-db-sync.processed-count", 0);
            processSpan.setAttribute("stack.external-db-sync.failed-count", requests.length);
            return { processed: 0, failed: requests.length };
          }
        });
      }

      type PollerIterationResult = {
        stopReason: "disabled" | null,
        processed: number,
        failed: number,
      };

      while (performance.now() - startTime < maxDurationMs) {
        const iterationResult = await traceSpan<PollerIterationResult>({
          description: "external-db-sync.poller.iteration",
          attributes: {
            "stack.external-db-sync.iteration": iterationCount + 1,
          },
        }, async (iterationSpan) => {
          const fusebox = await getExternalDbSyncFusebox();
          iterationSpan.setAttribute("stack.external-db-sync.poller-enabled", fusebox.pollerEnabled);
          if (!fusebox.pollerEnabled) {
            return { stopReason: "disabled", processed: 0, failed: 0 };
          }

          const stale = await handleStaleRequests();
          iterationSpan.setAttribute("stack.external-db-sync.stale-reset-count", stale.resetIds.length);
          iterationSpan.setAttribute("stack.external-db-sync.stale-deleted-count", stale.deletedIds.length);

          const pendingRequests = await claimPendingRequests();
          iterationSpan.setAttribute("stack.external-db-sync.pending-count", pendingRequests.length);

          const processing = await processRequests(pendingRequests);
          iterationSpan.setAttribute("stack.external-db-sync.processed-count", processing.processed);
          iterationSpan.setAttribute("stack.external-db-sync.failed-count", processing.failed);
          return { stopReason: null, ...processing };
        });

        iterationCount++;
        totalRequestsProcessed += iterationResult.processed;
        totalRequestsFailed += iterationResult.failed;

        await wait(pollIntervalMs);
      }

      span.setAttribute("stack.external-db-sync.requests-processed", totalRequestsProcessed);
      span.setAttribute("stack.external-db-sync.requests-failed", totalRequestsFailed);
      span.setAttribute("stack.external-db-sync.iterations", iterationCount);

      return {
        statusCode: 200,
        bodyType: "json" as const,
        body: {
          ok: true,
          requests_processed: totalRequestsProcessed,
        },
      };
    });
  },
});
