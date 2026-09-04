import { getPrismaClientForTenancy } from "@/prisma-client";
import { uploadBytes } from "@/s3";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { Prisma } from "@/generated/prisma/client";
import { arePlanLimitsEnforced, getBillingTeamId } from "@/lib/plan-entitlements";
import { findRecentSessionReplay } from "@/lib/session-replays";
import { getHexclaveServerApp } from "@/hexclave";
import { KnownErrors } from "@hexclave/shared";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { gzip as gzipCb, gunzipSync } from "node:zlib";

const gzip = promisify(gzipCb);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_BODY_BYTES = 1_000_000;
const MAX_EVENTS = 5_000;
// Zip-bomb guard; keep in sync with the client's MAX_SINGLE_EVENT_BYTES.
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;

// Gunzips application/octet-stream bodies (the client gzips large batches);
// plain application/json bodies pass through untouched.
function decodeBinaryBody(value: unknown): unknown {
  let bytes: Uint8Array | undefined;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (value instanceof Uint8Array) {
    bytes = value;
  }
  if (!bytes) return value;

  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new StatusError(StatusError.PayloadTooLarge, `Encoded session replay body too large (max ${MAX_BODY_BYTES} bytes)`);
  }
  let decompressed: Buffer;
  try {
    decompressed = gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  } catch {
    throw new StatusError(StatusError.BadRequest, "Invalid encoded session replay body");
  }
  try {
    return JSON.parse(decompressed.toString("utf-8"));
  } catch {
    throw new StatusError(StatusError.BadRequest, "Invalid encoded session replay body");
  }
}

function extractEventTimesMs(events: unknown[], fallbackMs: number) {
  let minTs = Infinity;
  let maxTs = -Infinity;

  for (const e of events) {
    if (typeof e !== "object" || e === null) continue;
    if (!("timestamp" in e)) continue;
    const ts = (e as any).timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    minTs = Math.min(minTs, ts);
    maxTs = Math.max(maxTs, ts);
  }

  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs) || minTs > maxTs) {
    return { firstMs: fallbackMs, lastMs: fallbackMs };
  }
  return { firstMs: minTs, lastMs: maxTs };
}

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Upload rrweb session replay batch",
    description: "Uploads a batch of rrweb events for a cross-tab session replay.",
    tags: ["Session Replays"],
    hidden: true
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
      user: adaptSchema,
      refreshTokenId: adaptSchema
    }).defined(),
    body: yupObject({
      browser_session_id: yupString().defined().matches(UUID_RE, "Invalid browser_session_id"),
      session_replay_segment_id: yupString().defined().matches(UUID_RE, "Invalid session_replay_segment_id"),
      batch_id: yupString().defined().matches(UUID_RE, "Invalid batch_id"),
      started_at_ms: yupNumber().defined().integer().min(0),
      sent_at_ms: yupNumber().defined().integer().min(0),
      events: yupArray(yupMixed().defined()).defined(),
    }).defined().transform((_value, originalValue) => decodeBinaryBody(originalValue)),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      session_replay_id: yupString().defined(),
      batch_id: yupString().defined(),
      s3_key: yupString().defined(),
      deduped: yupMixed().defined(),
    }).defined(),
  }),
  async handler({ auth, body }, fullReq) {
    if (!auth.tenancy.config.apps.installed["analytics"]?.enabled) {
      throw new KnownErrors.AnalyticsNotEnabled();
    }
    if (!auth.user) {
      throw new KnownErrors.UserAuthenticationRequired();
    }
    if (!auth.refreshTokenId) {
      throw new StatusError(StatusError.BadRequest, "A refresh token is required for session replays");
    }
    const projectUserId = auth.user.id;
    const refreshTokenId = auth.refreshTokenId;

    if (fullReq.bodyBuffer.byteLength > MAX_BODY_BYTES) {
      throw new StatusError(StatusError.PayloadTooLarge, `Request body too large (max ${MAX_BODY_BYTES} bytes)`);
    }

    if (body.events.length === 0) {
      throw new StatusError(StatusError.BadRequest, "events must not be empty");
    }
    if (body.events.length > MAX_EVENTS) {
      throw new StatusError(StatusError.BadRequest, `Too many events (max ${MAX_EVENTS})`);
    }

    const browserSessionId = body.browser_session_id;
    const batchId = body.batch_id;
    const sessionReplaySegmentId = body.session_replay_segment_id;
    const tenancyId = auth.tenancy.id;

    const projectId = auth.tenancy.project.id;
    const branchId = auth.tenancy.branchId;

    const { firstMs, lastMs } = extractEventTimesMs(body.events, body.sent_at_ms);

    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const recentSession = await findRecentSessionReplay(prisma, { tenancyId, refreshTokenId });

    const app = getHexclaveServerApp();

    const isNewSession = recentSession == null;
    const billingTeamId = getBillingTeamId(auth.tenancy.project);
    if (isNewSession && billingTeamId != null && arePlanLimitsEnforced()) {
      const replaysItem = await app.getItem({ itemId: ITEM_IDS.sessionReplays, teamId: billingTeamId });
      const isDebited = await replaysItem.tryDecreaseQuantity(1);
      if (!isDebited) {
        throw new KnownErrors.ItemQuantityInsufficientAmount(ITEM_IDS.sessionReplays, billingTeamId, 1);
      }
    }

    const replayId = recentSession?.id ?? randomUUID();
    const s3Key = `session-replays/${projectId}/${branchId}/${replayId}/${batchId}.json.gz`;

    const newStartedAtMs = Math.min(recentSession?.startedAt.getTime() ?? Number.POSITIVE_INFINITY, firstMs);
    const newLastEventAtMs = Math.max(recentSession?.lastEventAt.getTime() ?? 0, lastMs);
    await prisma.sessionReplay.upsert({
      where: { tenancyId_id: { tenancyId, id: replayId } },
      create: {
        id: replayId,
        tenancyId,
        projectUserId,
        refreshTokenId,
        startedAt: new Date(firstMs),
        lastEventAt: new Date(newLastEventAtMs),
        shouldUpdateSequenceId: true,
      },
      update: {
        startedAt: new Date(newStartedAtMs),
        lastEventAt: new Date(newLastEventAtMs),
        shouldUpdateSequenceId: true,
      },
    });

    // If we already have this batch for this session, return deduped without touching S3.
    const existingChunk = await prisma.sessionReplayChunk.findUnique({
      where: { tenancyId_sessionReplayId_batchId: { tenancyId, sessionReplayId: replayId, batchId } },
      select: { s3Key: true },
    });
    if (existingChunk) {
      return {
        statusCode: 200,
        bodyType: "json",
        body: {
          session_replay_id: replayId,
          batch_id: batchId,
          s3_key: existingChunk.s3Key,
          deduped: true,
        },
      };
    }

    const payload = {
      v: 1,
      session_replay_id: replayId,
      browser_session_id: browserSessionId,
      session_replay_segment_id: sessionReplaySegmentId,
      batch_id: batchId,
      started_at_ms: body.started_at_ms,
      sent_at_ms: body.sent_at_ms,
      events: body.events,
    };
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const gzipped = new Uint8Array(await gzip(payloadBytes));

    await uploadBytes({
      key: s3Key,
      body: gzipped,
      contentType: "application/json",
      contentEncoding: "gzip",
      private: true,
    });

    try {
      await prisma.sessionReplayChunk.create({
        data: {
          tenancyId,
          sessionReplayId: replayId,
          batchId,
          sessionReplaySegmentId,
          browserSessionId,
          s3Key,
          eventCount: body.events.length,
          byteLength: gzipped.byteLength,
          firstEventAt: new Date(firstMs),
          lastEventAt: new Date(lastMs),
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return {
          statusCode: 200,
          bodyType: "json",
          body: {
            session_replay_id: replayId,
            batch_id: batchId,
            s3_key: s3Key,
            deduped: true,
          },
        };
      }
      throw e;
    }

    await prisma.sessionReplay.update({
      where: { tenancyId_id: { tenancyId, id: replayId } },
      data: { shouldUpdateSequenceId: true },
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        session_replay_id: replayId,
        batch_id: batchId,
        s3_key: s3Key,
        deduped: false,
      },
    };
  },
});
