import { MAX_CUSTOM_EVENT_NAME_LENGTH, isReservedEventName, validateCustomEventPayload } from "@/lib/analytics-custom-events";
import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { arePlanLimitsEnforced, getBillingTeamId } from "@/lib/plan-entitlements";
import { findRecentSessionReplay } from "@/lib/session-replays";
import { ensureTeamMembershipExists } from "@/lib/request-checks";
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
// Plausibility window for event_at_ms, anchored to the server's receive time
// (never to the client's sent_at_ms, which comes from the same skewed clock).
// The past bound covers offline queues; the future bound only needs to keep
// nonsense timestamps (year 2099, etc.) out of ClickHouse, so it is generous:
// end-user clocks being hours off is common and not the customer's fault.
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

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

// Every stored event carries a stable `data.event_id` derived from the client
// batch id and the event's position in it. Uploads are not deduplicated today
// (a retried batch inserts again), but the id is what a later ClickHouse-side
// dedup (e.g. ReplacingMergeTree keyed on it) or a downstream query can use to
// collapse retries without a Postgres ledger.
function attachStableAnalyticsEventId(value: unknown, eventId: string): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { ...value, event_id: eventId };
  }
  return { event_id: eventId, payload: value };
}

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
    description: "Uploads a batch of analytics events: auto-captured reserved events ($page-view, $click) and customer-defined custom events (bounded names that never start with $, size-limited properties, optional finite numeric value).",
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
          // Either one of the accepted reserved types or a customer event name;
          // the handler decides which (yup can't express the union cleanly, and
          // custom names have validation rules beyond a regex — see
          // validateCustomEventPayload).
          event_type: yupString().defined().min(1).max(MAX_CUSTOM_EVENT_NAME_LENGTH),
          event_at_ms: yupNumber().defined().integer().min(0),
          team_id: yupString().uuid().optional(),
          data: yupMixed().defined(),
          // Only allowed on custom events: the per-event numeric observation
          // (e.g. revenue) used by numeric experiment metrics.
          value: yupMixed().optional(),
        }).defined(),
      ).defined().min(1).max(MAX_EVENTS),
    }).defined().transform((_value, originalValue) => maybeDecodeBinaryBody(originalValue)),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      inserted: yupNumber().defined(),
      // Events skipped for an implausible event_at_ms; they were not billed.
      dropped: yupNumber().defined(),
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

    // Implausible timestamps are dropped per event rather than failing the
    // batch. The SDK re-sends the same pending batch on every non-2xx until it
    // succeeds, so a rejection caused by a wrong end-user clock would wedge
    // that client's analytics forever (newer events queue behind it). Dropping
    // lets the rest of the batch land and the client move on; the count is
    // reported so it stays observable. Dropped events are not billed.
    //
    // Each event keeps its position in the original batch (batchIndex): the
    // stable event id is `batch_id:batchIndex`, and it must not shift when an
    // earlier event is dropped, or a retried batch would mint new ids for the
    // same events.
    const receivedAtMillis = Date.now();
    const plausibleEvents = body.events.flatMap((event, batchIndex) =>
      event.event_at_ms >= receivedAtMillis - MAX_EVENT_AGE_MS && event.event_at_ms <= receivedAtMillis + MAX_EVENT_FUTURE_SKEW_MS
        ? [{ ...event, batchIndex }]
        : []
    );
    const droppedCount = body.events.length - plausibleEvents.length;
    if (plausibleEvents.length === 0) {
      return {
        statusCode: 200,
        bodyType: "json",
        body: { inserted: 0, dropped: droppedCount },
      };
    }

    // Split events into reserved (auto-capture, trusted shape) and custom
    // (customer-defined, strictly validated). Reserved names other than the
    // two auto-capture types are rejected outright — in particular
    // $feature-flag-exposure rows may only enter through the signed
    // feature-flags exposure route, never through this public one.
    const preparedEvents = plausibleEvents.map((event) => {
      if (isReservedEventName(event.event_type)) {
        if (event.event_type !== "$page-view" && event.event_type !== "$click") {
          throw new StatusError(StatusError.BadRequest, `Reserved event type ${JSON.stringify(event.event_type)} cannot be uploaded via this endpoint`);
        }
        if (event.value !== undefined) {
          throw new StatusError(StatusError.BadRequest, `Reserved event type ${JSON.stringify(event.event_type)} does not accept a value`);
        }
        return { event_type: event.event_type, event_at_ms: event.event_at_ms, data: event.data, team_id: event.team_id, batchIndex: event.batchIndex };
      }
      const { properties, value } = validateCustomEventPayload({
        eventName: event.event_type,
        properties: event.data,
        value: event.value,
      });
      // Custom event payloads are wrapped as { properties, value } so customer
      // property keys can never collide with the top-level value field, and
      // numeric-metric queries can always read data.value.
      return { event_type: event.event_type, event_at_ms: event.event_at_ms, data: { properties, value }, team_id: event.team_id, batchIndex: event.batchIndex };
    });

    const projectId = auth.tenancy.project.id;
    const branchId = auth.tenancy.branchId;
    const userId = auth.user.id;
    const refreshTokenId = auth.refreshTokenId;
    const tenancyId = auth.tenancy.id;
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const selectedTeamIds = new Set(preparedEvents.flatMap((event) => event.team_id === undefined ? [] : [event.team_id]));
    for (const teamId of selectedTeamIds) {
      await ensureTeamMembershipExists(prisma, { tenancyId, teamId, userId });
    }

    const billingTeamId = getBillingTeamId(auth.tenancy.project);
    if (billingTeamId != null && arePlanLimitsEnforced()) {
      const eventsItem = await getHexclaveServerApp().getItem({ itemId: ITEM_IDS.analyticsEvents, teamId: billingTeamId });
      const isDebited = await eventsItem.tryDecreaseQuantity(preparedEvents.length);
      if (!isDebited) {
        throw new KnownErrors.ItemQuantityInsufficientAmount(ITEM_IDS.analyticsEvents, billingTeamId, preparedEvents.length);
      }
    }

    const recentSession = await findRecentSessionReplay(prisma, { tenancyId, refreshTokenId });
    const normalizedBatchId = body.batch_id.toLowerCase();
    const rows = preparedEvents.map((event) => ({
      event_type: event.event_type,
      event_at: new Date(event.event_at_ms),
      data: attachStableAnalyticsEventId(stripLoneSurrogates(event.data), `${normalizedBatchId}:${event.batchIndex}`),
      project_id: projectId,
      branch_id: branchId,
      user_id: userId,
      team_id: event.team_id ?? null,
      refresh_token_id: refreshTokenId,
      session_replay_id: recentSession?.id ?? null,
      session_replay_segment_id: body.session_replay_segment_id,
    }));

    await getClickhouseAdminClient().insert({
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
      body: { inserted: preparedEvents.length, dropped: droppedCount },
    };
  },
});
