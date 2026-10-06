import { buildTelemetryWritePlan, insertBatchEvents, normalizeBatchEvents } from "@/lib/analytics-telemetry-writers";
import { getSharedClickhouseAdminClient } from "@/lib/clickhouse";
import { arePlanLimitsEnforced, getBillingTeamId } from "@/lib/plan-entitlements";
import { tryDecreasePlanItemQuantities } from "@/lib/plan-metering";
import { findRecentSessionReplay } from "@/lib/session-replays";
import { MAX_JAVASCRIPT_TIMESTAMP_MILLIS, telemetryMeteredAt } from "@/lib/telemetry-metering-time";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { TELEMETRY_UUID_RE } from "@hexclave/shared/dist/utils/analytics-wire";
import * as zlib from "node:zlib";

const UUID_RE = TELEMETRY_UUID_RE;

const MAX_EVENTS = 500;
const MAX_COMPRESSED_BYTES = 1 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;

// Bodies sent as application/octet-stream are gzipped JSON. The encoding is
// purely to evade keyword-matching adblockers (e.g. filters on "$click").
// We gunzip + JSON.parse here so the rest of the schema can validate the
// decoded object normally.
function maybeDecodeBinaryBody(value: unknown): unknown {
  let bytes: Uint8Array | undefined;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (value instanceof Uint8Array) {
    bytes = value;
  }
  if (!bytes) return value;

  if (bytes.byteLength > MAX_COMPRESSED_BYTES) {
    throw new StatusError(StatusError.BadRequest, "Encoded analytics body too large");
  }
  let decompressed: Buffer;
  try {
    decompressed = zlib.gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch {
    throw new StatusError(StatusError.BadRequest, "Invalid encoded analytics body");
  }
  try {
    return JSON.parse(decompressed.toString("utf-8"));
  } catch {
    throw new StatusError(StatusError.BadRequest, "Invalid encoded analytics body");
  }
}

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Upload analytics event batch",
    description: "Uploads a batch of auto-captured analytics events ($page-view, $click).",
    tags: ["Analytics Events"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
      user: adaptSchema,
      refreshTokenId: adaptSchema,
    }).defined(),
    body: yupObject({
      session_replay_segment_id: yupString().defined().matches(UUID_RE, "Invalid session_replay_segment_id"),
      batch_id: yupString().defined().matches(UUID_RE, "Invalid batch_id"),
      sent_at_ms: yupNumber().defined().integer().min(0).max(MAX_JAVASCRIPT_TIMESTAMP_MILLIS),
      events: yupArray(
        yupObject({
          event_type: yupString().defined().oneOf(["$page-view", "$click"]),
          event_at_ms: yupNumber().defined().integer().min(0),
          data: yupMixed().defined(),
        }).defined(),
      ).defined().min(1).max(MAX_EVENTS),
    }).defined().transform((_value, originalValue) => maybeDecodeBinaryBody(originalValue)),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      inserted: yupNumber().defined(),
    }).defined(),
  }),
  async handler({ auth, body }) {
    if (!auth.tenancy.config.apps.installed["analytics"]?.enabled) {
      throw new KnownErrors.AnalyticsNotEnabled();
    }
    if (!auth.user) {
      throw new KnownErrors.UserAuthenticationRequired();
    }
    if (!auth.refreshTokenId) {
      throw new StatusError(StatusError.BadRequest, "A refresh token is required for analytics events");
    }

    const events = body.events;
    const tenancyId = auth.tenancy.id;
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const projectId = auth.tenancy.project.id;
    const branchId = auth.tenancy.branchId;
    const userId = auth.user.id;
    const refreshTokenId = auth.refreshTokenId;

    const recentSession = await findRecentSessionReplay(prisma, {
      tenancyId,
      refreshTokenId,
      projectUserId: userId,
    });
    const sessionReplayId = recentSession?.id ?? null;
    const sessionReplaySegmentId = body.session_replay_segment_id;

    const billingTeamId = getBillingTeamId(auth.tenancy.project);
    if (projectId !== "internal" && billingTeamId != null && arePlanLimitsEnforced()) {
      const debitResult = await tryDecreasePlanItemQuantities(billingTeamId, [
        {
          itemId: ITEM_IDS.analyticsEvents,
          quantity: events.length,
          idempotency: {
            key: `analytics-events:${tenancyId}:${body.batch_id}`,
            createdAt: telemetryMeteredAt(body.sent_at_ms, body.sent_at_ms, new Date()),
          },
        },
      ]);
      if (debitResult.insufficientItemId != null) {
        throw new KnownErrors.ItemQuantityInsufficientAmount(
          debitResult.insufficientItemId,
          billingTeamId,
          events.length,
        );
      }
    }

    const clickhouseClient = getSharedClickhouseAdminClient();

    const normalizedEvents = normalizeBatchEvents(events, {
      projectId,
      branchId,
      userId,
      refreshTokenId,
      sessionReplayId,
      sessionReplaySegmentId,
      runtime: "browser",
      resource: null,
      producer: "sdk",
      groupingConfig: auth.tenancy.config.observability.errorGrouping,
    }, body.batch_id);
    // ClickHouse failures are ambiguous: the server may have committed the
    // deduplicated batch before the transport failed. Keep the retry-stable
    // debit above rather than refunding usage that may already be durable.
    await insertBatchEvents(clickhouseClient, buildTelemetryWritePlan(normalizedEvents, body.batch_id));

    return {
      statusCode: 200,
      bodyType: "json",
      body: { inserted: events.length },
    };
  },
});
