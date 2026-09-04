import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { arePlanLimitsEnforced, getBillingTeamId } from "@/lib/plan-entitlements";
import { findRecentSessionReplay } from "@/lib/session-replays";
import { getHexclaveServerApp } from "@/hexclave";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupArray, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import * as zlib from "node:zlib";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_EVENTS = 500;
const MAX_COMPRESSED_BYTES = 1 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024;

// Lone surrogates (\uD800-\uDFFF not part of a valid pair) are technically
// representable in JS strings but rejected by ClickHouse's JSON parser.
// The client-side event tracker can produce these when .substring() truncates
// text in the middle of a surrogate pair (e.g. emoji characters).
// eslint-disable-next-line no-control-regex
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function stripLoneSurrogates(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(LONE_SURROGATE_RE, "\uFFFD");
  }
  if (Array.isArray(value)) {
    return value.map(stripLoneSurrogates);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, stripLoneSurrogates(v)])
    );
  }
  return value;
}

// Bodies sent as application/octet-stream are gzipped JSON. The encoding is
// purely to evade keyword-matching adblockers (e.g. filters on "$click").
// We gunzip + JSON.parse here so the rest of the schema can validate the
// decoded object normally.
function decodeBinaryBody(value: unknown): unknown {
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
      sent_at_ms: yupNumber().defined().integer().min(0),
      events: yupArray(
        yupObject({
          event_type: yupString().defined().oneOf(["$page-view", "$click"]),
          event_at_ms: yupNumber().defined().integer().min(0),
          data: yupMixed().defined(),
        }).defined(),
      ).defined().min(1).max(MAX_EVENTS),
    }).defined().transform((_value, originalValue) => decodeBinaryBody(originalValue)),
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

    const projectId = auth.tenancy.project.id;
    const branchId = auth.tenancy.branchId;
    const userId = auth.user.id;
    const refreshTokenId = auth.refreshTokenId;
    const tenancyId = auth.tenancy.id;

    const app = getHexclaveServerApp();

    const billingTeamId = getBillingTeamId(auth.tenancy.project);
    if (billingTeamId != null && arePlanLimitsEnforced()) {
      const eventsItem = await app.getItem({ itemId: ITEM_IDS.analyticsEvents, teamId: billingTeamId });
      const isDebited = await eventsItem.tryDecreaseQuantity(body.events.length);
      if (!isDebited) {
        throw new KnownErrors.ItemQuantityInsufficientAmount(ITEM_IDS.analyticsEvents, billingTeamId, body.events.length);
      }
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const recentSession = await findRecentSessionReplay(prisma, { tenancyId, refreshTokenId });

    const clickhouseClient = getClickhouseAdminClient();

    const rows = body.events.map((event) => ({
      event_type: event.event_type,
      event_at: new Date(event.event_at_ms),
      data: stripLoneSurrogates(event.data),
      project_id: projectId,
      branch_id: branchId,
      user_id: userId,
      team_id: null,
      refresh_token_id: refreshTokenId,
      session_replay_id: recentSession?.id ?? null,
      session_replay_segment_id: body.session_replay_segment_id,
    }));

    await clickhouseClient.insert({
      table: "analytics_internal.events",
      values: rows,
      format: "JSONEachRow",
      clickhouse_settings: {
        date_time_input_format: "best_effort",
        async_insert: 1,
      },
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: { inserted: body.events.length },
    };
  },
});
