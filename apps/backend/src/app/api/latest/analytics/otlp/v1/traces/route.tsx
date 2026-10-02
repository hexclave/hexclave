import { getSharedClickhouseAdminClient } from "@/lib/clickhouse";
import { evaluateErrorIngestPolicy, persistErrorIngestClientReportProjection } from "@/lib/error-ingest";
import { createOtlpTraceProtocolProjection } from "@/lib/error-ingest/error-ingest-protocol-projections";
import { createOtlpHttpResponse, parseOtlpHttpRequest, resolveOtlpClientContext } from "@/lib/otlp/http";
import { buildOtlpTraceRows, getOtlpSpanPolicyData, insertOtlpTraces, type OtlpTenantContext } from "@/lib/otlp/trace-writer";
import { normalizeOtlpJsonTraceRequest, type CanonicalOtlpSpan } from "@/lib/otlp/traces";
import { arePlanLimitsEnforced, getBillingTeamId } from "@/lib/plan-entitlements";
import { tryDecreasePlanItemQuantities } from "@/lib/plan-metering";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { KnownErrors } from "@hexclave/shared";
import { ITEM_IDS } from "@hexclave/shared/dist/plans";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupMixed, yupNumber, yupObject, yupString, yupTuple } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { otlpSpanPolicyItemId, selectOtlpSpansAcceptedByPolicy } from "./policy-selection";

const MAX_SPANS_PER_REQUEST = 10_000;

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Export OpenTelemetry traces",
    description: "Accepts authenticated OTLP/HTTP JSON or protobuf ExportTraceServiceRequest messages.",
    tags: ["Observability"],
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
    body: yupMixed().defined(),
    headers: yupObject({
      "content-type": yupTuple([yupString().defined()]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }, fullRequest) => {
    assertObservabilityEnabled(auth.tenancy);
    const { userId, refreshTokenId } = resolveOtlpClientContext("traces", auth);

    const { encoding, value: spans } = parseOtlpHttpRequest({
      kind: "traces",
      headers: fullRequest.headers,
      body,
      normalize: normalizeOtlpJsonTraceRequest,
    });
    if (spans.length > MAX_SPANS_PER_REQUEST) {
      throw new StatusError(StatusError.PayloadTooLarge, `OTLP trace request contains more than ${MAX_SPANS_PER_REQUEST} spans`);
    }

    const tenant: OtlpTenantContext = {
      // These values always come from the authenticated key/session. OTLP
      // resources and baggage are deliberately unable to select a tenant or user.
      projectId: auth.tenancy.project.id,
      branchId: auth.tenancy.branchId,
      userId,
      refreshTokenId,
    };
    const policyDecision = evaluateErrorIngestPolicy({
      config: auth.tenancy.config,
      items: spans.map((span, index) => ({
        itemId: otlpSpanPolicyItemId(span, index),
        itemType: "span" as const,
        data: getOtlpSpanPolicyData(span),
      })),
    });
    const acceptedSpans = selectOtlpSpansAcceptedByPolicy(spans, policyDecision);
    const rows = buildOtlpTraceRows(acceptedSpans, tenant);
    const billableSpansByIdentity = new Map(
      rows.spans
        .filter((span) => span.billing_item === "analytics_spans")
        .map((span) => [`${span.trace_id}:${span.span_id}`, span]),
    );
    const billableSpanCount = billableSpansByIdentity.size;
    const billingTeamId = getBillingTeamId(auth.tenancy.project);
    if (
      auth.tenancy.project.id !== "internal"
      && billingTeamId != null
      && billableSpanCount > 0
      && arePlanLimitsEnforced()
    ) {
      const debit = await tryDecreasePlanItemQuantities(
        billingTeamId,
        [...billableSpansByIdentity].map(([spanIdentity, span]) => ({
          itemId: ITEM_IDS.analyticsSpans,
          quantity: 1,
          idempotency: {
            // The tenancy id is part of the key because W3C span identity is
            // CLIENT-chosen: two projects/branches billed to the same team may
            // legitimately (or deliberately) carry identical trace/span ids,
            // and each accepted span must debit its own metering row.
            key: `otlp-span:${auth.tenancy.id}:${spanIdentity}`,
            createdAt: span.ended_at ?? span.started_at,
          },
        })),
      );
      if (debit.insufficientItemId != null) {
        throw new KnownErrors.ItemQuantityInsufficientAmount(
          debit.insufficientItemId,
          billingTeamId,
          billableSpanCount,
        );
      }
    }

    // Every custom span has a stable metering row keyed by authenticated tenant
    // plus W3C span identity. OTLP exporters may retry the same span in a new
    // batch after an ambiguous response; retaining that debit on a ClickHouse
    // error makes the retry idempotent. Refunding it here would let the retry's
    // identical debit collapse while the refund remained, producing free usage.
    if (acceptedSpans.length > 0) {
      await insertOtlpTraces(getSharedClickhouseAdminClient(), acceptedSpans, tenant);
    }

    const protocolProjection = createOtlpTraceProtocolProjection(spans, tenant, policyDecision.outcomes);
    runAsynchronouslyAndWaitUntil(persistErrorIngestClientReportProjection(
      {
        tenancyId: auth.tenancy.id,
        projectId: auth.tenancy.project.id,
        branchId: auth.tenancy.branchId,
      },
      "otlp_traces",
      protocolProjection,
    ));
    const partialSuccess = protocolProjection.otlpPartialSuccess.traces;
    if (partialSuccess.rejectedItems === 0) return createOtlpHttpResponse("traces", encoding);

    return createOtlpHttpResponse("traces", encoding, {
      rejectedItems: partialSuccess.rejectedItems,
      errorMessage: partialSuccess.body.partialSuccess?.errorMessage ?? "Invalid OTLP trace records",
    });
  },
});
