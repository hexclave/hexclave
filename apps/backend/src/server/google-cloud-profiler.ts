export const googleCloudProfilerEnabledEnvVar = "HEXCLAVE_GOOGLE_CLOUD_PROFILER_ENABLED";

export type GoogleCloudProfilerConfig = {
  service: string,
  version: string,
};

export function parseGoogleCloudProfilerConfig(options: {
  enabled: string,
  cloudRunService: string,
  cloudRunRevision: string,
}): GoogleCloudProfilerConfig | undefined {
  const enabled = options.enabled.trim();
  if (enabled === "" || enabled === "false") {
    return undefined;
  }
  if (enabled !== "true") {
    throw new Error(`${googleCloudProfilerEnabledEnvVar} must be "true" or "false", got: ${JSON.stringify(options.enabled)}`);
  }
  // The agent authenticates and discovers the project through the GCP metadata server, so it only
  // works on GCP. K_SERVICE/K_REVISION are set by Cloud Run; using them as the service context
  // keeps profiles from different services and revisions separable in the Profiler UI.
  if (options.cloudRunService === "" || options.cloudRunRevision === "") {
    throw new Error(`${googleCloudProfilerEnabledEnvVar} is only supported on Cloud Run (K_SERVICE and K_REVISION must be set)`);
  }
  return {
    service: options.cloudRunService,
    version: options.cloudRunRevision,
  };
}

export async function startGoogleCloudProfiler(config: GoogleCloudProfilerConfig): Promise<void> {
  // Imported lazily so the native pprof addon is only loaded when profiling is enabled.
  const profiler = await import("@google-cloud/profiler");
  // The agent continuously collects wall-time and heap profiles (one ~10s profile per type per
  // minute across the whole service, so overhead is spread thin) and uploads them in the background.
  await profiler.start({
    serviceContext: config,
  });
}
