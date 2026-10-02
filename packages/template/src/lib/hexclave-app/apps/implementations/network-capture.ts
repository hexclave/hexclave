/** User-facing network capture options (`ObservabilityOptions.network`). */
export type NetworkOptions = {
  enabled?: boolean,
  allowOrigins?: string[],
  denyOrigins?: string[],
  ignoreUrls?: string[],
};

/** Normalized URL policy consumed by the official OTel HTTP instrumentations. */
export type NetworkCaptureConfig = {
  enabled: boolean,
  allowOrigins: readonly string[] | null,
  denyOrigins: readonly string[] | null,
  ignoreUrls: readonly string[],
};

export function normalizeNetworkCaptureOptions(options: NetworkOptions | undefined): NetworkCaptureConfig {
  if (options?.allowOrigins !== undefined && options.denyOrigins !== undefined) {
    throw new Error("Hexclave analytics: network.allowOrigins and network.denyOrigins are mutually exclusive; set at most one");
  }
  return {
    enabled: options?.enabled ?? true,
    allowOrigins: options?.allowOrigins ?? null,
    denyOrigins: options?.denyOrigins ?? null,
    ignoreUrls: options?.ignoreUrls ?? [],
  };
}

export function shouldCaptureNetworkRequest(config: NetworkCaptureConfig, target: URL): boolean {
  if (!config.enabled) return false;
  if (config.allowOrigins !== null && !config.allowOrigins.includes(target.origin)) return false;
  if (config.denyOrigins !== null && config.denyOrigins.includes(target.origin)) return false;
  return !config.ignoreUrls.some((ignored) => ignored !== "" && target.href.includes(ignored));
}
