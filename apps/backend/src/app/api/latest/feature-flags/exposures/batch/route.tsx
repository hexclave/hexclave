import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { computeExposureSubjectHash, verifyFeatureFlagEvaluationToken } from "@/lib/feature-flags/exposure-tokens";
import { EXPOSURE_RECEIPT_CLEANUP_BATCH_SIZE, EXPOSURE_RECEIPT_RETENTION_MS } from "@/lib/feature-flags/exposure-receipts";
import { arePlanLimitsEnforced, getBillingTeamId } from "@/lib/plan-entitlements";
import { getHexclaveServerApp } from "@/hexclave";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { getPrismaClientForTenancy, globalPrismaClient, retryTransaction } from "@/prisma-client";
import { ensureTeamMembershipExists } from "@/lib/request-checks";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_EXPOSURES = 500;
// Evaluation tokens are compact JWTs (~700 bytes); anything much larger is
// garbage and gets rejected before signature verification is even attempted.
const MAX_TOKEN_LENGTH = 4096;
// exposed_at_ms comes from the end user's clock; the token's issued_at and the
// receive time come from ours. Staleness and replay are already enforced by
// token expiry and the receipt ledger, so this bound only has to keep nonsense
// timestamps out of ClickHouse. It is deliberately generous because device
// clocks that are hours off are common, and an exposure that fails here would
// surface as a failed getFeatureFlag() call for that user (the SDK awaits the
// automatic exposure upload). Out-of-window exposures are dropped, not
// rejected, so the rest of the batch lands and the client moves on.
const MAX_EXPOSURE_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
// ClickHouse requests may run for up to ten minutes. A lease must outlive that
// timeout or a retry can take ownership while the first insert is still active.
const EXPOSURE_PROCESSING_LEASE_MS = 12 * 60 * 1000;

async function cleanupExpiredExposureReceipts(options: { projectId: string, branchId: string, now: Date }): Promise<void> {
  const expiresBefore = new Date(options.now.getTime() - EXPOSURE_RECEIPT_RETENTION_MS);
  // The ledger only protects the bounded offline-retry window. Delete one
  // indexed, bounded page during normal ingestion so high-volume telemetry
  // cannot grow Postgres indefinitely or trigger an unbounded cleanup query.
  await globalPrismaClient.$executeRaw`
    DELETE FROM "FeatureFlagExposureReceipt"
    WHERE "id" IN (
      SELECT "id"
      FROM "FeatureFlagExposureReceipt"
      WHERE "projectId" = ${options.projectId}
        AND "branchId" = ${options.branchId}
        AND "createdAt" < ${expiresBefore}
      ORDER BY "createdAt" ASC
      LIMIT ${EXPOSURE_RECEIPT_CLEANUP_BATCH_SIZE}
    )
  `;
}

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Upload feature flag exposure batch",
    description: "Records feature-flag exposure events. Each exposure must carry a signed evaluation token minted by the flag evaluation endpoint; the token binds the exposure to a project, subject, flag, variant, experiment run, and config revision.",
    tags: ["Feature Flags"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
      user: adaptSchema,
    }).defined(),
    body: yupObject({
      batch_id: yupString().defined().matches(UUID_RE, "Invalid batch_id"),
      exposures: yupArray(
        yupObject({
          // Client-generated idempotency key: re-sending the same event_id
          // (e.g. on retry after a network error) never double-counts.
          event_id: yupString().defined().matches(UUID_RE, "Invalid event_id"),
          exposure_token: yupString().defined().min(1).max(MAX_TOKEN_LENGTH),
          exposed_at_ms: yupNumber().defined().integer().min(0),
        }).defined(),
      ).defined().min(1).max(MAX_EXPOSURES),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      inserted: yupNumber().defined(),
      // Exposures skipped for an implausible exposed_at_ms; they were not billed.
      dropped: yupNumber().defined(),
    }).defined(),
  }),
  async handler({ auth, body }) {
    if (auth.tenancy.config.apps.installed["feature-flags"]?.enabled !== true) {
      throw new StatusError(StatusError.BadRequest, "Feature flags are not enabled for this project");
    }
    // Experiment exposures are stored in the analytics pipeline, so Analytics
    // is independently required even though regular feature flags are not.
    if (!auth.tenancy.config.apps.installed["analytics"]?.enabled) {
      throw new KnownErrors.AnalyticsNotEnabled();
    }

    const now = Date.now();

    // All-or-nothing: if any token fails verification the whole batch is
    // rejected. Combined with event_id idempotency this keeps retries simple —
    // a client can always re-send the full batch after fixing the bad entry.
    const verified = await Promise.all(body.exposures.map(async (exposure) => ({
      exposure,
      payload: await verifyFeatureFlagEvaluationToken({ token: exposure.exposure_token, tenancy: auth.tenancy }),
    })));
    const authenticatedUser = auth.user;
    if (authenticatedUser == null) {
      throw new KnownErrors.UserAuthenticationRequired();
    }
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    for (const { payload } of verified) {
      if (payload.subject_hash !== computeExposureSubjectHash({ projectId: auth.tenancy.project.id, subjectType: payload.subject_type, subjectId: payload.subject_id })) {
        throw new StatusError(StatusError.Unauthorized, "Invalid or expired feature flag evaluation token");
      }
      if (payload.subject_type === "user") {
        if (payload.subject_id !== authenticatedUser.id) {
          throw new StatusError(StatusError.Unauthorized, "Invalid or expired feature flag evaluation token");
        }
      } else {
        await ensureTeamMembershipExists(prisma, { tenancyId: auth.tenancy.id, teamId: payload.subject_id, userId: authenticatedUser.id });
      }
    }

    // The token's issued_at is the earliest instant this exposure could have
    // happened on our clock; the receive time is the latest. Anything outside
    // that span by more than the skew allowance is nonsense and is dropped.
    const plausible = verified.filter(({ exposure, payload }) => {
      const issuedAtMillis = Number(payload.issued_at_millis);
      if (!Number.isSafeInteger(issuedAtMillis)) throw new HexclaveAssertionError("A verified exposure token carried a non-integer issued_at_millis", { issuedAtMillis: payload.issued_at_millis });
      return exposure.exposed_at_ms >= issuedAtMillis - MAX_EXPOSURE_CLOCK_SKEW_MS && exposure.exposed_at_ms <= now + MAX_EXPOSURE_CLOCK_SKEW_MS;
    });
    const droppedCount = verified.length - plausible.length;
    if (plausible.length === 0) {
      return { statusCode: 200, bodyType: "json", body: { inserted: 0, dropped: droppedCount } };
    }

    // De-duplicate both caller retry IDs and signed evaluation IDs. One signed
    // evaluation represents one eligible exposure and cannot be replayed with
    // fresh caller IDs to amplify storage, quota, or experiment counts.
    const seenEventIds = new Set<string>();
    const seenEvaluationIds = new Set<string>();
    const deduped = plausible.map(({ exposure, payload }) => {
      const key = exposure.event_id.toLowerCase();
      const evaluationId = payload.evaluation_id;
      if (seenEventIds.has(key) || seenEvaluationIds.has(evaluationId)) {
        throw new StatusError(StatusError.BadRequest, "Exposure batches cannot contain duplicate event or evaluation IDs");
      }
      seenEventIds.add(key);
      seenEvaluationIds.add(evaluationId);
      return { exposure, payload };
    });
    const batchPayloadHash = createHash("sha256").update(JSON.stringify(deduped.map(({ exposure, payload }) => ({
      evaluationId: payload.evaluation_id,
      eventId: exposure.event_id.toLowerCase(),
      exposedAtMillis: exposure.exposed_at_ms,
    })).sort((left, right) => left.evaluationId < right.evaluationId ? -1 : left.evaluationId > right.evaluationId ? 1 : 0)), "utf8").digest("hex");

    const ingestionNonce = generateUuid();
    await cleanupExpiredExposureReceipts({ projectId: auth.tenancy.project.id, branchId: auth.tenancy.branchId, now: new Date(now) });
    const receipts = await retryTransaction(globalPrismaClient, async (tx) => {
      await tx.featureFlagExposureReceipt.createMany({
        data: deduped.map(({ exposure, payload }) => ({
          id: generateUuid(),
          projectId: auth.tenancy.project.id,
          branchId: auth.tenancy.branchId,
          eventId: exposure.event_id.toLowerCase(),
          evaluationId: payload.evaluation_id,
          batchId: body.batch_id.toLowerCase(),
          batchPayloadHash,
          ingestionNonce,
          processingStartedAt: new Date(now),
        })),
        skipDuplicates: true,
      });
      const reserved = await tx.featureFlagExposureReceipt.findMany({
        where: {
          projectId: auth.tenancy.project.id,
          evaluationId: { in: deduped.map(({ payload }) => payload.evaluation_id) },
        },
        select: {
          id: true,
          eventId: true,
          evaluationId: true,
          batchId: true,
          batchPayloadHash: true,
          ingestionNonce: true,
          processingStartedAt: true,
          billingStartedAt: true,
          billingCompletedAt: true,
          completedAt: true,
        },
      });
      const reservedByEvaluationId = new Map(reserved.map((receipt) => [receipt.evaluationId, receipt]));
      for (const { exposure, payload } of deduped) {
        const receipt = reservedByEvaluationId.get(payload.evaluation_id);
        if (receipt === undefined) {
          // A different evaluation already owns this caller event ID. Throwing
          // inside the transaction rolls back any siblings created above.
          throw new StatusError(StatusError.Conflict, "Exposure identifiers were already used for a different submission");
        }
        // batch_id identifies one transport attempt. SDK retries may use a new
        // batch ID, but the frozen membership hash and per-exposure IDs must be
        // byte-for-byte equivalent to the original submission.
        if (receipt.eventId !== exposure.event_id.toLowerCase() || receipt.batchPayloadHash !== batchPayloadHash) {
          throw new StatusError(StatusError.Conflict, "Exposure identifiers were already used for a different submission");
        }
      }
      return reserved;
    });
    const receiptsByEvaluationId = new Map(receipts.map((receipt) => [receipt.evaluationId, receipt]));

    const leaseExpiresBefore = new Date(now - EXPOSURE_PROCESSING_LEASE_MS);
    const unfinishedReceipts = receipts.filter((receipt) => receipt.completedAt === null);
    if (unfinishedReceipts.length === 0) {
      return { statusCode: 200, bodyType: "json", body: { inserted: 0, dropped: droppedCount } };
    }
    const alreadyOwned = unfinishedReceipts.filter((receipt) => receipt.ingestionNonce === ingestionNonce);
    let ownsWholeBatch = alreadyOwned.length === unfinishedReceipts.length;
    if (!ownsWholeBatch && alreadyOwned.length === 0 && unfinishedReceipts.every((receipt) => receipt.processingStartedAt === null || receipt.processingStartedAt < leaseExpiresBefore)) {
      const claimed = await globalPrismaClient.featureFlagExposureReceipt.updateMany({
        where: {
          id: { in: unfinishedReceipts.map((receipt) => receipt.id) },
          completedAt: null,
          OR: [{ processingStartedAt: null }, { processingStartedAt: { lt: leaseExpiresBefore } }],
        },
        data: { ingestionNonce, processingStartedAt: new Date(now) },
      });
      ownsWholeBatch = claimed.count === unfinishedReceipts.length;
      if (!ownsWholeBatch && claimed.count > 0) {
        // A concurrent claimant may have refreshed one receipt between the
        // read and this conditional update. Release this request's partial
        // claim so no retry can own only part of the frozen billing batch.
        await globalPrismaClient.featureFlagExposureReceipt.updateMany({
          where: { ingestionNonce, completedAt: null },
          data: { ingestionNonce: generateUuid(), processingStartedAt: null },
        });
      }
    }
    const accepted = ownsWholeBatch ? deduped : [];
    if (accepted.length === 0) {
      throw new StatusError(StatusError.Conflict, "This exposure batch is already being processed; retry it later");
    }

    const app = getHexclaveServerApp();
    const billingTeamId = getBillingTeamId(auth.tenancy.project);
    const billedItem = billingTeamId != null && arePlanLimitsEnforced()
      ? await app.getItem({ itemId: ITEM_IDS.analyticsEvents, teamId: billingTeamId })
      : null;
    const billingNonce = generateUuid();
    const receiptsNeedingBilling = accepted.filter(({ payload }) => {
      const receipt = receiptsByEvaluationId.get(payload.evaluation_id);
      if (receipt === undefined) throw new HexclaveAssertionError(`Exposure receipt for evaluation ${payload.evaluation_id} disappeared before billing`);
      return receipt.billingCompletedAt === null;
    }).length;
    if (billedItem != null && receiptsNeedingBilling > 0) {
      const billingReservation = await globalPrismaClient.featureFlagExposureReceipt.updateMany({
        where: { ingestionNonce, completedAt: null, billingCompletedAt: null },
        data: { billingNonce, billingStartedAt: new Date(now) },
      });
      if (billingReservation.count !== receiptsNeedingBilling) {
        throw new HexclaveAssertionError(`Reserved ${billingReservation.count} of ${receiptsNeedingBilling} exposure receipts for billing`);
      }
      // The quantity debit itself is not idempotent. billingCompletedAt below
      // is what stops a retried batch from paying again once we *know* the
      // debit landed; a debit whose response was lost in flight is the one
      // window where a retry can charge twice. Accepted for now rather than
      // adding an idempotency ledger to the payments quantity path.
      let isDebited: boolean;
      try {
        isDebited = await billedItem.tryDecreaseQuantity(accepted.length);
      } catch (error) {
        await globalPrismaClient.featureFlagExposureReceipt.updateMany({
          where: { ingestionNonce, completedAt: null },
          data: { processingStartedAt: null },
        });
        await globalPrismaClient.featureFlagExposureReceipt.updateMany({
          where: { billingNonce, completedAt: null },
          data: { billingNonce: null, billingStartedAt: null, billingCompletedAt: null },
        });
        throw error;
      }
      if (!isDebited) {
        await globalPrismaClient.featureFlagExposureReceipt.updateMany({
          where: { ingestionNonce, completedAt: null },
          data: { processingStartedAt: null },
        });
        await globalPrismaClient.featureFlagExposureReceipt.updateMany({
          where: { billingNonce, completedAt: null },
          data: { billingNonce: null, billingStartedAt: null, billingCompletedAt: null },
        });
        if (billingTeamId == null) throw new HexclaveAssertionError("An analytics billing item cannot exist without a billing team");
        throw new KnownErrors.ItemQuantityInsufficientAmount(ITEM_IDS.analyticsEvents, billingTeamId, accepted.length);
      }
      await globalPrismaClient.featureFlagExposureReceipt.updateMany({
        where: { billingNonce, completedAt: null },
        data: { billingCompletedAt: new Date(now) },
      });
    }

    const deliveryLease = await globalPrismaClient.featureFlagExposureReceipt.updateMany({
      where: { ingestionNonce, completedAt: null },
      data: { processingStartedAt: new Date() },
    });
    if (deliveryLease.count !== accepted.length) {
      throw new HexclaveAssertionError(`Only ${deliveryLease.count} of ${accepted.length} exposure receipts remained owned before delivery`);
    }

    const rows = accepted.map(({ exposure, payload }) => ({
      event_type: "$feature-flag-exposure",
      event_at: new Date(exposure.exposed_at_ms),
      data: {
        // The signed evaluation id is the analytics idempotency key. Preserve
        // the caller event id only for diagnostics; it cannot change counts.
        event_id: payload.evaluation_id,
        client_event_id: exposure.event_id.toLowerCase(),
        run_id: payload.run_id,
        config_revision_hash: payload.config_revision_hash,
        experiment_id: payload.experiment_id,
        flag_id: payload.flag_id,
        variant_id: payload.variant_id,
        subject_type: payload.subject_type,
        subject_hash: payload.subject_hash,
        rule_id: payload.rule_id,
        reason: payload.reason,
      },
      project_id: auth.tenancy.project.id,
      branch_id: auth.tenancy.branchId,
      user_id: authenticatedUser.id,
      team_id: payload.subject_type === "team" ? payload.subject_id : null,
      refresh_token_id: null,
      session_replay_id: null,
      session_replay_segment_id: null,
    }));

    const clickhouseClient = getClickhouseAdminClient();
    try {
      await clickhouseClient.insert({
        table: "analytics_internal.events",
        values: rows,
        format: "JSONEachRow",
        clickhouse_settings: {
          date_time_input_format: "best_effort",
          async_insert: 1,
        },
      });
    } catch (error) {
      // billingCompletedAt stays set on the durable receipt, so a retry
      // resumes delivery without another debit and avoids an ambiguous refund
      // if ClickHouse accepted an earlier attempt.
      await globalPrismaClient.featureFlagExposureReceipt.updateMany({
        where: { ingestionNonce, completedAt: null },
        data: { processingStartedAt: null },
      });
      throw error;
    }

    const completed = await globalPrismaClient.featureFlagExposureReceipt.updateMany({
      where: { ingestionNonce, completedAt: null },
      data: { completedAt: new Date(), processingStartedAt: null },
    });
    if (completed.count !== accepted.length) {
      throw new HexclaveAssertionError(`Only ${completed.count} of ${accepted.length} exposure receipts were marked complete after delivery`);
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: { inserted: rows.length, dropped: droppedCount },
    };
  },
});
