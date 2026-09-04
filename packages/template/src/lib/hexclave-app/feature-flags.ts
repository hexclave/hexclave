import type { FeatureFlagEvaluateRequest, FeatureFlagEvaluateResponse, FeatureFlagEvaluateResult, FeatureFlagExposureRequest } from "@hexclave/shared/dist/interface/crud/feature-flags";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

const MAX_FLAG_KEYS = 50;
const MAX_CONTEXT_KEYS = 32;
const MAX_CONTEXT_KEY_LENGTH = 64;
const MAX_CONTEXT_BYTES = 8_192;
const MAX_CONTEXT_DEPTH = 5;
const MAX_COMPLETED_EXPOSURE_KEYS = 10_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1_000;

export type FeatureFlagExposureMode = "auto" | "manual" | "none";

export type FeatureFlagOptions = {
  context?: Record<string, Json>,
  teamId?: string,
  exposure?: FeatureFlagExposureMode,
};

export type FeatureFlagRequest<T extends Json = Json> = {
  key: string,
  fallback: T,
  options?: FeatureFlagOptions,
};

export type FeatureFlagDetails<T extends Json = Json> = {
  flagKey: string,
  value: T,
  variantKey: string | null,
  reason: string,
  ruleId: string | null,
  configVersion: string,
  experimentId: string | null,
  experimentRunId: string | null,
  isStale: boolean,
  exposureToken: string | null,
};

export type FeatureFlagIdentity<TIdentity> = {
  cacheKey: string,
  value: TIdentity,
};

export type FeatureFlagControllerDependencies<TIdentity> = {
  evaluate: (
    identity: TIdentity,
    request: FeatureFlagEvaluateRequest,
  ) => Promise<FeatureFlagEvaluateResponse<Json>>,
  sendExposures: (
    identity: TIdentity,
    exposures: { event_id: string, exposure_token: string, exposed_at_ms: number }[],
  ) => Promise<void>,
  // Best-effort analytics side effect, invoked after each evaluation settles
  // (cache hits included). It runs detached from the promise returned to the
  // caller: a throw here is reported through the SDK error reporter but never
  // fails the flag read, because analytics context must not decide whether a
  // feature is on. Implementations should therefore not throw.
  onTeamContextResolved?: (teamId: string | null) => void,
  cacheTtlMillis?: number,
  cacheMaxEntries?: number,
  now?: () => number,
};

type CachedPromise<T> = { promise: Promise<T>, createdAt: number };

function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maximumSize: number): void {
  if (!Number.isInteger(maximumSize) || maximumSize < 1) {
    throw new HexclaveAssertionError("Feature flag cache size must be a positive integer.");
  }
  // Refresh insertion order when replacing a key so frequently used entries
  // are not the first evicted merely because they were created early.
  map.delete(key);
  map.set(key, value);
  while (map.size > maximumSize) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) throw new HexclaveAssertionError("A non-empty feature flag cache did not yield an oldest key.");
    map.delete(oldestKey);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateJsonDepth(value: Json, depth: number): void {
  if (depth > MAX_CONTEXT_DEPTH) {
    throw new Error(`Feature flag context cannot be nested more than ${MAX_CONTEXT_DEPTH} levels.`);
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJsonDepth(item, depth + 1);
    return;
  }
  if (value != null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Feature flag values must use plain JSON objects.");
    }
    for (const item of Object.values(value)) validateJsonDepth(item, depth + 1);
    return;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Feature flag context numbers must be finite.");
  }
}

export function validateFeatureFlagContext(context: Record<string, Json> | undefined): void {
  if (context == null) return;
  const entries = Object.entries(context);
  if (entries.length > MAX_CONTEXT_KEYS) {
    throw new Error(`Feature flag context can contain at most ${MAX_CONTEXT_KEYS} attributes.`);
  }
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_CONTEXT_KEY_LENGTH) {
      throw new Error(`Feature flag context attribute names must be between 1 and ${MAX_CONTEXT_KEY_LENGTH} characters.`);
    }
    if (!isJsonSerializable(value)) {
      throw new Error(`Feature flag context attribute ${JSON.stringify(key)} must be JSON serializable.`);
    }
    validateJsonDepth(value, 0);
  }
  if (new TextEncoder().encode(JSON.stringify(context)).byteLength > MAX_CONTEXT_BYTES) {
    throw new Error(`Feature flag context cannot exceed ${MAX_CONTEXT_BYTES} bytes.`);
  }
}

function canonicalizeJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value != null && typeof value === "object") {
    const result: Record<string, Json> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalizeJson(value[key]);
    return result;
  }
  return value;
}

function validateRequests<T extends Json>(requests: readonly FeatureFlagRequest<T>[]): void {
  if (requests.length === 0 || requests.length > MAX_FLAG_KEYS) {
    throw new Error(`Feature flag batches must contain between 1 and ${MAX_FLAG_KEYS} requests.`);
  }
  const keys = new Set<string>();
  for (const request of requests) {
    if (request.key.trim() === "") throw new Error("Feature flag keys cannot be empty.");
    if (keys.has(request.key)) throw new Error(`Feature flag batch contains duplicate key ${JSON.stringify(request.key)}.`);
    keys.add(request.key);
    if (!isJsonSerializable(request.fallback)) throw new Error(`Fallback for feature flag ${JSON.stringify(request.key)} must be JSON serializable.`);
    validateJsonDepth(request.fallback, 0);
    validateFeatureFlagContext(request.options?.context);
  }
  const teamIds = new Set(requests.map((request) => request.options?.teamId).filter((teamId) => teamId != null));
  if (teamIds.size > 1) throw new Error("All feature flags in a batch must use the same teamId.");
  const contexts = new Set(requests.map((request) => JSON.stringify(canonicalizeJson(request.options?.context ?? {}))));
  if (contexts.size > 1) throw new Error("All feature flags in a batch must use the same context.");
}

export function canonicalFeatureFlagRequestKey<T extends Json>(requests: readonly FeatureFlagRequest<T>[]): string {
  const normalized = [...requests]
    .sort((left, right) => stringCompare(left.key, right.key))
    .map((request) => ({
      key: request.key,
      fallback: canonicalizeJson(request.fallback),
      context: canonicalizeJson(request.options?.context ?? {}),
      teamId: request.options?.teamId ?? null,
      exposure: request.options?.exposure ?? "auto",
    }));
  return JSON.stringify(normalized);
}

function canonicalNetworkRequestKey<T extends Json>(requests: readonly FeatureFlagRequest<T>[]): string {
  return JSON.stringify([...requests]
    .sort((left, right) => stringCompare(left.key, right.key))
    .map((request) => ({
      key: request.key,
      fallback: canonicalizeJson(request.fallback),
      context: canonicalizeJson(request.options?.context ?? {}),
      teamId: request.options?.teamId ?? null,
    })));
}

function matchesFallbackType<T extends Json>(value: Json, fallback: T): value is T {
  // The fallback is the runtime witness for the flag's configured value kind. The
  // backend owns validation of the exact variant domain; the SDK rejects a result
  // that crosses JSON kinds so a boolean fallback can never receive a string, etc.
  if (fallback === null) return value === null;
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (typeof fallback === "object") return value != null && typeof value === "object" && !Array.isArray(value);
  return typeof value === typeof fallback;
}

export function narrowFeatureFlagDetails<T extends Json>(details: FeatureFlagDetails<Json>, fallback: T): FeatureFlagDetails<T> {
  if (!matchesFallbackType(details.value, fallback)) {
    throw new HexclaveAssertionError(`Feature flag ${JSON.stringify(details.flagKey)} returned a value with a different JSON type than its fallback.`);
  }
  return { ...details, value: details.value };
}

function toWireRequest<T extends Json>(requests: readonly FeatureFlagRequest<T>[]): FeatureFlagEvaluateRequest {
  const fallbacks: Record<string, Json> = {};
  for (const request of requests) fallbacks[request.key] = request.fallback;
  return {
    flag_keys: requests.map((request) => request.key).sort(),
    fallbacks,
    context: requests[0]?.options?.context,
    team_id: requests[0]?.options?.teamId,
  };
}

function validateWireResult(value: unknown, expectedKey: string): void {
  if (!isRecord(value)) throw new HexclaveAssertionError("Feature flag evaluation returned a non-object result.");
  if (value.flag_key !== expectedKey) throw new HexclaveAssertionError(`Feature flag evaluation returned a mismatched result for ${JSON.stringify(expectedKey)}.`);
  if (!isJsonSerializable(value.value)) throw new HexclaveAssertionError(`Feature flag ${JSON.stringify(expectedKey)} returned a non-JSON value.`);
  const nullableStrings = ["variant_key", "rule_id", "experiment_id", "experiment_run_id", "exposure_token"];
  for (const field of nullableStrings) {
    if (value[field] !== null && typeof value[field] !== "string") {
      throw new HexclaveAssertionError(`Feature flag ${JSON.stringify(expectedKey)} returned an invalid ${field}.`);
    }
  }
  if (typeof value.reason !== "string" || typeof value.config_version !== "string") {
    throw new HexclaveAssertionError(`Feature flag ${JSON.stringify(expectedKey)} returned invalid evaluation metadata.`);
  }
}

function validateWireResponse(value: unknown, expectedKeys: readonly string[]): void {
  if (!isRecord(value) || !isRecord(value.results)) {
    throw new HexclaveAssertionError("Feature flag evaluation response must contain a results object.");
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value.results, key)) {
      throw new HexclaveAssertionError(`Feature flag evaluation response omitted ${JSON.stringify(key)}.`);
    }
    validateWireResult(value.results[key], key);
  }
}

function fromWireResult<T extends Json>(result: FeatureFlagEvaluateResult<T>): FeatureFlagDetails<T> {
  return {
    flagKey: result.flag_key,
    value: result.value,
    variantKey: result.variant_key,
    reason: result.reason,
    ruleId: result.rule_id,
    configVersion: result.config_version,
    experimentId: result.experiment_id,
    experimentRunId: result.experiment_run_id,
    isStale: result.is_stale ?? false,
    exposureToken: result.exposure_token,
  };
}

export class FeatureFlagController<TIdentity> {
  private readonly _evaluationPromises = new Map<string, CachedPromise<FeatureFlagEvaluateResponse<Json>>>();
  private readonly _resultPromises = new Map<string, CachedPromise<Map<string, FeatureFlagDetails<Json>>>>();
  private readonly _configVersionByIdentity = new Map<string, string>();
  private readonly _teamIdByDetails = new WeakMap<FeatureFlagDetails<Json>, string | null>();
  private readonly _completedExposureKeys = new Set<string>();
  private readonly _pendingExposurePromises = new Map<string, Promise<void>>();
  private readonly _retryExposureBatches = new Map<string, {
    entries: { key: string, exposure: FeatureFlagExposureRequest }[],
  }>();

  constructor(private readonly _dependencies: FeatureFlagControllerDependencies<TIdentity>) {}

  getFeatureFlagDetails<T extends Json>(
    identity: FeatureFlagIdentity<TIdentity>,
    key: string,
    fallback: T,
    options?: FeatureFlagOptions,
  ): Promise<FeatureFlagDetails<T>> {
    return this.getFeatureFlagDetailsPromise(identity, key, fallback, options)
      .then((details) => {
        const narrowed = narrowFeatureFlagDetails(details, fallback);
        if (this._teamIdByDetails.has(details)) {
          this._teamIdByDetails.set(narrowed, this._teamIdByDetails.get(details) ?? null);
        }
        return narrowed;
      });
  }

  getFeatureFlagDetailsPromise(
    identity: FeatureFlagIdentity<TIdentity>,
    key: string,
    fallback: Json,
    options?: FeatureFlagOptions,
  ): Promise<FeatureFlagDetails<Json>> {
    return this._getFeatureFlags(identity, [{ key, fallback, options }]).then((results) => {
      const result = results.get(key);
      if (result == null) throw new HexclaveAssertionError(`Feature flag evaluation did not include ${JSON.stringify(key)}.`);
      return result;
    });
  }

  async getFeatureFlag<T extends Json>(
    identity: FeatureFlagIdentity<TIdentity>,
    key: string,
    fallback: T,
    options?: FeatureFlagOptions,
  ): Promise<T> {
    return (await this.getFeatureFlagDetails(identity, key, fallback, options)).value;
  }

  getFeatureFlags(
    identity: FeatureFlagIdentity<TIdentity>,
    requests: readonly FeatureFlagRequest[],
  ): Promise<Map<string, FeatureFlagDetails<Json>>> {
    return this._getFeatureFlags(identity, requests);
  }

  async trackFeatureFlagExposure(
    identity: FeatureFlagIdentity<TIdentity>,
    details: FeatureFlagDetails<Json>,
  ): Promise<void> {
    await this._trackExposures(identity, [details]);
  }

  private _getFeatureFlags(
    identity: FeatureFlagIdentity<TIdentity>,
    requests: readonly FeatureFlagRequest[],
  ): Promise<Map<string, FeatureFlagDetails<Json>>> {
    validateRequests(requests);
    const resultPromise = this._getOrCreateResultPromise(identity, requests);
    // Resolve analytics context after evaluation rather than during React
    // render. Apply it for cache hits too: another flag call may have changed
    // the active team since this result was first evaluated.
    //
    // This runs on a detached branch instead of being chained onto the returned
    // promise on purpose: the React hook suspends on the returned promise with
    // use(), which only settles if it sees the *same* promise object on every
    // render. A fresh .then() wrapper per call re-suspends indefinitely once
    // the evaluation rejects. The branch's rejection is ignored because the
    // identical rejection already reaches the caller through resultPromise.
    runAsynchronously(resultPromise.then(
      () => this._dependencies.onTeamContextResolved?.(requests.find((request) => request.options?.teamId != null)?.options?.teamId ?? null),
      () => undefined,
    ));
    return resultPromise;
  }

  private _getOrCreateResultPromise(
    identity: FeatureFlagIdentity<TIdentity>,
    requests: readonly FeatureFlagRequest[],
  ): Promise<Map<string, FeatureFlagDetails<Json>>> {
    const resultKey = `${identity.cacheKey}:${canonicalFeatureFlagRequestKey(requests)}`;
    const cachedResult = this._resultPromises.get(resultKey);
    if (cachedResult != null && this._isFresh(cachedResult)) return cachedResult.promise;
    this._resultPromises.delete(resultKey);
    const networkKey = `${identity.cacheKey}:${canonicalNetworkRequestKey(requests)}`;
    const cachedEvaluation = this._evaluationPromises.get(networkKey);
    const evaluationPromise = cachedEvaluation != null && this._isFresh(cachedEvaluation)
      ? cachedEvaluation.promise
      : this._evaluateWire(identity, requests, networkKey);
    const resultPromise = evaluationPromise.then(async (response) => await this._mapResponse(identity, requests, response));
    setBoundedMap(this._resultPromises, resultKey, { promise: resultPromise, createdAt: this._now() }, this._maxCacheEntries());
    return resultPromise;
  }

  private _evaluateWire(
    identity: FeatureFlagIdentity<TIdentity>,
    requests: readonly FeatureFlagRequest[],
    requestKey: string,
  ): Promise<FeatureFlagEvaluateResponse<Json>> {
    const evaluationPromise = this._dependencies.evaluate(identity.value, toWireRequest(requests));
    setBoundedMap(this._evaluationPromises, requestKey, { promise: evaluationPromise, createdAt: this._now() }, this._maxCacheEntries());
    return evaluationPromise;
  }

  private _isFresh<T>(cached: CachedPromise<T>): boolean {
    const ttl = this._dependencies.cacheTtlMillis;
    return ttl == null || this._now() - cached.createdAt < ttl;
  }

  private _now(): number {
    return this._dependencies.now?.() ?? performance.now();
  }

  private _maxCacheEntries(): number {
    return this._dependencies.cacheMaxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  }

  private async _mapResponse(
    identity: FeatureFlagIdentity<TIdentity>,
    requests: readonly FeatureFlagRequest[],
    response: FeatureFlagEvaluateResponse<Json>,
  ): Promise<Map<string, FeatureFlagDetails<Json>>> {
    validateWireResponse(response, requests.map((request) => request.key));

    const results = new Map<string, FeatureFlagDetails<Json>>();
    for (const request of [...requests].sort((left, right) => stringCompare(left.key, right.key))) {
      if (!Object.prototype.hasOwnProperty.call(response.results, request.key)) {
        throw new HexclaveAssertionError(`Feature flag evaluation response omitted ${JSON.stringify(request.key)}.`);
      }
      const wireResult = response.results[request.key];
      const details = fromWireResult({ ...wireResult, value: wireResult.value });
      if (details.exposureToken != null) {
        this._teamIdByDetails.set(details, request.options?.teamId ?? null);
      }
      results.set(request.key, request.options?.exposure === "none" ? { ...details, exposureToken: null } : details);
    }

    const versions = new Set([...results.values()].map((result) => result.configVersion));
    if (versions.size !== 1) throw new HexclaveAssertionError("Feature flag evaluation returned multiple config versions in one response.");
    const configVersion = versions.values().next().value;
    if (configVersion == null) throw new HexclaveAssertionError("Feature flag evaluation did not return a config version.");
    const previousVersion = this._configVersionByIdentity.get(identity.cacheKey);
    if (previousVersion != null && previousVersion !== configVersion) {
      for (const key of this._evaluationPromises.keys()) {
        if (key.startsWith(`${identity.cacheKey}:`)) this._evaluationPromises.delete(key);
      }
      for (const key of this._resultPromises.keys()) {
        if (key.startsWith(`${identity.cacheKey}:`)) this._resultPromises.delete(key);
      }
    }
    setBoundedMap(this._configVersionByIdentity, identity.cacheKey, configVersion, this._maxCacheEntries());

    const automatic = [...results.values()].filter((result) => {
      const request = requests.find((candidate) => candidate.key === result.flagKey);
      return (request?.options?.exposure ?? "auto") === "auto";
    });
    await this._trackExposures(identity, automatic);
    return results;
  }

  private async _trackExposures(
    identity: FeatureFlagIdentity<TIdentity>,
    details: readonly FeatureFlagDetails<Json>[],
  ): Promise<void> {
    const pendingDetails = details.filter((detail) => detail.exposureToken != null).filter((detail) => {
      const key = this._exposureKey(identity, detail);
      return !this._completedExposureKeys.has(key) && !this._pendingExposurePromises.has(key);
    });
    if (pendingDetails.length === 0) {
      await Promise.all(details.map((detail) => this._pendingExposurePromises.get(this._exposureKey(identity, detail))).filter((promise) => promise != null));
      return;
    }

    const batches = new Set<{ entries: { key: string, exposure: FeatureFlagExposureRequest }[] }>();
    const freshEntries: { key: string, exposure: FeatureFlagExposureRequest }[] = [];
    for (const detail of pendingDetails) {
      const key = this._exposureKey(identity, detail);
      const retryBatch = this._retryExposureBatches.get(key);
      if (retryBatch !== undefined) {
        batches.add(retryBatch);
        continue;
      }
      if (detail.exposureToken == null) throw new HexclaveAssertionError("A pending feature flag exposure must have an exposure token.");
      freshEntries.push({
        key,
        exposure: {
          event_id: generateUuid(),
          exposure_token: detail.exposureToken,
          exposed_at_ms: Date.now(),
        },
      });
    }
    if (freshEntries.length > 0) batches.add({ entries: freshEntries });

    await Promise.all([...batches].map(async (batch) => {
      for (const entry of batch.entries) setBoundedMap(this._retryExposureBatches, entry.key, batch, MAX_COMPLETED_EXPOSURE_KEYS);
      const promise = this._dependencies.sendExposures(identity.value, batch.entries.map((entry) => entry.exposure));
      for (const entry of batch.entries) this._pendingExposurePromises.set(entry.key, promise);
      try {
        await promise;
        for (const entry of batch.entries) {
          this._completedExposureKeys.add(entry.key);
          this._retryExposureBatches.delete(entry.key);
        }
        // Server apps can evaluate for many identities over a long process
        // lifetime. Keep SDK-level deduplication bounded; the durable signed
        // evaluation-id ledger remains the final idempotency backstop.
        while (this._completedExposureKeys.size > MAX_COMPLETED_EXPOSURE_KEYS) {
          const oldestKey = this._completedExposureKeys.values().next().value;
          if (oldestKey == null) throw new HexclaveAssertionError("A non-empty completed exposure set did not yield its oldest key.");
          this._completedExposureKeys.delete(oldestKey);
        }
      } finally {
        for (const entry of batch.entries) this._pendingExposurePromises.delete(entry.key);
      }
    }));
  }

  private _exposureKey(identity: FeatureFlagIdentity<TIdentity>, details: FeatureFlagDetails<Json>): string {
    const selectedTeam = this._teamIdByDetails.get(details);
    // Details produced by this controller carry the selected team through the
    // token map. For externally reconstructed details, fall back to the signed
    // token itself so distinct team-bound credentials are never conflated.
    const subjectKey = selectedTeam === undefined
      ? `token:${details.exposureToken ?? ""}`
      : `team:${selectedTeam ?? ""}`;
    return `${identity.cacheKey}:${subjectKey}:${details.configVersion}:${details.flagKey}:${details.experimentRunId ?? ""}`;
  }
}
