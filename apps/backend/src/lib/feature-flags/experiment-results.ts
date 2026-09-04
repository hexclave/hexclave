import { getClickhouseAdminClient } from "@/lib/clickhouse";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { ExperimentConfig, ExperimentMetricDefinition } from "./experiment-config";
import {
  type VariantPosteriorSummary,
  WINNER_MIN_EXPOSED_SUBJECTS_PER_VARIANT,
  computeBinaryPosteriors,
  computeNumericPosteriors,
  decideWinner,
  drawPosteriorSamplesForGuardrail,
  isGuardrailRegression,
} from "./stats/bayesian";
import { detectSampleRatioMismatch } from "./stats/srm";

/**
 * Experiment results: attribution queries against ClickHouse plus Bayesian
 * summaries of the outcomes.
 *
 * Attribution contract (all enforced in the SQL below):
 * - A subject enters the analysis at its FIRST exposure for this run/revision
 *   (min event_at; ties broken by event_id so the choice is deterministic),
 *   and is attributed to the variant of that first exposure — one subject, one
 *   variant, per revision.
 * - Only conversion events with event_at inside
 *   [first_exposed_at, first_exposed_at + attribution_window_seconds] count.
 * - Exposure rows are deduplicated by event_id via aggregation (min/argMin/
 *   uniqExact and per-subject GROUP BY are unaffected by duplicate rows), per
 *   the ReplacingMergeTree contract on feature_flag_exposures.
 * - Funnel steps must occur in order (windowFunnel in strict-order-free mode:
 *   level N requires steps 1..N in sequence).
 *
 * All queries are predefined templates with bound parameters ({name:Type});
 * nothing user-controlled is ever interpolated into query text. The only
 * structural variation is the number of funnel-step conditions, which comes
 * from the validated frozen snapshot, never from raw user input.
 */

export type ExperimentRunForResults = {
  id: string,
  projectId: string,
  branchId: string,
  experimentId: string,
  configRevisionHash: string,
  config: ExperimentConfig,
  startedAtMillis: number,
  completedAtMillis?: number,
  sinceMillis?: number,
  untilMillis?: number,
};

// Must stay in sync with computeExposureSubjectHash in exposure-tokens.ts.
const SUBJECT_ID_SQL = `if({subjectType:String} = 'team', assumeNotNull(team_id), assumeNotNull(user_id))`;
const SUBJECT_HASH_SQL = `lower(hex(SHA256(concat('hexclave:ff:subject:', {projectId:String}, ':', {subjectType:String}, ':', ${SUBJECT_ID_SQL}))))`;
const SUBJECT_PRESENT_SQL = `(({subjectType:String} = 'team' AND team_id IS NOT NULL) OR ({subjectType:String} = 'user' AND user_id IS NOT NULL))`;
// New SDK batches carry a stable event_id. Exact retries therefore collapse
// before attribution. The deterministic legacy key preserves compatibility
// for older rows while also collapsing byte-identical historical duplicates.
const ANALYTICS_EVENT_DEDUPLICATION_KEY_SQL = `if(
  length(toString(data.event_id)) > 0,
  concat('id:', toString(data.event_id)),
  concat('legacy:', lower(hex(SHA256(concat(
    toString(event_at), ':', event_type, ':', toString(data), ':',
    ifNull(user_id, ''), ':', ifNull(team_id, '')
  )))))
)`;

// Per-subject first exposure for the complete frozen run/revision: variant of
// the earliest exposure row and its timestamp. The cohort window is deliberately
// applied only after that canonical exposure is selected. Otherwise, asking for
// results with `since` could re-enroll a subject at a later exposure and even
// attribute the subject to a different variant. Duplicate exposure rows
// (idempotent re-sends) collapse in the GROUP BY; the (event_at, event_id)
// tiebreaker makes argMin deterministic when distinct exposures share a timestamp.
const FIRST_EXPOSURES_CTE = `
  SELECT
    subject_hash,
    variant_id,
    first_exposed_at
  FROM (
    SELECT
      subject_hash,
      argMin(variant_id, (event_at, event_id)) AS variant_id,
      min(event_at) AS first_exposed_at
    FROM analytics_internal.feature_flag_exposures
    WHERE project_id = {projectId:String}
      AND branch_id = {branchId:String}
      AND experiment_id = {experimentId:String}
      AND run_id = {runId:String}
      AND config_revision_hash = {configRevisionHash:String}
      AND subject_type = {subjectType:String}
    GROUP BY subject_hash
  )
  WHERE first_exposed_at >= fromUnixTimestamp64Milli({sinceMillis:Int64})
    AND first_exposed_at <= fromUnixTimestamp64Milli({untilMillis:Int64})
`;

import.meta.vitest?.test("first-exposure cohort filtering happens after canonical attribution", ({ expect }) => {
  const aggregationStart = FIRST_EXPOSURES_CTE.indexOf("FROM analytics_internal.feature_flag_exposures");
  const aggregationEnd = FIRST_EXPOSURES_CTE.indexOf("GROUP BY subject_hash", aggregationStart);
  const cohortFilterStart = FIRST_EXPOSURES_CTE.indexOf("WHERE first_exposed_at", aggregationEnd);

  expect(aggregationStart).toBeGreaterThanOrEqual(0);
  expect(aggregationEnd).toBeGreaterThan(aggregationStart);
  expect(cohortFilterStart).toBeGreaterThan(aggregationEnd);
  expect(FIRST_EXPOSURES_CTE.slice(aggregationStart, aggregationEnd)).not.toContain("{sinceMillis:Int64}");
  expect(FIRST_EXPOSURES_CTE.slice(aggregationStart, aggregationEnd)).not.toContain("{untilMillis:Int64}");
  expect(FIRST_EXPOSURES_CTE.slice(cohortFilterStart)).toContain("{sinceMillis:Int64}");
  expect(FIRST_EXPOSURES_CTE.slice(cohortFilterStart)).toContain("{untilMillis:Int64}");
});

const EXPOSED_SUBJECTS_QUERY = `
WITH first_exposures AS (${FIRST_EXPOSURES_CTE})
SELECT variant_id, toUInt64(count()) AS exposed_subjects
FROM first_exposures
GROUP BY variant_id
`;

const BINARY_CONVERSIONS_QUERY = `
WITH first_exposures AS (${FIRST_EXPOSURES_CTE}),
conversion_events AS (
  SELECT
    argMin(${SUBJECT_HASH_SQL}, created_at) AS subject_hash,
    argMin(event_at, created_at) AS conversion_event_at
  FROM analytics_internal.events
  WHERE project_id = {projectId:String}
    AND branch_id = {branchId:String}
    AND event_type = {eventName:String}
    AND ${SUBJECT_PRESENT_SQL}
    AND event_at >= fromUnixTimestamp64Milli({conversionSinceMillis:Int64})
    AND event_at <= fromUnixTimestamp64Milli({conversionUntilMillis:Int64})
    AND (
      {filterField:String} = ''
      OR ({filterField:String} = 'path' AND (
        ({filterOperator:String} = 'eq' AND toString(data.path) = {filterValue:String})
        OR ({filterOperator:String} = 'starts_with' AND startsWith(toString(data.path), {filterValue:String}))
        OR ({filterOperator:String} = 'ends_with' AND endsWith(toString(data.path), {filterValue:String}))
        OR ({filterOperator:String} = 'contains' AND position(toString(data.path), {filterValue:String}) > 0)
      ))
      OR ({filterField:String} = 'selector' AND toString(data.selector) = {filterValue:String})
    )
  GROUP BY ${ANALYTICS_EVENT_DEDUPLICATION_KEY_SQL}
)
SELECT
  fe.variant_id AS variant_id,
  toUInt64(uniqExactIf(fe.subject_hash,
    ce.conversion_event_at >= fe.first_exposed_at
    AND ce.conversion_event_at <= fe.first_exposed_at + toIntervalSecond({attributionWindowSeconds:UInt32})
  )) AS converted_subjects
FROM first_exposures AS fe
INNER JOIN conversion_events AS ce ON ce.subject_hash = fe.subject_hash
GROUP BY fe.variant_id
`;

// Per-subject value = sum of the event values attributed within the window
// (events without a numeric value contribute 0). Subjects with no attributed
// events at all are absent from this result; the caller treats them as 0 by
// using the exposed-subject count as n while keeping sum/sumSq unchanged.
const NUMERIC_OBSERVATIONS_QUERY = `
WITH first_exposures AS (${FIRST_EXPOSURES_CTE}),
conversion_events AS (
  SELECT
    argMin(${SUBJECT_HASH_SQL}, created_at) AS subject_hash,
    argMin(event_at, created_at) AS conversion_event_at,
    argMin(coalesce(if(
      {propertyName:String} = 'value',
      toFloat64OrNull(toString(data.value)),
      toFloat64OrNull(JSONExtractRaw(toString(data.properties), {propertyName:String}))
    ), 0), created_at) AS value
  FROM analytics_internal.events
  WHERE project_id = {projectId:String}
    AND branch_id = {branchId:String}
    AND event_type = {eventName:String}
    AND ${SUBJECT_PRESENT_SQL}
    AND event_at >= fromUnixTimestamp64Milli({conversionSinceMillis:Int64})
    AND event_at <= fromUnixTimestamp64Milli({conversionUntilMillis:Int64})
  GROUP BY ${ANALYTICS_EVENT_DEDUPLICATION_KEY_SQL}
)
SELECT
  variant_id,
  toFloat64(sum(subject_value)) AS sum_values,
  toFloat64(sum(subject_value * subject_value)) AS sum_squared_values
FROM (
  SELECT
    fe.variant_id AS variant_id,
    fe.subject_hash AS subject_hash,
    if(
      {aggregation:String} = 'average',
      sumIf(ce.value, ce.conversion_event_at >= fe.first_exposed_at AND ce.conversion_event_at <= fe.first_exposed_at + toIntervalSecond({attributionWindowSeconds:UInt32}))
        / greatest(toFloat64(countIf(ce.conversion_event_at >= fe.first_exposed_at AND ce.conversion_event_at <= fe.first_exposed_at + toIntervalSecond({attributionWindowSeconds:UInt32}))), 1),
      sumIf(ce.value, ce.conversion_event_at >= fe.first_exposed_at AND ce.conversion_event_at <= fe.first_exposed_at + toIntervalSecond({attributionWindowSeconds:UInt32}))
    ) AS subject_value
  FROM first_exposures AS fe
  INNER JOIN conversion_events AS ce ON ce.subject_hash = fe.subject_hash
  GROUP BY fe.variant_id, fe.subject_hash
)
GROUP BY variant_id
`;

// Funnel conversion: the subject completed ALL steps, in order, within the
// attribution window after its first exposure. windowFunnel counts the longest
// prefix of steps observed in sequence; timestamps are compared at millisecond
// precision (toUnixTimestamp64Milli) so same-second step events still order
// correctly.
function buildFunnelQuery(stepCount: number): string {
  if (!Number.isInteger(stepCount) || stepCount < 2) {
    throw new HexclaveAssertionError(`Funnel queries need at least 2 steps, got ${stepCount}; experiment config validation should have enforced this`);
  }
  const stepConditions = Array.from({ length: stepCount }, (_, i) => `se.conversion_event_type = {step${i}:String}`).join(", ");
  const stepInList = Array.from({ length: stepCount }, (_, i) => `{step${i}:String}`).join(", ");
  return `
WITH first_exposures AS (${FIRST_EXPOSURES_CTE}),
step_events AS (
  SELECT
    argMin(${SUBJECT_HASH_SQL}, created_at) AS subject_hash,
    argMin(event_at, created_at) AS conversion_event_at,
    argMin(event_type, created_at) AS conversion_event_type
  FROM analytics_internal.events
  WHERE project_id = {projectId:String}
    AND branch_id = {branchId:String}
    AND event_type IN (${stepInList})
    AND ${SUBJECT_PRESENT_SQL}
    AND event_at >= fromUnixTimestamp64Milli({conversionSinceMillis:Int64})
    AND event_at <= fromUnixTimestamp64Milli({conversionUntilMillis:Int64})
  GROUP BY ${ANALYTICS_EVENT_DEDUPLICATION_KEY_SQL}
)
SELECT
  variant_id,
  toUInt64(countIf(funnel_level >= {stepCount:UInt32})) AS converted_subjects
FROM (
  SELECT
    fe.variant_id AS variant_id,
    fe.subject_hash AS subject_hash,
    windowFunnel({attributionWindowMillis:UInt64}, 'strict_once')(
      toUInt64(toUnixTimestamp64Milli(se.conversion_event_at)),
      ${stepConditions}
    ) AS funnel_level
  FROM first_exposures AS fe
  INNER JOIN step_events AS se ON se.subject_hash = fe.subject_hash
  WHERE se.conversion_event_at >= fe.first_exposed_at
    AND se.conversion_event_at <= fe.first_exposed_at + toIntervalSecond({attributionWindowSeconds:UInt32})
  GROUP BY fe.variant_id, fe.subject_hash
)
GROUP BY variant_id
`;
}

import.meta.vitest?.test("funnel attribution cannot reuse one event for repeated steps", ({ expect }) => {
  expect(buildFunnelQuery(2)).toContain("windowFunnel({attributionWindowMillis:UInt64}, 'strict_once')");
});

type ClickhouseClient = ReturnType<typeof getClickhouseAdminClient>;

// Results queries aggregate to at most one row per variant, but still get
// execution bounds so a pathological state can't hold a connection forever.
const RESULTS_QUERY_SETTINGS = {
  max_execution_time: 30,
  max_result_rows: "1000",
  result_overflow_mode: "throw",
} as const;

async function queryRows<T>(client: ClickhouseClient, query: string, params: Record<string, string | number>): Promise<T[]> {
  const resultSet = await client.query({
    query,
    query_params: params,
    format: "JSONEachRow",
    clickhouse_settings: RESULTS_QUERY_SETTINGS,
  });
  return await resultSet.json<T>();
}

function baseParams(run: ExperimentRunForResults): Record<string, string | number> {
  const exposureSinceMillis = Math.max(run.startedAtMillis, run.sinceMillis ?? run.startedAtMillis);
  const enrollmentEndedAtMillis = run.completedAtMillis ?? Date.now();
  const exposureUntilMillis = Math.min(enrollmentEndedAtMillis, run.untilMillis ?? enrollmentEndedAtMillis);
  return {
    projectId: run.projectId,
    branchId: run.branchId,
    experimentId: run.experimentId,
    runId: run.id,
    configRevisionHash: run.configRevisionHash,
    subjectType: run.config.assignment_unit,
    sinceMillis: exposureSinceMillis,
    untilMillis: exposureUntilMillis,
    conversionSinceMillis: exposureSinceMillis,
    conversionUntilMillis: exposureUntilMillis + run.config.attribution_window_seconds * 1000,
  };
}

/** Exposed-subject counts per variant. Variants with zero exposures are filled in with 0. */
export async function queryExposedSubjectsByVariant(client: ClickhouseClient, run: ExperimentRunForResults): Promise<Map<string, number>> {
  const rows = await queryRows<{ variant_id: string, exposed_subjects: string | number }>(client, EXPOSED_SUBJECTS_QUERY, baseParams(run));
  const counts = new Map<string, number>(Object.keys(run.config.variants).map((variantId) => [variantId, 0]));
  for (const row of rows) {
    // Exposures for variant ids not in the snapshot can only appear if rows
    // from a different revision leaked in, which the WHERE clause excludes.
    if (!counts.has(row.variant_id)) {
      throw new HexclaveAssertionError(`Exposure rows reference unknown variant ${row.variant_id} for run ${run.id}; the revision-scoped query should have made this impossible`);
    }
    counts.set(row.variant_id, Number(row.exposed_subjects));
  }
  return counts;
}

async function queryConvertedSubjectsByVariant(
  client: ClickhouseClient,
  run: ExperimentRunForResults,
  metric: ExperimentMetricDefinition,
): Promise<Map<string, number>> {
  let rows: { variant_id: string, converted_subjects: string | number }[];
  if (metric.kind === "binary") {
    rows = await queryRows(client, BINARY_CONVERSIONS_QUERY, {
      ...baseParams(run),
      eventName: metric.event_name,
      filterField: metric.event_filter?.field ?? "",
      filterOperator: metric.event_filter?.operator ?? "eq",
      filterValue: metric.event_filter?.value ?? "",
      attributionWindowSeconds: run.config.attribution_window_seconds,
    });
  } else if (metric.kind === "funnel") {
    const stepParams = Object.fromEntries(metric.steps.map((step, i) => [`step${i}`, step]));
    rows = await queryRows(client, buildFunnelQuery(metric.steps.length), {
      ...baseParams(run),
      ...stepParams,
      stepCount: metric.steps.length,
      attributionWindowSeconds: run.config.attribution_window_seconds,
      attributionWindowMillis: run.config.attribution_window_seconds * 1000,
    });
  } else {
    throw new HexclaveAssertionError(`queryConvertedSubjectsByVariant called with non-conversion metric kind ${metric.kind}`);
  }
  const counts = new Map<string, number>(Object.keys(run.config.variants).map((variantId) => [variantId, 0]));
  for (const row of rows) {
    if (counts.has(row.variant_id)) {
      counts.set(row.variant_id, Number(row.converted_subjects));
    }
  }
  return counts;
}

async function queryNumericObservationsByVariant(
  client: ClickhouseClient,
  run: ExperimentRunForResults,
  metric: ExperimentMetricDefinition & { kind: "numeric" },
): Promise<Map<string, { sumValues: number, sumSquaredValues: number }>> {
  const rows = await queryRows<{ variant_id: string, sum_values: string | number, sum_squared_values: string | number }>(client, NUMERIC_OBSERVATIONS_QUERY, {
    ...baseParams(run),
    eventName: metric.event_name,
    attributionWindowSeconds: run.config.attribution_window_seconds,
    propertyName: metric.property_name,
    aggregation: metric.aggregation,
  });
  const observations = new Map<string, { sumValues: number, sumSquaredValues: number }>(
    Object.keys(run.config.variants).map((variantId) => [variantId, { sumValues: 0, sumSquaredValues: 0 }]),
  );
  for (const row of rows) {
    if (observations.has(row.variant_id)) {
      observations.set(row.variant_id, { sumValues: Number(row.sum_values), sumSquaredValues: Number(row.sum_squared_values) });
    }
  }
  return observations;
}

export type ExperimentMetricResults = {
  metric_id: string,
  kind: "binary" | "numeric" | "funnel",
  role: "primary" | "secondary" | "guardrail",
  direction: "increase" | "decrease",
  variants: {
    variant_id: string,
    exposed_subjects: number,
    converted_subjects: number | null,
    sum_values: number | null,
    posterior_mean: number,
    credible_interval_95: { lower: number, upper: number },
    probability_best: number,
    is_guardrail_regression: boolean | null,
  }[],
};

export type ExperimentRunResults = {
  run_id: string,
  experiment_id: string,
  config_revision_hash: string,
  total_exposed_subjects: number,
  exposed_subjects_by_variant: Record<string, number>,
  min_exposed_subjects_for_winner: number,
  srm: { detected: boolean, statistic: number | null, p_value: number | null },
  metrics: ExperimentMetricResults[],
  winner:
    | { status: "winner", variant_id: string, probability_best: number }
    | { status: "no_winner", reason: "insufficient_data" | "no_variant_confident" | "guardrail_regression" | "srm_detected" },
  // The rollout contract: when a winner exists, everything a caller needs to
  // roll the winning variant out to 100% of traffic (applied via a config
  // update on the flag; this endpoint never mutates config itself).
  winner_rollout: { flag_id: string, variant_id: string, flag_value: unknown } | null,
};

async function computeMetricResults(options: {
  client: ClickhouseClient,
  run: ExperimentRunForResults,
  metric: ExperimentMetricDefinition,
  role: "primary" | "secondary" | "guardrail",
  exposedByVariant: Map<string, number>,
}): Promise<{ results: ExperimentMetricResults, posteriors: VariantPosteriorSummary[], winnerPosteriors: VariantPosteriorSummary[], regressionVariantIds: Set<string> }> {
  const { client, run, metric, role, exposedByVariant } = options;
  const variantIds = Object.keys(run.config.variants);
  // Seeded per run+metric: reproducible results per revision, decorrelated
  // sample streams across metrics.
  const seed = `experiment-results :: ${run.id} :: ${metric.id}`;

  let posteriors: VariantPosteriorSummary[];
  let winnerPosteriors: VariantPosteriorSummary[];
  let convertedByVariant: Map<string, number> | null = null;
  let numericByVariant: Map<string, { sumValues: number, sumSquaredValues: number }> | null = null;
  let samplesByVariant: Map<string, number[]>;

  if (metric.kind === "numeric") {
    numericByVariant = await queryNumericObservationsByVariant(client, run, { ...metric, kind: "numeric" });
    const variants = variantIds.map((variantId) => {
      const obs = numericByVariant?.get(variantId) ?? { sumValues: 0, sumSquaredValues: 0 };
      return {
        variantId,
        exposedSubjects: exposedByVariant.get(variantId) ?? 0,
        sumValues: obs.sumValues,
        sumSquaredValues: obs.sumSquaredValues,
      };
    });
    posteriors = computeNumericPosteriors({ variants, direction: metric.direction, seed });
    winnerPosteriors = computeNumericPosteriors({
      variants: variants.filter((variant) => run.config.variants[variant.variantId].weight_basis_points > 0),
      direction: metric.direction,
      seed: `${seed} :: eligible`,
    });
    samplesByVariant = drawPosteriorSamplesForGuardrail({ kind: "numeric", variants, seed });
  } else {
    convertedByVariant = await queryConvertedSubjectsByVariant(client, run, metric);
    const variants = variantIds.map((variantId) => {
      const exposed = exposedByVariant.get(variantId) ?? 0;
      const converted = convertedByVariant?.get(variantId) ?? 0;
      if (converted > exposed) {
        throw new HexclaveAssertionError(`Metric ${metric.id} counted ${converted} converted subjects but only ${exposed} exposed subjects for variant ${variantId}`);
      }
      return { variantId, exposedSubjects: exposed, convertedSubjects: converted };
    });
    posteriors = computeBinaryPosteriors({ variants, direction: metric.direction, seed });
    winnerPosteriors = computeBinaryPosteriors({
      variants: variants.filter((variant) => run.config.variants[variant.variantId].weight_basis_points > 0),
      direction: metric.direction,
      seed: `${seed} :: eligible`,
    });
    samplesByVariant = drawPosteriorSamplesForGuardrail({ kind: "binary", variants, seed });
  }

  const controlVariantId = run.config.control_variant_id;
  const controlSamples = samplesByVariant.get(controlVariantId)
    ?? (() => { throw new HexclaveAssertionError(`No posterior samples for control variant ${controlVariantId}`); })();
  const regressionVariantIds = new Set<string>();
  if (role === "guardrail") {
    for (const variantId of variantIds) {
      if (variantId === controlVariantId) continue;
      const variantSamples = samplesByVariant.get(variantId)
        ?? (() => { throw new HexclaveAssertionError(`No posterior samples for variant ${variantId}`); })();
      if (isGuardrailRegression({ controlSamples, variantSamples, direction: metric.direction })) {
        regressionVariantIds.add(variantId);
      }
    }
  }

  const posteriorByVariant = new Map(posteriors.map((p) => [p.variantId, p]));
  return {
    results: {
      metric_id: metric.id,
      kind: metric.kind,
      role,
      direction: metric.direction,
      variants: variantIds.map((variantId) => {
        const posterior = posteriorByVariant.get(variantId)
          ?? (() => { throw new HexclaveAssertionError(`Missing posterior for variant ${variantId}`); })();
        return {
          variant_id: variantId,
          exposed_subjects: exposedByVariant.get(variantId) ?? 0,
          converted_subjects: convertedByVariant?.get(variantId) ?? null,
          sum_values: numericByVariant?.get(variantId)?.sumValues ?? null,
          posterior_mean: posterior.posteriorMean,
          credible_interval_95: posterior.credibleInterval95,
          probability_best: posterior.probabilityBest,
          is_guardrail_regression: role === "guardrail" && variantId !== controlVariantId
            ? regressionVariantIds.has(variantId)
            : null,
        };
      }),
    },
    posteriors,
    winnerPosteriors,
    regressionVariantIds,
  };
}

export async function computeExperimentRunResults(run: ExperimentRunForResults): Promise<ExperimentRunResults> {
  const client = getClickhouseAdminClient();
  const exposedByVariant = await queryExposedSubjectsByVariant(client, run);

  const srm = detectSampleRatioMismatch({
    variants: Object.entries(run.config.variants).map(([variantId, v]) => ({
      variantId,
      weightBasisPoints: v.weight_basis_points,
      exposedSubjects: exposedByVariant.get(variantId) ?? 0,
    })),
  });

  const primary = await computeMetricResults({ client, run, metric: run.config.primary_metric, role: "primary", exposedByVariant });
  const secondary = await Promise.all(run.config.secondary_metrics.map((metric) =>
    computeMetricResults({ client, run, metric, role: "secondary", exposedByVariant }),
  ));
  const guardrails = await Promise.all(run.config.guardrail_metrics.map((metric) =>
    computeMetricResults({ client, run, metric, role: "guardrail", exposedByVariant }),
  ));

  const guardrailRegressionVariantIds = new Set<string>();
  for (const guardrail of guardrails) {
    for (const variantId of guardrail.regressionVariantIds) {
      guardrailRegressionVariantIds.add(variantId);
    }
  }

  const eligibleVariantIds = new Set(Object.entries(run.config.variants)
    .filter(([, variant]) => variant.weight_basis_points > 0)
    .map(([variantId]) => variantId));
  const winner = eligibleVariantIds.size < 2
    ? { status: "no_winner", reason: "insufficient_data" } as const
    : decideWinner({
      exposedSubjectsByVariant: new Map([...exposedByVariant].filter(([variantId]) => eligibleVariantIds.has(variantId))),
      primaryPosteriors: primary.winnerPosteriors,
      guardrailRegressionVariantIds,
      srmDetected: srm.detected,
    });

  const winnerRollout = winner.status === "winner"
    ? {
      flag_id: run.config.flag_id,
      variant_id: winner.variantId,
      flag_value: run.config.variants[winner.variantId].flag_value,
    }
    : null;

  return {
    run_id: run.id,
    experiment_id: run.experimentId,
    config_revision_hash: run.configRevisionHash,
    total_exposed_subjects: [...exposedByVariant.values()].reduce((a, b) => a + b, 0),
    exposed_subjects_by_variant: Object.fromEntries(exposedByVariant),
    min_exposed_subjects_for_winner: WINNER_MIN_EXPOSED_SUBJECTS_PER_VARIANT,
    srm: { detected: srm.detected, statistic: srm.statistic, p_value: srm.pValue },
    metrics: [primary.results, ...secondary.map((s) => s.results), ...guardrails.map((g) => g.results)],
    winner: winner.status === "winner"
      ? { status: "winner", variant_id: winner.variantId, probability_best: winner.probabilityBest }
      : { status: "no_winner", reason: winner.reason },
    winner_rollout: winnerRollout,
  };
}
