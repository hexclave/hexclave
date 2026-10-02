import { getSharedClickhouseAdminClient } from "@/lib/clickhouse";
import { createProductionErrorAttachmentService } from "@/lib/attachments";
import {
  createErrorIngestItemOutcome,
  createErrorIngestProtocolProjection,
  evaluateErrorIngestPolicy,
  ErrorIngestEnvelopeError,
  parseErrorIngestEnvelope,
  persistErrorIngestClientReportProjection,
  persistErrorIngestClientReportRequest,
  normalizeErrorIngestClientReportReportedAt,
  type ErrorIngestEnvelope,
  type ErrorIngestEnvelopeAttachmentPayload,
  type ErrorIngestEnvelopeItem,
  type ErrorIngestItemOutcome,
} from "@/lib/error-ingest";
import { projectSentryEnvelopeEvent } from "@/lib/error-ingest/error-ingest-event-adapter";
import {
  ErrorIngestTransactionAdapterError,
  sentryTransactionToCanonicalOtlpSpans,
} from "@/lib/error-ingest/error-ingest-transaction-adapter";
import { buildTelemetryWritePlan, insertBatchEvents, normalizeBatchEvents } from "@/lib/analytics-telemetry-writers";
import { getOtlpTraceDeduplicationToken, insertOtlpTraces, type OtlpTenantContext } from "@/lib/otlp/trace-writer";
import { buildTelemetryMaterializationMessage, enqueueQstashMessage } from "@/lib/qstash-outbox";
import { arePlanLimitsEnforced, getBillingTeamId } from "@/lib/plan-entitlements";
import { tryDecreasePlanItemQuantities, type PlanItemDebit } from "@/lib/plan-metering";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import type { TelemetryResource } from "@hexclave/shared/dist/utils/analytics-wire";
import { KnownErrors } from "@hexclave/shared";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { captureError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { globalPrismaClient } from "@/prisma-client";
import { telemetryMeteredAt } from "@/lib/telemetry-metering-time";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";

const MAX_TRANSACTION_SPANS_PER_ENVELOPE = 10_000;

function envelopeBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new StatusError(StatusError.BadRequest, "Sentry envelope body must be binary");
}

function envelopeResource(envelope: ErrorIngestEnvelope): TelemetryResource {
  const sdk = envelope.header.sdk;
  const service: TelemetryResource["service"] = { name: sdk?.name ?? "sentry-envelope" };
  if (sdk?.version !== undefined) service.version = sdk.version;
  const resource: TelemetryResource = { service };
  if (envelope.header.trace?.environment !== undefined) resource.deploymentEnvironmentName = envelope.header.trace.environment;
  return resource;
}

function envelopeOtlpContext(envelope: ErrorIngestEnvelope): Parameters<typeof sentryTransactionToCanonicalOtlpSpans>[1] {
  const sdk = envelope.header.sdk;
  const resourceAttributes = new Map<string, { type: "string", value: string }>();
  resourceAttributes.set("service.name", { type: "string", value: sdk?.name ?? "sentry-envelope" });
  if (sdk?.version !== undefined) resourceAttributes.set("service.version", { type: "string", value: sdk.version });
  if (envelope.header.trace?.environment !== undefined) {
    resourceAttributes.set("deployment.environment.name", { type: "string", value: envelope.header.trace.environment });
  }
  return {
    resource: {
      attributes: resourceAttributes,
      droppedAttributesCount: 0,
      schemaUrl: "",
    },
    scope: {
      name: "sentry-envelope",
      version: sdk?.version ?? "",
      attributes: new Map(),
      droppedAttributesCount: 0,
      schemaUrl: "",
    },
  };
}

function protocolOutcomes(
  envelope: ErrorIngestEnvelope,
  policyOutcomes: ReadonlyMap<string, ErrorIngestItemOutcome>,
  attachmentOutcomes: ReadonlyMap<string, ErrorIngestItemOutcome>,
  transactionOutcomes: ReadonlyMap<string, ErrorIngestItemOutcome>,
): readonly ErrorIngestItemOutcome[] {
  return envelope.items.map((item) => {
    if (item.wireType === "attachment" && item.outcome.status === "accepted") {
      const attachmentOutcome = attachmentOutcomes.get(item.itemId);
      if (attachmentOutcome === undefined) throw new Error("Sentry envelope attachment outcome is missing");
      return attachmentOutcome;
    }
    if (item.wireType === "event" && item.outcome.status === "accepted") {
      const policyOutcome = policyOutcomes.get(item.itemId);
      if (policyOutcome === undefined) throw new Error("Sentry envelope policy outcome is missing an event item");
      return item.outcome.eventId === undefined
        ? policyOutcome
        : { ...policyOutcome, eventId: item.outcome.eventId };
    }
    if (item.wireType === "transaction" && item.outcome.status === "accepted") {
      const transactionOutcome = transactionOutcomes.get(item.itemId);
      if (transactionOutcome === undefined) throw new Error("Sentry envelope transaction outcome is missing");
      return transactionOutcome;
    }
    return item.outcome;
  });
}

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Ingest a Sentry-compatible error envelope",
    description: "Accepts an authenticated, bounded Sentry envelope and projects error events onto issues and transactions onto canonical OTLP spans.",
    tags: ["Analytics Events"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
      user: adaptSchema,
      refreshTokenId: adaptSchema,
    }).defined(),
    body: yupMixed().defined(),
    method: yupString().oneOf(["POST"]).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
    headers: yupMixed().defined(),
  }),
  handler: async ({ auth, body }) => {
    assertObservabilityEnabled(auth.tenancy);
    const bytes = envelopeBytes(body);
    const attachmentPayloads = new Map<string, ErrorIngestEnvelopeAttachmentPayload>();
    let envelope: ErrorIngestEnvelope;
    try {
      envelope = parseErrorIngestEnvelope(bytes, {
        onAttachment: (payload) => attachmentPayloads.set(payload.itemId, payload),
      });
    } catch (error) {
      if (error instanceof StatusError) throw error;
      if (error instanceof ErrorIngestEnvelopeError) throw new StatusError(StatusError.BadRequest, error.message);
      throw error;
    }

    let userId: string | null = null;
    let refreshTokenId: string | null = null;
    if (auth.type === "client") {
      if (!auth.user) throw new KnownErrors.UserAuthenticationRequired();
      if (!auth.refreshTokenId) throw new StatusError(StatusError.BadRequest, "A refresh token is required for browser Sentry envelopes");
      userId = auth.user.id;
      refreshTokenId = auth.refreshTokenId;
    }

    const receivedAtMs = new Date().getTime();
    const eventItems = envelope.items.flatMap((item) => {
      if (item.wireType !== "event" || item.event === undefined || item.outcome.status !== "accepted") return [];
      const projected = projectSentryEnvelopeEvent({ event: item.event, header: envelope.header, item, receivedAtMs });
      return [{ item, projected }];
    });
    const scope = {
      tenancyId: auth.tenancy.id,
      projectId: auth.tenancy.project.id,
      branchId: auth.tenancy.branchId,
    };
    const policy = evaluateErrorIngestPolicy({
      config: auth.tenancy.config,
      items: eventItems.map(({ item, projected }) => ({
        itemId: item.itemId,
        itemType: "event" as const,
        data: projected.data,
      })),
    });
    const policyByItemId = new Map(policy.outcomes.map((outcome) => [outcome.itemId, outcome]));
    const acceptedEvents = eventItems.flatMap(({ item, projected }) => {
      if (!policy.acceptedItemIds.includes(item.itemId)) return [];
      const scrubbedData = policy.scrubbedData.get(item.itemId);
      return [{ ...projected, data: scrubbedData ?? projected.data }];
    });

    const transactionOutcomes = new Map<string, ErrorIngestItemOutcome>();
    const transactionTenant: OtlpTenantContext = {
      projectId: auth.tenancy.project.id,
      branchId: auth.tenancy.branchId,
      userId,
      refreshTokenId,
    };
    const transactionContext = envelopeOtlpContext(envelope);
    let transactionSpanCount = 0;
    const preparedTransactions: Array<{
      item: ErrorIngestEnvelopeItem,
      spans: ReturnType<typeof sentryTransactionToCanonicalOtlpSpans>,
    }> = [];
    for (const item of envelope.items) {
      if (item.wireType !== "transaction" || item.outcome.status !== "accepted" || item.transaction === undefined) continue;
      try {
        const spans = sentryTransactionToCanonicalOtlpSpans(item.transaction, transactionContext);
        if (transactionSpanCount + spans.length > MAX_TRANSACTION_SPANS_PER_ENVELOPE) {
          throw new ErrorIngestTransactionAdapterError("payload_too_large", "Sentry envelope transaction span limit exceeded");
        }
        transactionSpanCount += spans.length;
        preparedTransactions.push({ item, spans });
        transactionOutcomes.set(item.itemId, createErrorIngestItemOutcome(
          { itemId: item.itemId, itemType: "transaction", eventId: item.transaction.eventId },
          { status: "accepted" },
        ));
      } catch (error) {
        if (error instanceof ErrorIngestTransactionAdapterError) {
          transactionOutcomes.set(item.itemId, createErrorIngestItemOutcome(
            { itemId: item.itemId, itemType: "transaction", eventId: item.transaction.eventId },
            { status: "rejected", reason: error.code },
          ));
          continue;
        }
        captureError("sentry-envelope-transaction-storage", error);
        transactionOutcomes.set(item.itemId, createErrorIngestItemOutcome(
          { itemId: item.itemId, itemType: "transaction", eventId: item.transaction.eventId },
          { status: "dropped", reason: "delivery_failed" },
        ));
      }
    }

    const billingTeamId = getBillingTeamId(auth.tenancy.project);
    const transactionMeteringIdentity = getOtlpTraceDeduplicationToken(
      preparedTransactions.flatMap(({ spans }) => spans),
      transactionTenant,
    );
    if (
      auth.tenancy.project.id !== "internal"
      && billingTeamId != null
      && arePlanLimitsEnforced()
      && (acceptedEvents.length > 0 || transactionSpanCount > 0)
    ) {
      const timestampCandidates = [
        ...acceptedEvents.map(({ event_at_ms }) => event_at_ms),
        ...preparedTransactions.flatMap(({ item }) => item.transaction === undefined ? [] : [item.transaction.startTimestampMs]),
      ];
      const meteredAt = telemetryMeteredAt(
        envelope.header.sentAt,
        Math.min(...timestampCandidates),
        new Date(),
      );
      const debits: PlanItemDebit[] = [
        ...(acceptedEvents.length === 0 ? [] : [{
          itemId: ITEM_IDS.analyticsEvents,
          quantity: acceptedEvents.length,
          idempotency: {
            key: `sentry-envelope-events:${auth.tenancy.id}:${envelope.batchId}`,
            createdAt: meteredAt,
          },
        }]),
        ...(transactionSpanCount === 0 ? [] : [{
          itemId: ITEM_IDS.analyticsSpans,
          quantity: transactionSpanCount,
          idempotency: {
            // Storage and billing share the same canonical identity. A retry
            // that reuses the Sentry event ID but changes embedded spans must
            // neither receive free storage nor collapse onto the old debit.
            key: `sentry-envelope-spans:${auth.tenancy.id}:${transactionMeteringIdentity}`,
            createdAt: meteredAt,
          },
        }]),
      ];
      const debit = await tryDecreasePlanItemQuantities(billingTeamId, debits);
      if (debit.insufficientItemId != null) {
        const requested = debits.find(({ itemId }) => itemId === debit.insufficientItemId);
        if (requested === undefined) throw new Error("Plan metering returned an item outside the Sentry envelope debit");
        throw new KnownErrors.ItemQuantityInsufficientAmount(
          debit.insufficientItemId,
          billingTeamId,
          requested.quantity,
        );
      }
    }

    let acceptedTransactions = 0;
    for (const { item, spans } of preparedTransactions) {
      if (item.transaction === undefined) throw new Error("Prepared Sentry transaction metadata is missing");
      try {
        await insertOtlpTraces(getSharedClickhouseAdminClient(), spans, transactionTenant);
        acceptedTransactions += 1;
      } catch (error) {
        captureError("sentry-envelope-transaction-storage", error);
        transactionOutcomes.set(item.itemId, createErrorIngestItemOutcome(
          { itemId: item.itemId, itemType: "transaction", eventId: item.transaction.eventId },
          { status: "dropped", reason: "delivery_failed" },
        ));
      }
    }

    const attachmentOutcomes = new Map<string, ErrorIngestItemOutcome>();
    if (attachmentPayloads.size > 0) {
      try {
        const attachmentService = await createProductionErrorAttachmentService(auth.tenancy);
        const attachmentScope = {
          tenantId: auth.tenancy.id,
          projectId: auth.tenancy.project.id,
          branchId: auth.tenancy.branchId,
        };
        for (const item of envelope.items) {
          if (item.wireType !== "attachment" || item.outcome.status !== "accepted") continue;
          const payload = attachmentPayloads.get(item.itemId);
          if (payload === undefined) throw new Error("Sentry envelope attachment payload is missing");
          try {
            await attachmentService.uploadBytes(attachmentScope, {
              eventId: payload.eventId,
              occurrenceId: null,
              idempotencyKey: `${envelope.batchId}:${payload.itemIndex}:${payload.sha256}`,
              filename: payload.filename,
              contentType: payload.contentType,
              attachmentType: payload.attachmentType,
              bytes: payload.bytes,
              sha256: payload.sha256,
            });
            attachmentOutcomes.set(item.itemId, createErrorIngestItemOutcome(
              { itemId: item.itemId, itemType: "attachment", eventId: payload.eventId },
              { status: "accepted" },
            ));
          } catch (error) {
            captureError("sentry-envelope-attachment-storage", error);
            attachmentOutcomes.set(item.itemId, createErrorIngestItemOutcome(
              { itemId: item.itemId, itemType: "attachment", eventId: payload.eventId },
              { status: "dropped", reason: "delivery_failed" },
            ));
          }
        }
      } catch (error) {
        captureError("sentry-envelope-attachment-service", error);
        for (const item of envelope.items) {
          if (item.wireType !== "attachment" || item.outcome.status !== "accepted") continue;
          const payload = attachmentPayloads.get(item.itemId);
          if (payload === undefined) throw new Error("Sentry envelope attachment payload is missing");
          attachmentOutcomes.set(item.itemId, createErrorIngestItemOutcome(
            { itemId: item.itemId, itemType: "attachment", eventId: payload.eventId },
            { status: "dropped", reason: "delivery_failed" },
          ));
        }
      }
    }

    if (acceptedEvents.length > 0) {
      const resource = envelopeResource(envelope);
      const normalized = normalizeBatchEvents(acceptedEvents, {
        projectId: auth.tenancy.project.id,
        branchId: auth.tenancy.branchId,
        userId,
        refreshTokenId,
        sessionReplayId: null,
        sessionReplaySegmentId: null,
        runtime: auth.type === "client" ? "browser" : "server",
        resource,
        producer: "sdk",
        groupingConfig: auth.tenancy.config.observability.errorGrouping,
      }, envelope.batchId);
      if (normalized.issueInputs.length > 0) {
        await enqueueQstashMessage(buildTelemetryMaterializationMessage({
          tenancyId: auth.tenancy.id,
          batchId: envelope.batchId,
        }));
      }
      await insertBatchEvents(getSharedClickhouseAdminClient(), buildTelemetryWritePlan(normalized, envelope.batchId));
    }

    const outcomes = protocolOutcomes(envelope, policyByItemId, attachmentOutcomes, transactionOutcomes);
    const projection = createErrorIngestProtocolProjection(envelope.batchId, outcomes);
    runAsynchronouslyAndWaitUntil(persistErrorIngestClientReportProjection(scope, "sentry_envelope", projection));
    const envelopeSentAt = envelope.header.sentAt === null ? null : new Date(envelope.header.sentAt);
    const receivedAt = new Date(receivedAtMs);
    for (const item of envelope.items) {
      if (item.clientReport === undefined || item.outcome.status !== "accepted") continue;
      runAsynchronouslyAndWaitUntil(persistErrorIngestClientReportRequest(
        scope,
        item.clientReport,
        globalPrismaClient,
        normalizeErrorIngestClientReportReportedAt(item.clientReport, envelopeSentAt, receivedAt),
      ));
    }

    return {
      statusCode: 200,
      bodyType: "json",
      headers: {},
      body: {
        batch_id: envelope.batchId,
        status: projection.status,
        inserted: acceptedEvents.length + acceptedTransactions,
        ingest: {
          counts: { ...projection.counts },
          outcomes: [...projection.items],
          client_report: {
            discarded_events: [...projection.clientReport.discarded_events],
            rate_limited_events: [...projection.clientReport.rate_limited_events],
            filtered_events: [...projection.clientReport.filtered_events],
            filtered_sampling_events: [...projection.clientReport.filtered_sampling_events],
          },
          idempotency_key: projection.idempotencyKey,
        },
      },
    };
  },
});
