import { type Tenancy } from "@/lib/tenancies";
import { Prisma } from "@/generated/prisma/client";
import {
  calculateTvEmailEvidenceRate,
  createTvEmailEvaluatorState,
  evaluateTvEmailDelivery,
  evaluateTvUserMilestone,
  median,
  TV_EVENT_EVALUATION_INTERVAL_MS,
  TV_EMAIL_BASELINE_DAYS,
  TV_EMAIL_BASELINE_REFRESH_MS,
  TV_EMAIL_CURRENT_WINDOW_MINUTES,
  TV_EMAIL_LOW_VOLUME_WINDOW_MINUTES,
  TV_EMAIL_MATURITY_DELAY_MINUTES,
  TV_EMAIL_RECOVERY_TITLE,
  TV_EMAIL_RULE_VERSION,
  TV_PAYMENT_BASELINE_REFRESH_MS,
  TV_PAYMENT_RECOVERY_TITLE,
  TV_PAYMENT_RULE_VERSION,
  createTvPaymentEvaluatorState,
  evaluateTvSubscriptionCollection,
  type TvEmailBaseline,
  type TvEmailEvidenceWindow,
  type TvEmailEvaluationSample,
  type TvEmailEvaluatorState,
  type TvPaymentBaseline,
  type TvPaymentEvaluatorState,
  type TvPaymentSample,
  type TvPaymentRulePath,
  type TvPaymentWindow,
} from "@/lib/tv-mode/event-evaluators";
import {
  createTvPresentationAssignment,
  deriveTvPresentation,
  type TvDurableEventOccurrence,
  type TvDurablePresentationAssignment,
} from "@/lib/tv-mode/event-orchestration";
import {
  getPrismaClientForTenancy,
  getPrismaSchemaForTenancy,
  type PrismaClientWithReplica,
  retryTransaction,
  sqlQuoteIdent,
} from "@/prisma-client";
import {
  type TvEvent,
  type TvInterruptionPreferences,
  type TvPresentedEventHighlight,
  type TvPresentedTakeover,
  type TvProfileResource,
} from "@hexclave/shared/dist/interface/admin-tv-mode";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";

const MINUTE_MS = 60_000;
const MAX_EVENT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export type EvaluatorClaimRow = {
  claimExpiresAt: Date,
  breachCount: number,
  criticalBreachCount: number,
  recoveryCount: number,
  milestoneBaseline: bigint | null,
  typedState: unknown,
  activeOccurrenceId: string | null,
  activePresentationClass: "CELEBRATION" | "INCIDENT" | "CRITICAL_INCIDENT" | null,
  activeAggregateEvidence: unknown,
};

export type TvEventOccurrenceRow = {
  id: string,
  eventType: "EMAIL_DELIVERY_DEGRADATION" | "SUBSCRIPTION_COLLECTION_DEGRADATION" | "USER_MILESTONE",
  presentationClass: "CELEBRATION" | "INCIDENT" | "CRITICAL_INCIDENT",
  lifecycle: "OCCURRED" | "ACTIVE" | "RESOLVED",
  title: string,
  summary: string,
  metricLabel: string,
  metricValue: string,
  expectedRange: string | null,
  sourceLabel: string,
  occurredAt: Date,
  activatedAt: Date | null,
  escalatedAt: Date | null,
  resolvedAt: Date | null,
  updatedAt: Date,
};

type AssignmentRow = {
  occurrenceId: string,
  takeoverStartedAt: Date | null,
  takeoverEndsAt: Date | null,
  recoveryEndsAt: Date | null,
  highlightExpiresAt: Date | null,
  animationExpiresAt: Date | null,
  supersededAt: Date | null,
};

export type TvEventPresentation = {
  takeover: TvPresentedTakeover | null,
  highlight: TvPresentedEventHighlight | null,
};

export function getTvEmailEvaluatorBounds(now: Date): {
  currentStartsAt: Date,
  currentEndsAt: Date,
  lowVolumeStartsAt: Date,
  lowVolumeEndsAt: Date,
} {
  const currentEndsAt = new Date(now.getTime() - TV_EMAIL_MATURITY_DELAY_MINUTES * MINUTE_MS);
  return {
    currentStartsAt: new Date(currentEndsAt.getTime() - TV_EMAIL_CURRENT_WINDOW_MINUTES * MINUTE_MS),
    currentEndsAt,
    lowVolumeStartsAt: new Date(currentEndsAt.getTime() - TV_EMAIL_LOW_VOLUME_WINDOW_MINUTES * MINUTE_MS),
    lowVolumeEndsAt: currentEndsAt,
  };
}

function readLastObservedTotal(typedState: unknown): number {
  if (
    typeof typedState === "object"
    && typedState != null
    && "lastObservedTotal" in typedState
    && typeof typedState.lastObservedTotal === "number"
  ) {
    return typedState.lastObservedTotal;
  }
  return 0;
}

export async function tvEventTablesAreReady(tenancy: Tenancy): Promise<boolean> {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  return await tvEventTablesAreReadyForSchema(prisma, schema);
}

export async function tvEventTablesAreReadyForSchema(
  prisma: PrismaClientWithReplica,
  schema: string,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{
    occurrences: string | null,
    evaluators: string | null,
    presentations: string | null,
  }>>`
    SELECT
      to_regclass(format('%I.%I', ${schema}::text, 'TvEventOccurrence'))::text AS occurrences,
      to_regclass(format('%I.%I', ${schema}::text, 'TvEventEvaluatorState'))::text AS evaluators,
      to_regclass(format('%I.%I', ${schema}::text, 'TvProfileEventPresentation'))::text AS presentations
  `;
  const row = rows.at(0);
  return row?.occurrences != null
    && row.evaluators != null
    && row.presentations != null;
}

export async function claimEvaluator(
  tenancy: Tenancy,
  evaluatorKey: string,
  now: Date,
): Promise<EvaluatorClaimRow | null> {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const nextEvaluationAt = new Date(now.getTime() + TV_EVENT_EVALUATION_INTERVAL_MS);
  const rows = await prisma.$queryRaw<EvaluatorClaimRow[]>`
    WITH claimed AS (
      INSERT INTO ${sqlQuoteIdent(schema)}."TvEventEvaluatorState" (
        "tenancyId", "evaluatorKey", "nextEvaluationAt", "typedState", "updatedAt"
      )
      VALUES (
        ${tenancy.id}::UUID, ${evaluatorKey}, ${nextEvaluationAt}, '{}'::JSONB, ${now}
      )
      ON CONFLICT ("tenancyId", "evaluatorKey")
      DO UPDATE SET
        "nextEvaluationAt" = EXCLUDED."nextEvaluationAt",
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE ${sqlQuoteIdent(schema)}."TvEventEvaluatorState"."nextEvaluationAt" <= ${now}
      RETURNING *
    )
    SELECT
      claimed."breachCount",
      claimed."nextEvaluationAt" AS "claimExpiresAt",
      claimed."criticalBreachCount",
      claimed."recoveryCount",
      claimed."milestoneBaseline",
      claimed."typedState",
      claimed."activeOccurrenceId",
      occurrence."presentationClass" AS "activePresentationClass",
      occurrence."aggregateEvidence" AS "activeAggregateEvidence"
    FROM claimed
    LEFT JOIN ${sqlQuoteIdent(schema)}."TvEventOccurrence" occurrence
      ON occurrence."tenancyId" = claimed."tenancyId"
      AND occurrence."id" = claimed."activeOccurrenceId"
  `;
  return rows.at(0) ?? null;
}

async function evaluatorClaimStillCurrent(
  transaction: Prisma.TransactionClient,
  schema: string,
  tenancyId: string,
  evaluatorKey: string,
  claim: EvaluatorClaimRow,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ nextEvaluationAt: Date }>>`
    SELECT "nextEvaluationAt"
    FROM ${sqlQuoteIdent(schema)}."TvEventEvaluatorState"
    WHERE "tenancyId" = ${tenancyId}::UUID
      AND "evaluatorKey" = ${evaluatorKey}
      AND "nextEvaluationAt" = ${claim.claimExpiresAt}
    FOR UPDATE
  `;
  return rows.length === 1;
}

async function loadEmailEvaluatorSample(
  tenancy: Tenancy,
  now: Date,
  baseline: TvEmailBaseline | null,
): Promise<TvEmailEvaluationSample> {
  const bounds = getTvEmailEvaluatorBounds(now);
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const rows = await prisma.$replica().$queryRaw<Array<{
    currentFinished: number,
    currentDelivered: number,
    currentBounced: number,
    currentServerError: number,
    currentTotal: number,
    lowVolumeFinished: number,
    lowVolumeDelivered: number,
    lowVolumeBounced: number,
    lowVolumeServerError: number,
    lowVolumeTotal: number,
  }>>`
    SELECT
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${bounds.currentStartsAt}
          AND "createdAt" < ${bounds.currentEndsAt}
          AND "finishedSendingAt" IS NOT NULL
      )::INT AS "currentFinished",
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${bounds.currentStartsAt}
          AND "createdAt" < ${bounds.currentEndsAt}
          AND "deliveredAt" IS NOT NULL
          AND "bouncedAt" IS NULL
          AND "sendServerErrorExternalMessage" IS NULL
      )::INT AS "currentDelivered",
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${bounds.currentStartsAt}
          AND "createdAt" < ${bounds.currentEndsAt}
          AND "bouncedAt" IS NOT NULL
      )::INT AS "currentBounced",
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${bounds.currentStartsAt}
          AND "createdAt" < ${bounds.currentEndsAt}
          AND "bouncedAt" IS NULL
          AND "sendServerErrorExternalMessage" IS NOT NULL
      )::INT AS "currentServerError",
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${bounds.currentStartsAt}
          AND "createdAt" < ${bounds.currentEndsAt}
      )::INT AS "currentTotal",
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${bounds.lowVolumeStartsAt}
          AND "createdAt" < ${bounds.lowVolumeEndsAt}
          AND "finishedSendingAt" IS NOT NULL
      )::INT AS "lowVolumeFinished",
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${bounds.lowVolumeStartsAt}
          AND "createdAt" < ${bounds.lowVolumeEndsAt}
          AND "deliveredAt" IS NOT NULL
          AND "bouncedAt" IS NULL
          AND "sendServerErrorExternalMessage" IS NULL
      )::INT AS "lowVolumeDelivered",
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${bounds.lowVolumeStartsAt}
          AND "createdAt" < ${bounds.lowVolumeEndsAt}
          AND "bouncedAt" IS NOT NULL
      )::INT AS "lowVolumeBounced",
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${bounds.lowVolumeStartsAt}
          AND "createdAt" < ${bounds.lowVolumeEndsAt}
          AND "bouncedAt" IS NULL
          AND "sendServerErrorExternalMessage" IS NOT NULL
      )::INT AS "lowVolumeServerError",
      COUNT(*) FILTER (
        WHERE "createdAt" >= ${bounds.lowVolumeStartsAt}
          AND "createdAt" < ${bounds.lowVolumeEndsAt}
      )::INT AS "lowVolumeTotal"
    FROM ${sqlQuoteIdent(schema)}."EmailOutbox"
    WHERE "tenancyId" = ${tenancy.id}::UUID
      AND "createdAt" >= ${bounds.lowVolumeStartsAt}
      AND "createdAt" < ${bounds.lowVolumeEndsAt}
  `;
  const sample = rows.at(0);
  if (sample == null) {
    throw new HexclaveAssertionError("The TV email evaluator query returned no aggregate row.");
  }
  const evidenceWindow = (window: {
    startsAt: Date,
    endsAt: Date,
    finished: number,
    delivered: number,
    bounced: number,
    serverError: number,
    total: number,
  }): TvEmailEvidenceWindow => {
    const explicitFailures = window.bounced + window.serverError;
    const rates = calculateTvEmailEvidenceRate(window.delivered, explicitFailures);
    return {
      startsAt: window.startsAt.toISOString(),
      endsAt: window.endsAt.toISOString(),
      finishedSends: window.finished,
      deliveredSends: window.delivered,
      bouncedSends: window.bounced,
      serverErrorSends: window.serverError,
      neutralOrUnknownSends: Math.max(0, window.total - window.delivered - explicitFailures),
      explicitFailures,
      ...rates,
    };
  };
  const current = evidenceWindow({
    startsAt: bounds.currentStartsAt,
    endsAt: bounds.currentEndsAt,
    finished: Number(sample.currentFinished),
    delivered: Number(sample.currentDelivered),
    bounced: Number(sample.currentBounced),
    serverError: Number(sample.currentServerError),
    total: Number(sample.currentTotal),
  });
  const lowVolume = evidenceWindow({
    startsAt: bounds.lowVolumeStartsAt,
    endsAt: bounds.lowVolumeEndsAt,
    finished: Number(sample.lowVolumeFinished),
    delivered: Number(sample.lowVolumeDelivered),
    bounced: Number(sample.lowVolumeBounced),
    serverError: Number(sample.lowVolumeServerError),
    total: Number(sample.lowVolumeTotal),
  });
  return {
    status: current.assessableSends < 20 && lowVolume.assessableSends < 20 ? "insufficient" : "fresh",
    evaluatedAt: now.toISOString(),
    observedAt: bounds.currentEndsAt.toISOString(),
    current,
    lowVolume,
    baseline,
  };
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function readNumber(value: object, key: string): number | null {
  if (!(key in value)) return null;
  const candidate: unknown = Reflect.get(value, key);
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function readString(value: object, key: string): string | null {
  if (!(key in value)) return null;
  const candidate: unknown = Reflect.get(value, key);
  return typeof candidate === "string" ? candidate : null;
}

function readTvEmailBaseline(value: unknown): TvEmailBaseline | null {
  if (!isObject(value)) return null;
  const startsAt = readString(value, "startsAt");
  const endsAt = readString(value, "endsAt");
  const computedAt = readString(value, "computedAt");
  const assessableSends = readNumber(value, "assessableSends");
  const qualifiedDays = readNumber(value, "qualifiedDays");
  if (!("days" in value) || !Array.isArray(value.days)) return null;
  const days: TvEmailBaseline["days"] = [];
  for (const dayValue of value.days) {
    if (!isObject(dayValue)) return null;
    const day = readString(dayValue, "day");
    const deliveredSends = readNumber(dayValue, "deliveredSends");
    const explicitFailures = readNumber(dayValue, "explicitFailures");
    const assessableForDay = readNumber(dayValue, "assessableSends");
    const deliveryRatePercent = readNumber(dayValue, "deliveryRatePercent");
    if (day == null || deliveredSends == null || explicitFailures == null || assessableForDay == null || deliveryRatePercent == null) return null;
    days.push({ day, deliveredSends, explicitFailures, assessableSends: assessableForDay, deliveryRatePercent });
  }
  if (
    startsAt == null
    || endsAt == null
    || computedAt == null
    || assessableSends == null
    || qualifiedDays == null
  ) return null;
  const medianDeliveryRatePercent = "medianDeliveryRatePercent" in value
    && value.medianDeliveryRatePercent == null
    ? null
    : readNumber(value, "medianDeliveryRatePercent");
  return {
    startsAt,
    endsAt,
    computedAt,
    assessableSends,
    qualifiedDays,
    days,
    medianDeliveryRatePercent,
  };
}

export function readTvEmailState(value: unknown, activeClass: TvEmailEvaluatorState["activeClass"]): TvEmailEvaluatorState {
  if (!isObject(value) || readNumber(value, "ruleVersion") !== TV_EMAIL_RULE_VERSION) {
    return createTvEmailEvaluatorState({ activeClass });
  }
  const baseline = "baseline" in value ? readTvEmailBaseline(value.baseline) : null;
  const lastFreshEvaluatedAt = "lastFreshEvaluatedAt" in value && value.lastFreshEvaluatedAt == null
    ? null
    : readString(value, "lastFreshEvaluatedAt");
  let candidate: TvEmailEvaluatorState["candidate"] = null;
  if ("candidate" in value && isObject(value.candidate)) {
    const rulePath = readString(value.candidate, "rulePath");
    const presentationClass = readString(value.candidate, "presentationClass");
    const accumulatedMs = readNumber(value.candidate, "accumulatedMs");
    const borderlineEvaluations = readNumber(value.candidate, "borderlineEvaluations");
    if (
      (rulePath === "standard" || rulePath === "low-volume" || rulePath === "strict-standard" || rulePath === "strict-low-volume" || rulePath === "critical" || rulePath === "high-impact")
      && (presentationClass === "incident" || presentationClass === "critical-incident")
      && accumulatedMs != null
      && borderlineEvaluations != null
    ) {
      candidate = { rulePath, presentationClass, accumulatedMs, borderlineEvaluations };
    }
  }
  let recovery: TvEmailEvaluatorState["recovery"] = null;
  if ("recovery" in value && isObject(value.recovery)) {
    const window = readString(value.recovery, "window");
    const accumulatedMs = readNumber(value.recovery, "accumulatedMs");
    if ((window === "current" || window === "low-volume") && accumulatedMs != null) {
      recovery = { window, accumulatedMs };
    }
  }
  return {
    ruleVersion: TV_EMAIL_RULE_VERSION,
    activeClass,
    candidate,
    recovery,
    lastFreshEvaluatedAt,
    baseline,
  };
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

async function loadTvEmailBaseline(tenancy: Tenancy, now: Date): Promise<TvEmailBaseline> {
  // End before the UTC day containing the longest live window so the baseline never
  // learns from evidence that it is simultaneously evaluating as current degradation.
  const endsAt = startOfUtcDay(getTvEmailEvaluatorBounds(now).lowVolumeStartsAt);
  const startsAt = new Date(endsAt.getTime() - TV_EMAIL_BASELINE_DAYS * 24 * 60 * MINUTE_MS);
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const rows = await prisma.$replica().$queryRaw<Array<{
    day: Date,
    delivered: number,
    failures: number,
    assessable: number,
  }>>`
    WITH daily AS (
      SELECT
        date_trunc('day', "createdAt") AS day,
        COUNT(*) FILTER (
          WHERE "deliveredAt" IS NOT NULL
            AND "bouncedAt" IS NULL
            AND "sendServerErrorExternalMessage" IS NULL
        )::INT AS delivered,
        COUNT(*) FILTER (
          WHERE "bouncedAt" IS NOT NULL
            OR ("bouncedAt" IS NULL AND "sendServerErrorExternalMessage" IS NOT NULL)
        )::INT AS failures
      FROM ${sqlQuoteIdent(schema)}."EmailOutbox"
      WHERE "tenancyId" = ${tenancy.id}::UUID
        AND "createdAt" >= ${startsAt}
        AND "createdAt" < ${endsAt}
      GROUP BY day
    )
    SELECT day, delivered, failures, delivered + failures AS assessable
    FROM daily
    WHERE delivered + failures >= 10
    ORDER BY day
  `;
  return buildTvEmailBaseline({ startsAt, endsAt, computedAt: now, rows });
}

export function buildTvEmailBaseline(options: {
  startsAt: Date,
  endsAt: Date,
  computedAt: Date,
  rows: Array<{ day: Date, delivered: number, failures: number, assessable: number }>,
}): TvEmailBaseline {
  const days = options.rows.map((row) => {
    const rates = calculateTvEmailEvidenceRate(Number(row.delivered), Number(row.failures));
    if (rates.deliveryRatePercent == null) {
      throw new HexclaveAssertionError("A qualified TV email baseline day has no assessable sends.");
    }
    return {
      day: row.day.toISOString(),
      deliveredSends: Number(row.delivered),
      explicitFailures: Number(row.failures),
      assessableSends: Number(row.assessable),
      deliveryRatePercent: rates.deliveryRatePercent,
    };
  });
  const assessableSends = options.rows.reduce((total, row) => total + Number(row.assessable), 0);
  const qualifiedDays = options.rows.length;
  return {
    startsAt: options.startsAt.toISOString(),
    endsAt: options.endsAt.toISOString(),
    computedAt: options.computedAt.toISOString(),
    assessableSends,
    qualifiedDays,
    days,
    medianDeliveryRatePercent: assessableSends >= 100 && qualifiedDays >= 7
      ? median(days.map((day) => day.deliveryRatePercent))
      : null,
  };
}

function baselineNeedsRefresh(baseline: TvEmailBaseline | null, now: Date): boolean {
  if (baseline == null) return true;
  return timestampNeedsRefresh(baseline.computedAt, now, TV_EMAIL_BASELINE_REFRESH_MS);
}

function timestampNeedsRefresh(computedAt: string, now: Date, refreshIntervalMs: number): boolean {
  const computedAtMs = Date.parse(computedAt);
  const elapsedMs = now.getTime() - computedAtMs;
  return !Number.isFinite(computedAtMs) || elapsedMs < 0 || elapsedMs >= refreshIntervalMs;
}

function activeClassFromClaim(claim: EvaluatorClaimRow): TvEmailEvaluatorState["activeClass"] {
  if (claim.activePresentationClass === "CRITICAL_INCIDENT") return "critical-incident";
  if (claim.activePresentationClass === "INCIDENT") return "incident";
  return null;
}

function emailQualificationEvidence(qualification: ReturnType<typeof evaluateTvEmailDelivery>["qualification"]): {
  requiredPersistenceMs: number,
  thresholds: Record<string, number>,
} | null {
  if (qualification === "standard") return {
    requiredPersistenceMs: 3 * MINUTE_MS,
    thresholds: { minimumAssessableSends: 50, minimumExplicitFailures: 5, deliveryRateBelowPercent: 95, minimumBaselineDropPoints: 5 },
  };
  if (qualification === "low-volume") return {
    requiredPersistenceMs: 10 * MINUTE_MS,
    thresholds: { minimumAssessableSends: 20, minimumExplicitFailures: 3, deliveryRateBelowPercent: 85, minimumBaselineDropPoints: 10 },
  };
  if (qualification === "strict-standard") return {
    requiredPersistenceMs: 5 * MINUTE_MS,
    thresholds: { minimumAssessableSends: 50, minimumExplicitFailures: 10, deliveryRateBelowPercent: 85 },
  };
  if (qualification === "strict-low-volume") return {
    requiredPersistenceMs: 15 * MINUTE_MS,
    thresholds: { minimumAssessableSends: 20, minimumExplicitFailures: 5, deliveryRateBelowPercent: 75 },
  };
  if (qualification === "critical") return {
    requiredPersistenceMs: MINUTE_MS,
    thresholds: { minimumAssessableSends: 20, minimumExplicitFailures: 10, deliveryRateBelowPercent: 80 },
  };
  if (qualification === "high-impact") return {
    requiredPersistenceMs: 0,
    thresholds: { minimumExplicitFailures: 50, minimumExplicitFailureRatePercent: 10 },
  };
  if (qualification === "recovery") return {
    requiredPersistenceMs: 0,
    thresholds: {},
  };
  return null;
}

export async function persistEmailEvaluation(options: {
  tenancy: Tenancy,
  claim: EvaluatorClaimRow,
  previousState: TvEmailEvaluatorState,
  sample: TvEmailEvaluationSample,
  now: Date,
}): Promise<void> {
  const schema = await getPrismaSchemaForTenancy(options.tenancy);
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const result = evaluateTvEmailDelivery(options.previousState, options.sample);
  await retryTransaction(prisma, async (transaction) => {
    if (!(await evaluatorClaimStillCurrent(transaction, schema, options.tenancy.id, "email-delivery", options.claim))) return;
    let activeOccurrenceId = options.claim.activeOccurrenceId;
    const rulePath = result.qualification;
    const relevantWindow = rulePath === "low-volume" || rulePath === "strict-low-volume"
      ? options.sample.lowVolume
      : options.sample.current;
    const currentRate = relevantWindow?.deliveryRatePercent ?? null;
    const roundedRate = currentRate == null ? null : Math.round(currentRate * 10) / 10;
    const qualificationEvidence = rulePath === "recovery"
      ? {
        requiredPersistenceMs: (options.previousState.recovery?.window === "low-volume" ? 15 : 5) * MINUTE_MS,
        thresholds: options.sample.baseline?.medianDeliveryRatePercent == null
          ? { minimumDeliveryRatePercent: 97, maximumExplicitFailureRatePercent: 3 }
          : { minimumDeliveryRatePercent: Math.max(90, options.sample.baseline.medianDeliveryRatePercent - 2) },
      }
      : emailQualificationEvidence(rulePath);
    const observationEvidence = {
      evaluatedAt: options.sample.evaluatedAt,
      observedAt: options.sample.observedAt,
      sourceStatus: options.sample.status,
      qualification: rulePath,
      qualificationEvidence,
      accumulatedMs: result.action.type === "activate" || result.action.type === "escalate"
        ? qualificationEvidence?.requiredPersistenceMs ?? 0
        : result.action.type === "resolve"
          ? qualificationEvidence?.requiredPersistenceMs ?? 0
          : result.state.candidate?.accumulatedMs ?? result.state.recovery?.accumulatedMs ?? 0,
      current: options.sample.current,
      lowVolume: options.sample.lowVolume,
      baseline: options.sample.baseline,
    };
    const previousEvidence = isObject(options.claim.activeAggregateEvidence)
      ? options.claim.activeAggregateEvidence
      : {};
    const metricValue = roundedRate == null ? "Unavailable" : `${roundedRate}%`;
    const expectedRange = options.sample.baseline?.medianDeliveryRatePercent == null
      ? "Expected delivery range"
      : `Typical daily delivery ${Math.round(options.sample.baseline.medianDeliveryRatePercent * 10) / 10}%`;

    if (result.action.type === "activate") {
      activeOccurrenceId = generateUuid();
      const presentationClass = result.action.presentationClass === "critical-incident"
        ? "CRITICAL_INCIDENT"
        : "INCIDENT";
      await transaction.$executeRaw`
        INSERT INTO ${sqlQuoteIdent(schema)}."TvEventOccurrence" (
          "id", "tenancyId", "eventType", "presentationClass", "lifecycle",
          "deduplicationKey", "title", "summary", "metricLabel", "metricValue",
          "expectedRange", "sourceLabel", "aggregateEvidence", "occurredAt",
          "detectedAt", "activatedAt", "updatedAt"
        )
        VALUES (
          ${activeOccurrenceId}::UUID,
          ${options.tenancy.id}::UUID,
          'EMAIL_DELIVERY_DEGRADATION'::${sqlQuoteIdent(schema)}."TvEventType",
          ${presentationClass}::${sqlQuoteIdent(schema)}."TvEventPresentationClass",
          'ACTIVE'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle",
          ${`email-delivery-degradation:${activeOccurrenceId}`},
          'Email Delivery Degraded',
          ${"Email delivery is below the expected range. We’re monitoring recovery."},
          'Delivery rate',
          ${metricValue},
          ${expectedRange},
          'Hexclave email',
          ${JSON.stringify({ ruleVersion: TV_EMAIL_RULE_VERSION, activation: observationEvidence, latestActiveObservation: observationEvidence })}::JSONB,
          ${options.now},
          ${options.now},
          ${options.now},
          ${options.now}
        )
      `;
    } else if (result.action.type === "escalate") {
      if (activeOccurrenceId == null) {
        throw new HexclaveAssertionError("The TV email evaluator cannot escalate without an active occurrence.");
      }
      await transaction.$executeRaw`
        UPDATE ${sqlQuoteIdent(schema)}."TvEventOccurrence"
        SET
          "presentationClass" = 'CRITICAL_INCIDENT'::${sqlQuoteIdent(schema)}."TvEventPresentationClass",
          "escalatedAt" = ${options.now},
          "metricValue" = ${metricValue},
          "expectedRange" = ${expectedRange},
          "aggregateEvidence" = ${JSON.stringify({ ...previousEvidence, ruleVersion: TV_EMAIL_RULE_VERSION, escalation: observationEvidence, latestActiveObservation: observationEvidence })}::JSONB,
          "updatedAt" = ${options.now}
        WHERE "tenancyId" = ${options.tenancy.id}::UUID
          AND "id" = ${activeOccurrenceId}::UUID
          AND "lifecycle" = 'ACTIVE'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle"
      `;
    } else if (result.action.type === "resolve") {
      if (activeOccurrenceId == null) {
        throw new HexclaveAssertionError("The TV email evaluator cannot resolve without an active occurrence.");
      }
      await transaction.$executeRaw`
        UPDATE ${sqlQuoteIdent(schema)}."TvEventOccurrence"
        SET
          "lifecycle" = 'RESOLVED'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle",
          "resolvedAt" = ${options.now},
          "title" = ${TV_EMAIL_RECOVERY_TITLE},
          "summary" = 'Email delivery is back within the expected range.',
          "metricValue" = ${metricValue},
          "expectedRange" = ${expectedRange},
          "aggregateEvidence" = ${JSON.stringify({ ...previousEvidence, ruleVersion: TV_EMAIL_RULE_VERSION, resolution: observationEvidence })}::JSONB,
          "updatedAt" = ${options.now}
        WHERE "tenancyId" = ${options.tenancy.id}::UUID
          AND "id" = ${activeOccurrenceId}::UUID
          AND "lifecycle" = 'ACTIVE'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle"
      `;
      activeOccurrenceId = null;
    } else if (activeOccurrenceId != null) {
      await transaction.$executeRaw`
        UPDATE ${sqlQuoteIdent(schema)}."TvEventOccurrence"
        SET
          "metricValue" = ${metricValue},
          "expectedRange" = ${expectedRange},
          "aggregateEvidence" = ${JSON.stringify({ ...previousEvidence, ruleVersion: TV_EMAIL_RULE_VERSION, latestActiveObservation: observationEvidence })}::JSONB,
          "updatedAt" = ${options.now}
        WHERE "tenancyId" = ${options.tenancy.id}::UUID
          AND "id" = ${activeOccurrenceId}::UUID
          AND "lifecycle" = 'ACTIVE'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle"
      `;
    }

    await transaction.$executeRaw`
      UPDATE ${sqlQuoteIdent(schema)}."TvEventEvaluatorState"
      SET
        "breachCount" = 0,
        "criticalBreachCount" = 0,
        "recoveryCount" = 0,
        "typedState" = ${JSON.stringify(result.state)}::JSONB,
        "activeOccurrenceId" = ${activeOccurrenceId}::UUID,
        "updatedAt" = ${options.now}
      WHERE "tenancyId" = ${options.tenancy.id}::UUID
        AND "evaluatorKey" = 'email-delivery'
    `;
  });
}

async function evaluateEmailIfDue(tenancy: Tenancy, now: Date): Promise<void> {
  if (!(tenancy.config.apps.installed.emails?.enabled ?? false)) return;
  const claim = await claimEvaluator(tenancy, "email-delivery", now);
  if (claim == null) return;
  const state = readTvEmailState(claim.typedState, activeClassFromClaim(claim));
  let baseline = state.baseline;
  if (baselineNeedsRefresh(baseline, now)) {
    baseline = await loadTvEmailBaseline(tenancy, now).then(
      (loaded) => loaded,
      (cause: unknown) => {
        captureError("tv-email-baseline-refresh-failed", new HexclaveAssertionError(
          "The TV email evaluator baseline refresh failed; evaluation will use the last cached baseline or strict fallback rules.",
          { cause, tenancyId: tenancy.id },
        ));
        return baseline;
      },
    );
  }
  const sample = await loadEmailEvaluatorSample(tenancy, now, baseline);
  await persistEmailEvaluation({ tenancy, claim, previousState: state, sample, now });
}

export function readTvPaymentState(value: unknown, activeClass: TvPaymentEvaluatorState["activeClass"]): TvPaymentEvaluatorState {
  if (!isObject(value) || readNumber(value, "ruleVersion") !== TV_PAYMENT_RULE_VERSION) {
    return createTvPaymentEvaluatorState({ activeClass });
  }
  // Evaluator state is written exclusively by evaluateTvSubscriptionCollection;
  // validate the stable outer contract and reset safely on incompatible versions.
  const baselineValue = "baseline" in value && isObject(value.baseline) ? value.baseline : null;
  const medianRate = baselineValue == null || !("medianSuccessRatePercent" in baselineValue) || baselineValue.medianSuccessRatePercent == null
    ? null
    : readNumber(baselineValue, "medianSuccessRatePercent");
  const baseline: TvPaymentBaseline | null = baselineValue == null ? null : {
    computedAt: readString(baselineValue, "computedAt") ?? "",
    qualifiedWeeks: readNumber(baselineValue, "qualifiedWeeks") ?? 0,
    assessableOutcomes: readNumber(baselineValue, "assessableOutcomes") ?? 0,
    medianSuccessRatePercent: medianRate,
  };
  const freshAt = !("lastFreshEvaluatedAt" in value) || value.lastFreshEvaluatedAt == null ? null : readString(value, "lastFreshEvaluatedAt");
  let candidate: TvPaymentEvaluatorState["candidate"] = null;
  if ("candidate" in value && isObject(value.candidate)) {
    const rulePath = readString(value.candidate, "rulePath");
    const presentationClass = readString(value.candidate, "presentationClass");
    const accumulatedMs = readNumber(value.candidate, "accumulatedMs");
    if (
      (rulePath === "standard" || rulePath === "low-volume" || rulePath === "strict" || rulePath === "critical" || rulePath === "strict-critical" || rulePath === "low-volume-critical")
      && (presentationClass === "incident" || presentationClass === "critical-incident")
      && accumulatedMs != null
    ) candidate = { rulePath, presentationClass, accumulatedMs };
  }
  let recovery: TvPaymentEvaluatorState["recovery"] = null;
  if ("recovery" in value && isObject(value.recovery)) {
    const window = readString(value.recovery, "window");
    const accumulatedMs = readNumber(value.recovery, "accumulatedMs");
    if ((window === "current" || window === "low-volume") && accumulatedMs != null) recovery = { window, accumulatedMs };
  }
  return { ruleVersion: TV_PAYMENT_RULE_VERSION, activeClass, baseline, lastFreshEvaluatedAt: freshAt, candidate, recovery };
}

export function getTvPaymentEvidenceWindow(
  qualification: TvPaymentRulePath | "recovery" | null,
  sample: TvPaymentSample,
): TvPaymentWindow | null {
  switch (qualification) {
    case "low-volume": {
      return sample.lowVolume;
    }
    case "strict": {
      return sample.lowVolume;
    }
    case "strict-critical": {
      return sample.lowVolume;
    }
    case "low-volume-critical": {
      return sample.lowVolume;
    }
    case "standard": {
      return sample.current;
    }
    case "critical": {
      return sample.current;
    }
    case "recovery": {
      return sample.current;
    }
    case null: {
      return sample.current;
    }
    default: {
      throw new Error(`Unknown TV payment qualification: ${qualification}`);
    }
  }
}

export async function loadTvSubscriptionCollectionOutcomes(
  tenancy: Tenancy,
  startsAt: Date,
  endsAt: Date,
): Promise<Array<{ outcomeAt: Date, success: boolean }>> {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  return await prisma.$replica().$queryRaw<Array<{ outcomeAt: Date, success: boolean }>>`
    WITH raw_candidates AS (
      SELECT "id", "paidAt", "markedUncollectibleAt", "voidedAt", "amountPaid", "amountTotal"
      FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
      WHERE "tenancyId" = ${tenancy.id}::UUID AND "paidAt" >= ${startsAt} AND "paidAt" < ${endsAt}
      UNION ALL
      SELECT "id", "paidAt", "markedUncollectibleAt", "voidedAt", "amountPaid", "amountTotal"
      FROM ${sqlQuoteIdent(schema)}."SubscriptionInvoice"
      WHERE "tenancyId" = ${tenancy.id}::UUID
        AND "markedUncollectibleAt" >= ${startsAt} AND "markedUncollectibleAt" < ${endsAt}
    ), candidates AS (
      -- Both branches read the same current invoice row. Deduplicating only by ID
      -- keeps one contribution without widening the candidate index scans.
      SELECT DISTINCT ON ("id") *
      FROM raw_candidates
      ORDER BY "id"
    ), selected AS (
      SELECT *, GREATEST("paidAt", "markedUncollectibleAt", "voidedAt") AS "outcomeAt"
      FROM candidates
    )
    SELECT "outcomeAt", COALESCE("paidAt" = "outcomeAt", FALSE) AS success
    FROM selected
    WHERE "outcomeAt" >= ${startsAt} AND "outcomeAt" < ${endsAt}
      AND (
        -- A zero-value invoice has no collection attempt to assess. Preserve
        -- its authoritative terminal state, but keep it out of health rates.
        ("paidAt" = "outcomeAt" AND COALESCE("amountPaid", 0) > 0)
        OR (
          "paidAt" IS DISTINCT FROM "outcomeAt"
          AND "voidedAt" IS DISTINCT FROM "outcomeAt"
          AND "markedUncollectibleAt" = "outcomeAt"
          AND COALESCE("amountTotal", 0) > 0
        )
      )
  `;
}

function paymentWindow(startsAt: Date, endsAt: Date, rows: Array<{ outcomeAt: Date, success: boolean }>) {
  const successes = rows.filter((row) => row.success).length;
  const outcomes = rows.length;
  return {
    startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), outcomes, successes,
    failures: outcomes - successes,
    successRatePercent: outcomes === 0 ? null : Math.round(successes / outcomes * 1000) / 10,
  };
}

async function loadPaymentBaseline(tenancy: Tenancy, now: Date): Promise<TvPaymentBaseline> {
  const endsAt = new Date(now.getTime() - 14 * 24 * 60 * MINUTE_MS);
  const startsAt = new Date(endsAt.getTime() - 12 * 7 * 24 * 60 * MINUTE_MS);
  const rows = await loadTvSubscriptionCollectionOutcomes(tenancy, startsAt, endsAt);
  const weeks = Array.from({ length: 12 }, (_, index) => {
    const weekStartsAt = new Date(startsAt.getTime() + index * 7 * 24 * 60 * MINUTE_MS);
    const weekEndsAt = new Date(weekStartsAt.getTime() + 7 * 24 * 60 * MINUTE_MS);
    return paymentWindow(weekStartsAt, weekEndsAt, rows.filter((row) => row.outcomeAt >= weekStartsAt && row.outcomeAt < weekEndsAt));
  }).filter((week) => week.outcomes >= 5 && week.successRatePercent != null);
  const assessableOutcomes = weeks.reduce((total, week) => total + week.outcomes, 0);
  return {
    computedAt: now.toISOString(), qualifiedWeeks: weeks.length, assessableOutcomes,
    medianSuccessRatePercent: weeks.length >= 4 && assessableOutcomes >= 40
      ? median(weeks.map((week) => week.successRatePercent ?? 0))
      : null,
  };
}

async function persistPaymentEvaluation(options: { tenancy: Tenancy, claim: EvaluatorClaimRow, state: TvPaymentEvaluatorState, sample: TvPaymentSample, now: Date }) {
  const result = evaluateTvSubscriptionCollection(options.state, options.sample);
  const schema = await getPrismaSchemaForTenancy(options.tenancy);
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  await retryTransaction(prisma, async (transaction) => {
    if (!(await evaluatorClaimStillCurrent(transaction, schema, options.tenancy.id, "subscription-collection", options.claim))) return;
    let activeOccurrenceId = options.claim.activeOccurrenceId;
    const window = getTvPaymentEvidenceWindow(result.qualification, options.sample);
    const metricValue = window?.successRatePercent == null ? "Unavailable" : `${window.successRatePercent}%`;
    const evidence = { ruleVersion: TV_PAYMENT_RULE_VERSION, evaluatedAt: options.sample.evaluatedAt, qualification: result.qualification, current: options.sample.current, lowVolume: options.sample.lowVolume, baseline: options.sample.baseline };
    const previousEvidence = isObject(options.claim.activeAggregateEvidence) ? options.claim.activeAggregateEvidence : {};
    if (result.action.type === "activate") {
      activeOccurrenceId = generateUuid();
      await transaction.$executeRaw`
        INSERT INTO ${sqlQuoteIdent(schema)}."TvEventOccurrence" (
          "id", "tenancyId", "eventType", "presentationClass", "lifecycle", "deduplicationKey",
          "title", "summary", "metricLabel", "metricValue", "expectedRange", "sourceLabel",
          "aggregateEvidence", "occurredAt", "detectedAt", "activatedAt", "updatedAt"
        ) VALUES (
          ${activeOccurrenceId}::UUID, ${options.tenancy.id}::UUID,
          'SUBSCRIPTION_COLLECTION_DEGRADATION'::${sqlQuoteIdent(schema)}."TvEventType",
          ${result.action.presentationClass === "critical-incident" ? "CRITICAL_INCIDENT" : "INCIDENT"}::${sqlQuoteIdent(schema)}."TvEventPresentationClass",
          'ACTIVE'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle", ${`subscription-collection:${activeOccurrenceId}`},
          'Subscription Payments Degraded', 'Subscription collection is below the expected range. We’re monitoring recovery.',
          'Payment Success', ${metricValue}, 'Expected collection range', 'Hexclave payments',
          ${JSON.stringify({ activation: evidence, latestActiveObservation: evidence })}::JSONB,
          ${options.now}, ${options.now}, ${options.now}, ${options.now}
        )
      `;
    } else if (activeOccurrenceId != null && result.action.type === "escalate") {
      await transaction.$executeRaw`UPDATE ${sqlQuoteIdent(schema)}."TvEventOccurrence" SET "presentationClass" = 'CRITICAL_INCIDENT'::${sqlQuoteIdent(schema)}."TvEventPresentationClass", "escalatedAt" = ${options.now}, "metricValue" = ${metricValue}, "aggregateEvidence" = ${JSON.stringify({ ...previousEvidence, escalation: evidence, latestActiveObservation: evidence })}::JSONB, "updatedAt" = ${options.now} WHERE "tenancyId" = ${options.tenancy.id}::UUID AND "id" = ${activeOccurrenceId}::UUID AND "lifecycle" = 'ACTIVE'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle"`;
    } else if (activeOccurrenceId != null && result.action.type === "resolve") {
      await transaction.$executeRaw`UPDATE ${sqlQuoteIdent(schema)}."TvEventOccurrence" SET "lifecycle" = 'RESOLVED'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle", "resolvedAt" = ${options.now}, "title" = ${TV_PAYMENT_RECOVERY_TITLE}, "summary" = 'Subscription collection is back within the expected range.', "metricValue" = ${metricValue}, "aggregateEvidence" = ${JSON.stringify({ ...previousEvidence, resolution: evidence })}::JSONB, "updatedAt" = ${options.now} WHERE "tenancyId" = ${options.tenancy.id}::UUID AND "id" = ${activeOccurrenceId}::UUID AND "lifecycle" = 'ACTIVE'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle"`;
      activeOccurrenceId = null;
    } else if (activeOccurrenceId != null) {
      await transaction.$executeRaw`UPDATE ${sqlQuoteIdent(schema)}."TvEventOccurrence" SET "metricValue" = ${metricValue}, "aggregateEvidence" = ${JSON.stringify({ ...previousEvidence, latestActiveObservation: evidence })}::JSONB, "updatedAt" = ${options.now} WHERE "tenancyId" = ${options.tenancy.id}::UUID AND "id" = ${activeOccurrenceId}::UUID AND "lifecycle" = 'ACTIVE'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle"`;
    }
    await transaction.$executeRaw`UPDATE ${sqlQuoteIdent(schema)}."TvEventEvaluatorState" SET "typedState" = ${JSON.stringify(result.state)}::JSONB, "activeOccurrenceId" = ${activeOccurrenceId}::UUID, "updatedAt" = ${options.now} WHERE "tenancyId" = ${options.tenancy.id}::UUID AND "evaluatorKey" = 'subscription-collection'`;
  });
}

async function evaluatePaymentIfDue(tenancy: Tenancy, now: Date): Promise<void> {
  if (!(tenancy.config.apps.installed.payments?.enabled ?? false)) return;
  const claim = await claimEvaluator(tenancy, "subscription-collection", now);
  if (claim == null) return;
  const state = readTvPaymentState(claim.typedState, activeClassFromClaim(claim));
  let baseline = state.baseline;
  if (baseline == null || timestampNeedsRefresh(baseline.computedAt, now, TV_PAYMENT_BASELINE_REFRESH_MS)) {
    baseline = await loadPaymentBaseline(tenancy, now).catch((cause: unknown) => {
      captureError("tv-payment-baseline-refresh-failed", new HexclaveAssertionError("TV payment baseline refresh failed; strict fallback remains active.", { cause, tenancyId: tenancy.id }));
      return baseline;
    });
  }
  const lowStartsAt = new Date(now.getTime() - 14 * 24 * 60 * MINUTE_MS);
  const currentStartsAt = new Date(now.getTime() - 24 * 60 * MINUTE_MS);
  const outcomes = await loadTvSubscriptionCollectionOutcomes(tenancy, lowStartsAt, now);
  const sample: TvPaymentSample = { status: "fresh", evaluatedAt: now.toISOString(), observedAt: now.toISOString(), current: paymentWindow(currentStartsAt, now, outcomes.filter((row) => row.outcomeAt >= currentStartsAt)), lowVolume: paymentWindow(lowStartsAt, now, outcomes), baseline };
  await persistPaymentEvaluation({ tenancy, claim, state: { ...state, baseline }, sample, now });
}

async function evaluateMilestoneIfDue(
  tenancy: Tenancy,
  now: Date,
  totalUsers: number,
): Promise<void> {
  const claim = await claimEvaluator(tenancy, "user-milestone", now);
  if (claim == null) return;
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const result = evaluateTvUserMilestone({
    baselineEstablished: claim.milestoneBaseline != null,
    highestConsumedThreshold: Number(claim.milestoneBaseline ?? 0),
    lastObservedTotal: readLastObservedTotal(claim.typedState),
  }, totalUsers);

  await retryTransaction(prisma, async (transaction) => {
    if (!(await evaluatorClaimStillCurrent(transaction, schema, tenancy.id, "user-milestone", claim))) return;
    if (result.crossedThreshold != null) {
      const occurrenceId = generateUuid();
      const formattedThreshold = new Intl.NumberFormat("en-US", {
        notation: result.crossedThreshold >= 1000 ? "compact" : "standard",
        maximumFractionDigits: 0,
      }).format(result.crossedThreshold);
      await transaction.$executeRaw`
        INSERT INTO ${sqlQuoteIdent(schema)}."TvEventOccurrence" (
          "id", "tenancyId", "eventType", "presentationClass", "lifecycle",
          "deduplicationKey", "title", "summary", "metricLabel", "metricValue",
          "sourceLabel", "aggregateEvidence", "occurredAt", "detectedAt", "activatedAt",
          "updatedAt"
        )
        VALUES (
          ${occurrenceId}::UUID,
          ${tenancy.id}::UUID,
          'USER_MILESTONE'::${sqlQuoteIdent(schema)}."TvEventType",
          'CELEBRATION'::${sqlQuoteIdent(schema)}."TvEventPresentationClass",
          'OCCURRED'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle",
          ${`user-milestone:${result.crossedThreshold}`},
          ${`${formattedThreshold} Users`},
          'The community reached a new milestone—worth celebrating together.',
          'Total users',
          ${new Intl.NumberFormat("en-US").format(totalUsers)},
          'Hexclave users',
          ${JSON.stringify({
            threshold: result.crossedThreshold,
            observedTotalUsers: totalUsers,
          })}::JSONB,
          ${now},
          ${now},
          ${now},
          ${now}
        )
        ON CONFLICT ("tenancyId", "deduplicationKey") DO NOTHING
      `;
    }
    await transaction.$executeRaw`
      UPDATE ${sqlQuoteIdent(schema)}."TvEventEvaluatorState"
      SET
        "milestoneBaseline" = ${BigInt(result.state.highestConsumedThreshold)},
        "typedState" = ${JSON.stringify({
          lastObservedTotal: result.state.lastObservedTotal,
        })}::JSONB,
        "updatedAt" = ${now}
      WHERE "tenancyId" = ${tenancy.id}::UUID
        AND "evaluatorKey" = 'user-milestone'
    `;
  });
}

export async function evaluateTvEventsIfDue(options: {
  tenancy: Tenancy,
  now: Date,
  totalUsers: number | null,
  eventTablesReady?: boolean,
}): Promise<void> {
  if (!(options.eventTablesReady ?? await tvEventTablesAreReady(options.tenancy))) return;
  try {
    await evaluateEmailIfDue(options.tenancy, options.now);
  } catch (cause) {
    captureError("tv-email-event-evaluator-failed", new HexclaveAssertionError(
      "The TV email event evaluator failed without affecting the operational snapshot.",
      { cause, tenancyId: options.tenancy.id },
    ));
  }
  try {
    await evaluatePaymentIfDue(options.tenancy, options.now);
  } catch (cause) {
    captureError("tv-payment-event-evaluator-failed", new HexclaveAssertionError(
      "The TV payment event evaluator failed without affecting the operational snapshot.",
      { cause, tenancyId: options.tenancy.id },
    ));
  }
  if (options.totalUsers == null) return;
  try {
    await evaluateMilestoneIfDue(options.tenancy, options.now, options.totalUsers);
  } catch (cause) {
    captureError("tv-user-milestone-evaluator-failed", new HexclaveAssertionError(
      "The TV user milestone evaluator failed without affecting the operational snapshot.",
      { cause, tenancyId: options.tenancy.id },
    ));
  }
}

function addSeconds(timestamp: Date, seconds: number): Date {
  return new Date(timestamp.getTime() + seconds * 1000);
}

function presentationClass(occurrence: TvEventOccurrenceRow): TvDurableEventOccurrence["presentationClass"] {
  switch (occurrence.presentationClass) {
    case "CELEBRATION": {
      return "celebration";
    }
    case "INCIDENT": {
      return "incident";
    }
    case "CRITICAL_INCIDENT": {
      return "critical-incident";
    }
    default: {
      throw new HexclaveAssertionError("TV event occurrence has an unsupported presentation class.");
    }
  }
}

function occurrenceLifecycle(occurrence: TvEventOccurrenceRow): TvDurableEventOccurrence["lifecycle"] {
  switch (occurrence.lifecycle) {
    case "OCCURRED": {
      return "occurred";
    }
    case "ACTIVE": {
      return "active";
    }
    case "RESOLVED": {
      return "resolved";
    }
    default: {
      throw new HexclaveAssertionError("TV event occurrence has an unsupported lifecycle.");
    }
  }
}

function occurrenceType(occurrence: TvEventOccurrenceRow): TvDurableEventOccurrence["type"] {
  switch (occurrence.eventType) {
    case "EMAIL_DELIVERY_DEGRADATION": {
      return "email-delivery-degradation";
    }
    case "SUBSCRIPTION_COLLECTION_DEGRADATION": {
      return "subscription-collection-degradation";
    }
    case "USER_MILESTONE": {
      return "user-milestone";
    }
    default: {
      throw new HexclaveAssertionError("TV event occurrence has an unsupported event type.");
    }
  }
}

function isEligible(
  occurrence: TvEventOccurrenceRow,
  preferences: TvInterruptionPreferences,
): boolean {
  switch (occurrence.eventType) {
    case "EMAIL_DELIVERY_DEGRADATION": {
      return preferences.incidentTypes.emailDeliveryDegradation;
    }
    case "SUBSCRIPTION_COLLECTION_DEGRADATION": {
      return preferences.incidentTypes.subscriptionCollectionDegradation;
    }
    case "USER_MILESTONE": {
      return preferences.celebrations.userMilestone;
    }
    default: {
      throw new HexclaveAssertionError("TV event occurrence has an unsupported event type.");
    }
  }
}

function durableOccurrence(occurrence: TvEventOccurrenceRow): TvDurableEventOccurrence {
  return {
    id: occurrence.id,
    type: occurrenceType(occurrence),
    presentationClass: presentationClass(occurrence),
    lifecycle: occurrenceLifecycle(occurrence),
    occurredAt: occurrence.occurredAt,
    activatedAt: occurrence.activatedAt ?? occurrence.occurredAt,
    resolvedAt: occurrence.resolvedAt,
  };
}

async function loadOccurrences(
  tenancy: Tenancy,
  now: Date,
): Promise<TvEventOccurrenceRow[]> {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  const lookback = new Date(now.getTime() - MAX_EVENT_LOOKBACK_MS);
  return await prisma.$queryRaw<TvEventOccurrenceRow[]>`
    SELECT
      "id", "eventType", "presentationClass", "lifecycle", "title", "summary",
      "metricLabel", "metricValue", "expectedRange", "sourceLabel",
      "occurredAt", "activatedAt", "escalatedAt", "resolvedAt", "updatedAt"
    FROM ${sqlQuoteIdent(schema)}."TvEventOccurrence"
    WHERE "tenancyId" = ${tenancy.id}::UUID
      AND (
        "lifecycle" = 'ACTIVE'::${sqlQuoteIdent(schema)}."TvEventOccurrenceLifecycle"
        OR "occurredAt" >= ${lookback}
        OR "resolvedAt" >= ${lookback}
      )
    ORDER BY "occurredAt" DESC, "id"
  `;
}

export async function synchronizeTvProfileAssignments(options: {
  tenancy: Tenancy,
  profile: TvProfileResource,
  occurrences: TvEventOccurrenceRow[],
  now: Date,
}): Promise<void> {
  const schema = await getPrismaSchemaForTenancy(options.tenancy);
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const preferences = options.profile.configuration.interruptionPreferences;
  const existingAssignments = new Map(
    (await loadAssignments(options.tenancy, options.profile.id)).map((assignment) => [assignment.occurrenceId, assignment]),
  );
  const activeIncident = options.occurrences.some((occurrence) => (
    occurrence.lifecycle === "ACTIVE"
    && occurrence.presentationClass !== "CELEBRATION"
    && isEligible(occurrence, preferences)
  ));
  const recoveryConfirmationActive = options.occurrences.some((occurrence) => (
    occurrence.presentationClass !== "CELEBRATION"
    && occurrence.resolvedAt != null
    && options.now.getTime() < (
      existingAssignments.get(occurrence.id)?.recoveryEndsAt
      ?? addSeconds(
        occurrence.resolvedAt,
        occurrence.presentationClass === "CRITICAL_INCIDENT"
          ? preferences.timing.criticalIncident.recoveryTakeoverSeconds
          : preferences.timing.incident.recoveryTakeoverSeconds,
      )
    ).getTime()
    && isEligible(occurrence, preferences)
  ));
  const celebrationPresentationBlocked = activeIncident || recoveryConfirmationActive;
  const newestEligibleCelebrationId = options.occurrences.find((occurrence) => (
    occurrence.presentationClass === "CELEBRATION"
    && isEligible(occurrence, preferences)
  ))?.id ?? null;
  const policyDisabledAssignmentIds = options.occurrences
    .filter((occurrence) => (
      !isEligible(occurrence, preferences)
      && existingAssignments.has(occurrence.id)
      && existingAssignments.get(occurrence.id)?.supersededAt == null
    ))
    .map((occurrence) => occurrence.id);
  if (policyDisabledAssignmentIds.length > 0) {
    await prisma.$executeRaw`
      UPDATE ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"
      SET
        "supersededAt" = ${options.now},
        "supersededReason" = 'POLICY_DISABLED'::${sqlQuoteIdent(schema)}."TvPresentationSupersededReason",
        "updatedAt" = ${options.now}
      WHERE "tenancyId" = ${options.tenancy.id}::UUID
        AND "profileId" = ${options.profile.id}
        AND "occurrenceId" IN (${Prisma.join(
          policyDisabledAssignmentIds.map((occurrenceId) => Prisma.sql`${occurrenceId}::UUID`),
        )})
        AND "supersededAt" IS NULL
    `;
  }
  const newestCelebrationAssignment = newestEligibleCelebrationId == null
    ? null
    : existingAssignments.get(newestEligibleCelebrationId);
  const staleCelebrationAssignmentIds = newestCelebrationAssignment == null
    ? []
    : options.occurrences
      .filter((occurrence) => (
        occurrence.presentationClass === "CELEBRATION"
        && occurrence.id !== newestEligibleCelebrationId
        && existingAssignments.has(occurrence.id)
        && existingAssignments.get(occurrence.id)?.supersededAt == null
      ))
      .map((occurrence) => occurrence.id);
  // The initial celebration insert supersedes older rows atomically. This
  // batched reconciliation covers a stale concurrent reader that inserted an
  // older celebration immediately after that transaction committed.
  if (staleCelebrationAssignmentIds.length > 0) {
    await prisma.$executeRaw`
      UPDATE ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"
      SET
        "supersededAt" = ${options.now},
        "supersededReason" = 'NEWER_CELEBRATION'::${sqlQuoteIdent(schema)}."TvPresentationSupersededReason",
        "updatedAt" = ${options.now}
      WHERE "tenancyId" = ${options.tenancy.id}::UUID
        AND "profileId" = ${options.profile.id}
        AND "occurrenceId" IN (${Prisma.join(
          staleCelebrationAssignmentIds.map((occurrenceId) => Prisma.sql`${occurrenceId}::UUID`),
        )})
        AND "supersededAt" IS NULL
    `;
  }
  for (const occurrence of options.occurrences) {
    if (!isEligible(occurrence, preferences)) {
      continue;
    }

    const existingAssignment = existingAssignments.get(occurrence.id);
    if (occurrence.presentationClass === "CELEBRATION") {
      if (occurrence.id !== newestEligibleCelebrationId) continue;
      // A celebration assignment is immutable after its first writer. The
      // pending-celebration block below owns the one later transition from a
      // suspended assignment into its bounded takeover.
      if (existingAssignment != null) continue;
      const provisionalAssignment = createTvPresentationAssignment({
        occurrence: durableOccurrence(occurrence),
        preferences,
        takeoverStartedAt: celebrationPresentationBlocked ? null : options.now,
      });
      const highlightExpiresAt = provisionalAssignment.highlightExpiresAt;
      const animationExpiresAt = provisionalAssignment.animationExpiresAt;
      if (highlightExpiresAt == null || animationExpiresAt == null) {
        throw new HexclaveAssertionError("A celebration assignment must define Highlight and animation deadlines.");
      }
      const expired = options.now.getTime() >= highlightExpiresAt.getTime();
      const takeoverStartedAt = celebrationPresentationBlocked || expired ? null : options.now;
      const assignment = takeoverStartedAt === provisionalAssignment.takeoverStartedAt
        ? provisionalAssignment
        : createTvPresentationAssignment({
          occurrence: durableOccurrence(occurrence),
          preferences,
          takeoverStartedAt,
        });
      await retryTransaction(prisma, async (transaction) => {
        await transaction.$executeRaw`
          UPDATE ${sqlQuoteIdent(schema)}."TvProfileEventPresentation" presentation
          SET
            "supersededAt" = ${options.now},
            "supersededReason" = 'NEWER_CELEBRATION'::${sqlQuoteIdent(schema)}."TvPresentationSupersededReason",
            "updatedAt" = ${options.now}
          FROM ${sqlQuoteIdent(schema)}."TvEventOccurrence" previous
          WHERE presentation."tenancyId" = ${options.tenancy.id}::UUID
            AND presentation."profileId" = ${options.profile.id}
            AND previous."tenancyId" = presentation."tenancyId"
            AND previous."id" = presentation."occurrenceId"
            AND previous."presentationClass" = 'CELEBRATION'::${sqlQuoteIdent(schema)}."TvEventPresentationClass"
            AND previous."occurredAt" < ${occurrence.occurredAt}
            AND presentation."supersededAt" IS NULL
        `;
        await transaction.$executeRaw`
          INSERT INTO ${sqlQuoteIdent(schema)}."TvProfileEventPresentation" (
            "tenancyId", "profileId", "occurrenceId", "takeoverStartedAt",
            "takeoverEndsAt", "highlightExpiresAt", "animationExpiresAt",
            "supersededAt", "supersededReason", "updatedAt"
          )
          VALUES (
            ${options.tenancy.id}::UUID,
            ${options.profile.id},
            ${occurrence.id}::UUID,
            ${takeoverStartedAt},
            ${assignment.takeoverEndsAt},
            ${highlightExpiresAt},
            ${animationExpiresAt},
            ${expired ? options.now : null},
            ${expired ? "EXPIRED_BEFORE_PRESENTATION" : null}::${sqlQuoteIdent(schema)}."TvPresentationSupersededReason",
            ${options.now}
          )
          ON CONFLICT ("tenancyId", "profileId", "occurrenceId") DO NOTHING
        `;
      });
      continue;
    }

    const takeoverStartedAt = occurrence.presentationClass === "CRITICAL_INCIDENT"
      ? occurrence.escalatedAt ?? occurrence.activatedAt ?? occurrence.occurredAt
      : occurrence.activatedAt ?? occurrence.occurredAt;
    const assignment = createTvPresentationAssignment({
      occurrence: durableOccurrence(occurrence),
      preferences,
      takeoverStartedAt,
    });
    const takeoverEndsAt = assignment.takeoverEndsAt;
    const recoveryEndsAt = assignment.recoveryEndsAt;
    const highlightExpiresAt = assignment.highlightExpiresAt;
    const assignmentNeedsWrite = existingAssignment == null
      || (
        existingAssignment.takeoverStartedAt != null
        && takeoverStartedAt.getTime() > existingAssignment.takeoverStartedAt.getTime()
      )
      || (existingAssignment.recoveryEndsAt == null && recoveryEndsAt != null)
      || (existingAssignment.highlightExpiresAt == null && highlightExpiresAt != null);
    if (!assignmentNeedsWrite) continue;
    await prisma.$executeRaw`
      INSERT INTO ${sqlQuoteIdent(schema)}."TvProfileEventPresentation" (
        "tenancyId", "profileId", "occurrenceId", "takeoverStartedAt",
        "takeoverEndsAt", "recoveryEndsAt", "highlightExpiresAt", "updatedAt"
      )
      VALUES (
        ${options.tenancy.id}::UUID,
        ${options.profile.id},
        ${occurrence.id}::UUID,
        ${takeoverStartedAt},
        ${takeoverEndsAt},
        ${recoveryEndsAt},
        ${highlightExpiresAt},
        ${options.now}
      )
      ON CONFLICT ("tenancyId", "profileId", "occurrenceId")
      DO UPDATE SET
        "takeoverStartedAt" = CASE
          WHEN EXCLUDED."takeoverStartedAt" > ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"."takeoverStartedAt"
            THEN EXCLUDED."takeoverStartedAt"
          ELSE ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"."takeoverStartedAt"
        END,
        "takeoverEndsAt" = CASE
          WHEN EXCLUDED."takeoverStartedAt" > ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"."takeoverStartedAt"
            THEN EXCLUDED."takeoverEndsAt"
          ELSE ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"."takeoverEndsAt"
        END,
        "recoveryEndsAt" = COALESCE(
          ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"."recoveryEndsAt",
          EXCLUDED."recoveryEndsAt"
        ),
        -- A resolved Highlight is also an assigned phase. Preserve its original
        -- deadline so profile edits only affect future resolutions.
        "highlightExpiresAt" = COALESCE(
          ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"."highlightExpiresAt",
          EXCLUDED."highlightExpiresAt"
        ),
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE
        EXCLUDED."takeoverStartedAt" > ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"."takeoverStartedAt"
        OR (
          ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"."recoveryEndsAt" IS NULL
          AND EXCLUDED."recoveryEndsAt" IS NOT NULL
        )
        OR (
          ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"."highlightExpiresAt" IS NULL
          AND EXCLUDED."highlightExpiresAt" IS NOT NULL
        )
    `;
  }

  if (!celebrationPresentationBlocked) {
    const pending = await prisma.$queryRaw<Array<{
      occurrenceId: string,
      occurredAt: Date,
      highlightExpiresAt: Date,
    }>>`
      SELECT
        presentation."occurrenceId",
        occurrence."occurredAt",
        presentation."highlightExpiresAt"
      FROM ${sqlQuoteIdent(schema)}."TvProfileEventPresentation" presentation
      JOIN ${sqlQuoteIdent(schema)}."TvEventOccurrence" occurrence
        ON occurrence."tenancyId" = presentation."tenancyId"
        AND occurrence."id" = presentation."occurrenceId"
      WHERE presentation."tenancyId" = ${options.tenancy.id}::UUID
        AND presentation."profileId" = ${options.profile.id}
        AND occurrence."presentationClass" = 'CELEBRATION'::${sqlQuoteIdent(schema)}."TvEventPresentationClass"
        AND presentation."takeoverStartedAt" IS NULL
        AND presentation."supersededAt" IS NULL
      ORDER BY occurrence."occurredAt" DESC, occurrence."id"
      LIMIT 1
    `;
    const candidate = pending.at(0);
    if (candidate != null) {
      if (options.now.getTime() >= candidate.highlightExpiresAt.getTime()) {
        await prisma.$executeRaw`
          UPDATE ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"
          SET
            "supersededAt" = ${options.now},
            "supersededReason" = 'EXPIRED_BEFORE_PRESENTATION'::${sqlQuoteIdent(schema)}."TvPresentationSupersededReason",
            "updatedAt" = ${options.now}
          WHERE "tenancyId" = ${options.tenancy.id}::UUID
            AND "profileId" = ${options.profile.id}
            AND "occurrenceId" = ${candidate.occurrenceId}::UUID
        `;
      } else {
        await prisma.$executeRaw`
          UPDATE ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"
          SET
            "takeoverStartedAt" = ${options.now},
            "takeoverEndsAt" = ${addSeconds(
              options.now,
              preferences.timing.celebration.takeoverSeconds,
            )},
            "updatedAt" = ${options.now}
          WHERE "tenancyId" = ${options.tenancy.id}::UUID
            AND "profileId" = ${options.profile.id}
            AND "occurrenceId" = ${candidate.occurrenceId}::UUID
            AND "takeoverStartedAt" IS NULL
            AND "supersededAt" IS NULL
        `;
      }
    }
  }
}

async function loadAssignments(
  tenancy: Tenancy,
  profileId: string,
): Promise<AssignmentRow[]> {
  const schema = await getPrismaSchemaForTenancy(tenancy);
  const prisma = await getPrismaClientForTenancy(tenancy);
  return await prisma.$queryRaw<AssignmentRow[]>`
    SELECT
      "occurrenceId", "takeoverStartedAt", "takeoverEndsAt",
      "recoveryEndsAt", "highlightExpiresAt", "animationExpiresAt", "supersededAt"
    FROM ${sqlQuoteIdent(schema)}."TvProfileEventPresentation"
    WHERE "tenancyId" = ${tenancy.id}::UUID
      AND "profileId" = ${profileId}
  `;
}

function snapshotEvent(occurrence: TvEventOccurrenceRow): TvEvent {
  const title = occurrence.eventType === "EMAIL_DELIVERY_DEGRADATION"
    ? occurrence.lifecycle === "RESOLVED" ? TV_EMAIL_RECOVERY_TITLE : "Email Delivery Degraded"
    : occurrence.eventType === "SUBSCRIPTION_COLLECTION_DEGRADATION"
      ? occurrence.lifecycle === "RESOLVED" ? TV_PAYMENT_RECOVERY_TITLE : "Subscription Payments Degraded"
      : occurrence.title.replace(/ users$/i, " Users");
  return {
    id: occurrence.id,
    type: occurrenceType(occurrence),
    presentationClass: presentationClass(occurrence),
    status: occurrence.lifecycle === "RESOLVED" ? "resolved" : "active",
    // Normalize persisted copy at the snapshot boundary so occurrences created
    // before a wording update render consistently with newly detected events.
    title,
    summary: occurrence.summary,
    metricLabel: occurrence.metricLabel,
    metricValue: occurrence.metricValue,
    expectedRange: occurrence.expectedRange,
    sourceLabel: occurrence.sourceLabel,
    occurredAt: occurrence.occurredAt.toISOString(),
    updatedAt: occurrence.updatedAt.toISOString(),
  };
}

export async function resolveTvEventPresentation(options: {
  tenancy: Tenancy,
  profile: TvProfileResource,
  now: Date,
  eventTablesReady?: boolean,
}): Promise<TvEventPresentation> {
  if (!(options.eventTablesReady ?? await tvEventTablesAreReady(options.tenancy))) {
    return { takeover: null, highlight: null };
  }
  const occurrences = await loadOccurrences(options.tenancy, options.now);
  await synchronizeTvProfileAssignments({ ...options, occurrences });
  const assignments = await loadAssignments(options.tenancy, options.profile.id);
  const activeAssignmentOccurrenceIds = new Set(
    assignments
      .filter((assignment) => assignment.supersededAt == null)
      .map((assignment) => assignment.occurrenceId),
  );
  const durableOccurrences: TvDurableEventOccurrence[] = occurrences
    .filter((occurrence) => (
      isEligible(occurrence, options.profile.configuration.interruptionPreferences)
      && activeAssignmentOccurrenceIds.has(occurrence.id)
    ))
    .map(durableOccurrence);
  const durableAssignments: TvDurablePresentationAssignment[] = assignments.map((assignment) => ({
    occurrenceId: assignment.occurrenceId,
    takeoverStartedAt: assignment.takeoverStartedAt,
    takeoverEndsAt: assignment.takeoverEndsAt,
    recoveryEndsAt: assignment.recoveryEndsAt,
    highlightExpiresAt: assignment.highlightExpiresAt,
    animationExpiresAt: assignment.animationExpiresAt,
    supersededAt: assignment.supersededAt,
  }));
  const derived = deriveTvPresentation({
    now: options.now,
    occurrences: durableOccurrences,
    assignments: durableAssignments,
  });
  const occurrencesById = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const takeoverOccurrence = derived.takeover == null
    ? null
    : occurrencesById.get(derived.takeover.occurrenceId);
  const highlightOccurrence = derived.highlight == null
    ? null
    : occurrencesById.get(derived.highlight.occurrenceId);
  if (derived.takeover != null && takeoverOccurrence == null) {
    throw new HexclaveAssertionError("The derived TV takeover references an unavailable occurrence.");
  }
  if (derived.highlight != null && highlightOccurrence == null) {
    throw new HexclaveAssertionError("The derived TV Highlight references an unavailable occurrence.");
  }
  return {
    takeover: derived.takeover == null || takeoverOccurrence == null ? null : {
      event: snapshotEvent(takeoverOccurrence),
      variant: derived.takeover.variant,
      startedAt: derived.takeover.startedAt.toISOString(),
      endsAt: derived.takeover.endsAt.toISOString(),
    },
    highlight: derived.highlight == null || highlightOccurrence == null ? null : {
      event: snapshotEvent(highlightOccurrence),
      variant: derived.highlight.variant,
      expiresAt: derived.highlight.expiresAt?.toISOString() ?? null,
      animationExpiresAt: derived.highlight.animationExpiresAt?.toISOString() ?? null,
    },
  };
}
