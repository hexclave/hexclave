import { StackServerApp } from '@hexclave/js';
import { getEnvBoolean, getEnvVariable } from '@hexclave/shared/dist/utils/env';
import backendPackageJson from '../package.json';
import { getSentryRelease } from './sentry-release';

function createHexclaveServerApp() {
  // Fail fast if the backend self-URL env var is missing — without it the SDK
  // would silently inherit `defaultBaseUrl` (https://api.stack-auth.com), which
  // is almost never what we want for backend self-calls.
  //
  // We deliberately do NOT pass it as an explicit `baseUrl` to the SDK: doing
  // so collapses `resolveApiUrls` to a single-element URL list, which short-
  // circuits `_withFallback` (`apiUrls.length <= 1` branch). The SDK reads the
  // same env var internally and additionally appends its hardcoded fallback
  // URLs, which is what the e2e-fallback-tests workflow relies on so backend
  // self-calls (quota debits in email-queue-step, send-test-email, analytics
  // events batch, etc.) survive a primary-port outage.
  getEnvVariable('NEXT_PUBLIC_STACK_API_URL');
  const selfTelemetryEnabled = getEnvBoolean("HEXCLAVE_SELF_TELEMETRY_ENABLED");
  return new StackServerApp({
    projectId: 'internal',
    tokenStore: null,
    publishableClientKey: getEnvVariable('STACK_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY'),
    secretServerKey: getEnvVariable('STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY'),
    analytics: { enabled: selfTelemetryEnabled },
    observability: {
      enabled: selfTelemetryEnabled,
      spanPropagation: { enabled: false },
    },
    telemetry: {
      resource: {
        // Keep issue releases identical to Sentry releases so uploaded source
        // maps and both error products address the same deployed artifact.
        service: {
          name: "hexclave-backend",
          version: getSentryRelease({
            packageName: backendPackageJson.name,
            packageVersion: backendPackageJson.version,
          }),
        },
      },
    },
  });
}

let hexclaveServerApp: ReturnType<typeof createHexclaveServerApp> | null = null;

export function getHexclaveServerApp() {
  hexclaveServerApp ??= createHexclaveServerApp();
  return hexclaveServerApp;
}
