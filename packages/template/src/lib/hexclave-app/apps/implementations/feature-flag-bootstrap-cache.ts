import type { FeatureFlagBootstrapResponse } from "@hexclave/shared/dist/interface/crud/feature-flags";
import { createFeatureFlagsBootstrap } from "@hexclave/shared/dist/feature-flags/canonical";
import { getFeatureFlagsConfigErrors } from "@hexclave/shared/dist/feature-flags/schema";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

const REVALIDATE_AFTER_MILLIS = 30_000;
const SERVE_STALE_FOR_MILLIS = 5 * 60_000;

export type FeatureFlagBootstrapFetchResult =
  | { status: "not-modified" }
  | { status: "ok", data: FeatureFlagBootstrapResponse, etag: string | null };

export type FeatureFlagBootstrapSnapshot = FeatureFlagBootstrapResponse & { isStale: boolean };

export class FeatureFlagBootstrapUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Feature flag definitions are temporarily unavailable.", { cause });
    this.name = "FeatureFlagBootstrapUnavailableError";
  }
}

type CachedBootstrap = {
  data: FeatureFlagBootstrapResponse,
  etag: string | null,
  validatedAt: number,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isTransientFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof Error && error.cause != null && isTransientFailure(error.cause)) return true;
  if (!isRecord(error)) return false;
  if (typeof error.status === "number") return error.status === 408 || error.status === 429 || error.status >= 500;
  const extraData = error.extraData;
  if (!isRecord(extraData) || !(extraData.res instanceof Response)) return false;
  const status = extraData.res.status;
  return status === 408 || status === 429 || status >= 500;
}

function validateBootstrap(data: FeatureFlagBootstrapResponse): void {
  if (typeof data.config_version !== "string" || data.config_version === "") {
    throw new HexclaveAssertionError("Feature flag bootstrap returned an invalid config version.");
  }
  if (!isRecord(data.config) || !isRecord(data.flag_ids_by_key)) {
    throw new HexclaveAssertionError("Feature flag bootstrap returned invalid definitions.");
  }
  for (const [key, flagId] of Object.entries(data.flag_ids_by_key)) {
    if (key === "" || typeof flagId !== "string" || flagId === "") {
      throw new HexclaveAssertionError("Feature flag bootstrap returned an invalid public-key lookup.");
    }
  }
  const configErrors = getFeatureFlagsConfigErrors(data.config);
  if (configErrors.length > 0) {
    throw new HexclaveAssertionError(`Feature flag bootstrap returned invalid definitions: ${configErrors.join("; ")}`);
  }
  const canonical = createFeatureFlagsBootstrap(data.config);
  if (data.config_version !== canonical.configVersion) {
    throw new HexclaveAssertionError("Feature flag bootstrap config version does not match its definitions.");
  }
  const expectedEntries = Object.entries(canonical.flagIdsByKey).sort(([left], [right]) => stringCompare(left, right));
  const receivedEntries = Object.entries(data.flag_ids_by_key).sort(([left], [right]) => stringCompare(left, right));
  if (JSON.stringify(expectedEntries) !== JSON.stringify(receivedEntries)) {
    throw new HexclaveAssertionError("Feature flag bootstrap public-key lookup does not match its definitions.");
  }
}

export class FeatureFlagBootstrapCache {
  private _cached: CachedBootstrap | null = null;
  private _pending: Promise<FeatureFlagBootstrapSnapshot> | null = null;

  constructor(
    private readonly _fetch: (etag?: string) => Promise<FeatureFlagBootstrapFetchResult>,
    private readonly _now: () => number = () => performance.now(),
  ) {}

  get(): Promise<FeatureFlagBootstrapSnapshot> {
    const cached = this._cached;
    if (cached != null && this._now() - cached.validatedAt < REVALIDATE_AFTER_MILLIS) {
      return Promise.resolve({ ...cached.data, isStale: false });
    }
    if (this._pending != null) return this._pending;
    const pending = this._revalidate().finally(() => {
      if (this._pending === pending) this._pending = null;
    });
    this._pending = pending;
    return pending;
  }

  private async _revalidate(): Promise<FeatureFlagBootstrapSnapshot> {
    const previous = this._cached;
    try {
      const result = await this._fetch(previous?.etag ?? undefined);
      if (result.status === "not-modified") {
        if (previous == null) throw new HexclaveAssertionError("Feature flag bootstrap returned 304 before the SDK had a cached definition.");
        previous.validatedAt = this._now();
        return { ...previous.data, isStale: false };
      }
      validateBootstrap(result.data);
      this._cached = { data: result.data, etag: result.etag, validatedAt: this._now() };
      return { ...result.data, isStale: false };
    } catch (error) {
      if (!isTransientFailure(error)) throw error;
      if (previous != null && this._now() - previous.validatedAt <= SERVE_STALE_FOR_MILLIS) {
        return { ...previous.data, isStale: true };
      }
      throw new FeatureFlagBootstrapUnavailableError(error);
    }
  }
}
