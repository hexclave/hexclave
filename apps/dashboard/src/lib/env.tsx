/* eslint-disable no-restricted-syntax */


export function expandHexclavePortPrefix(value?: string | null) {
  if (!value) return value ?? undefined;
  // Hexclave rebrand: port-prefix var renamed outright (no dual-read).
  const prefix = getPublicEnvVar("NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX") ?? "81";
  return prefix ? value.replace(/\$\{NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX:-81\}/g, prefix as string) : value;
}

function isPostBuildEnvVarSentinel(value: string): boolean {
  return value.startsWith("STACK_ENV_VAR_SENTINEL");
}

function resolveInlineRenamedEnvVar(hexclaveName: string, stackName: string, hexclaveValue: string | undefined, stackValue: string | undefined): string | undefined {
  const usableHexclaveValue = hexclaveValue && !isPostBuildEnvVarSentinel(hexclaveValue) ? hexclaveValue : undefined;
  const usableStackValue = stackValue && !isPostBuildEnvVarSentinel(stackValue) ? stackValue : undefined;
  if (
    usableHexclaveValue
    && usableStackValue
    && usableHexclaveValue !== usableStackValue
  ) {
    throw new Error(`Environment variables ${hexclaveName} and ${stackName} are both set to different values. Remove one of them or set them to the same value.`);
  }
  // Prefer a real (non-sentinel) Hexclave value, then a real Stack value. When
  // neither is "real", fall back to the raw value with `??` so an empty-string
  // placeholder or an unreplaced sentinel is passed through unchanged (matching
  // the pre-rename `process.env.X ?? process.env.Y` inline behavior) instead of
  // collapsing to `undefined` — downstream readers use `?? throwErr(...)`, which
  // treats `undefined` (but not `""`) as "missing" and would crash the build.
  return usableHexclaveValue || usableStackValue || (hexclaveValue ?? stackValue);
}

// Hexclave rebrand: each entry prefers the NEXT_PUBLIC_HEXCLAVE_* literal, falling back
// to the legacy NEXT_PUBLIC_*STACK_* literal. Both operands must stay literal
// `process.env.NEXT_PUBLIC_*` references so Next.js can inline them at build time.
const _inlineEnvVars = {
  NEXT_PUBLIC_STACK_API_URL: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_API_URL", "NEXT_PUBLIC_STACK_API_URL", process.env.NEXT_PUBLIC_HEXCLAVE_API_URL, process.env.NEXT_PUBLIC_STACK_API_URL),
  NEXT_PUBLIC_STACK_DASHBOARD_URL: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL", "NEXT_PUBLIC_STACK_DASHBOARD_URL", process.env.NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL, process.env.NEXT_PUBLIC_STACK_DASHBOARD_URL),
  NEXT_PUBLIC_STACK_SVIX_SERVER_URL: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_SVIX_SERVER_URL", "NEXT_PUBLIC_STACK_SVIX_SERVER_URL", process.env.NEXT_PUBLIC_HEXCLAVE_SVIX_SERVER_URL, process.env.NEXT_PUBLIC_STACK_SVIX_SERVER_URL),
  NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_IS_REMOTE_DEVELOPMENT_ENVIRONMENT", "NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT", process.env.NEXT_PUBLIC_HEXCLAVE_IS_REMOTE_DEVELOPMENT_ENVIRONMENT, process.env.NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT),
  NEXT_PUBLIC_STACK_IS_PREVIEW: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_IS_PREVIEW", "NEXT_PUBLIC_STACK_IS_PREVIEW", process.env.NEXT_PUBLIC_HEXCLAVE_IS_PREVIEW, process.env.NEXT_PUBLIC_STACK_IS_PREVIEW),
  NEXT_PUBLIC_HEXCLAVE_LOCAL_DASHBOARD_PORT: process.env.NEXT_PUBLIC_HEXCLAVE_LOCAL_DASHBOARD_PORT,
  NEXT_PUBLIC_STACK_PROJECT_ID: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_PROJECT_ID", "NEXT_PUBLIC_STACK_PROJECT_ID", process.env.NEXT_PUBLIC_HEXCLAVE_PROJECT_ID, process.env.NEXT_PUBLIC_STACK_PROJECT_ID),
  NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY", "NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY", process.env.NEXT_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY, process.env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY),
  NEXT_PUBLIC_STACK_URL: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_URL", "NEXT_PUBLIC_STACK_URL", process.env.NEXT_PUBLIC_HEXCLAVE_URL, process.env.NEXT_PUBLIC_STACK_URL),
  NEXT_PUBLIC_STACK_INBUCKET_WEB_URL: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_INBUCKET_WEB_URL", "NEXT_PUBLIC_STACK_INBUCKET_WEB_URL", process.env.NEXT_PUBLIC_HEXCLAVE_INBUCKET_WEB_URL, process.env.NEXT_PUBLIC_STACK_INBUCKET_WEB_URL),
  NEXT_PUBLIC_STACK_ENABLE_DEVELOPMENT_FEATURES_PROJECT_IDS: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_ENABLE_DEVELOPMENT_FEATURES_PROJECT_IDS", "NEXT_PUBLIC_STACK_ENABLE_DEVELOPMENT_FEATURES_PROJECT_IDS", process.env.NEXT_PUBLIC_HEXCLAVE_ENABLE_DEVELOPMENT_FEATURES_PROJECT_IDS, process.env.NEXT_PUBLIC_STACK_ENABLE_DEVELOPMENT_FEATURES_PROJECT_IDS),
  NEXT_PUBLIC_STACK_STRIPE_PUBLISHABLE_KEY: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_STRIPE_PUBLISHABLE_KEY", "NEXT_PUBLIC_STACK_STRIPE_PUBLISHABLE_KEY", process.env.NEXT_PUBLIC_HEXCLAVE_STRIPE_PUBLISHABLE_KEY, process.env.NEXT_PUBLIC_STACK_STRIPE_PUBLISHABLE_KEY),
  // Hexclave rebrand: port-prefix var renamed outright (no dual-read).
  NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX: process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX,
  NEXT_PUBLIC_STACK_DOCS_BASE_URL: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_DOCS_BASE_URL", "NEXT_PUBLIC_STACK_DOCS_BASE_URL", process.env.NEXT_PUBLIC_HEXCLAVE_DOCS_BASE_URL, process.env.NEXT_PUBLIC_STACK_DOCS_BASE_URL),
  NEXT_PUBLIC_STACK_ENABLE_REACT_SCAN_IN_DEVELOPMENT: resolveInlineRenamedEnvVar("NEXT_PUBLIC_HEXCLAVE_ENABLE_REACT_SCAN_IN_DEVELOPMENT", "NEXT_PUBLIC_STACK_ENABLE_REACT_SCAN_IN_DEVELOPMENT", process.env.NEXT_PUBLIC_HEXCLAVE_ENABLE_REACT_SCAN_IN_DEVELOPMENT, process.env.NEXT_PUBLIC_STACK_ENABLE_REACT_SCAN_IN_DEVELOPMENT),
  NEXT_PUBLIC_HEXCLAVE_TV_QUICK_TUNNEL_ENABLED: process.env.NEXT_PUBLIC_HEXCLAVE_TV_QUICK_TUNNEL_ENABLED,

  // TODO: NEXT_PUBLIC_BROWSER_STACK_API_URL should be renamed to NEXT_PUBLIC_STACK_BROWSER_API_URL
  NEXT_PUBLIC_BROWSER_STACK_API_URL: resolveInlineRenamedEnvVar("NEXT_PUBLIC_BROWSER_HEXCLAVE_API_URL", "NEXT_PUBLIC_BROWSER_STACK_API_URL", process.env.NEXT_PUBLIC_BROWSER_HEXCLAVE_API_URL, process.env.NEXT_PUBLIC_BROWSER_STACK_API_URL),
  // TODO: NEXT_PUBLIC_SERVER_STACK_API_URL should be renamed to NEXT_PUBLIC_STACK_SERVER_API_URL
  NEXT_PUBLIC_SERVER_STACK_API_URL: resolveInlineRenamedEnvVar("NEXT_PUBLIC_SERVER_HEXCLAVE_API_URL", "NEXT_PUBLIC_SERVER_STACK_API_URL", process.env.NEXT_PUBLIC_SERVER_HEXCLAVE_API_URL, process.env.NEXT_PUBLIC_SERVER_STACK_API_URL),
  // TODO: NEXT_PUBLIC_SENTRY_DSN should be renamed to NEXT_PUBLIC_STACK_SENTRY_DSN
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // TODO: NEXT_PUBLIC_VERSION_ALERTER_SEVERE_ONLY should be renamed to NEXT_PUBLIC_STACK_VERSION_ALERTER_SEVERE_ONLY
  NEXT_PUBLIC_VERSION_ALERTER_SEVERE_ONLY: process.env.NEXT_PUBLIC_VERSION_ALERTER_SEVERE_ONLY,
  // TODO: NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL should be renamed to NEXT_PUBLIC_STACK_BROWSER_DASHBOARD_URL
  NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL: resolveInlineRenamedEnvVar("NEXT_PUBLIC_BROWSER_HEXCLAVE_DASHBOARD_URL", "NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL", process.env.NEXT_PUBLIC_BROWSER_HEXCLAVE_DASHBOARD_URL, process.env.NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL),
  // TODO: NEXT_PUBLIC_SERVER_STACK_DASHBOARD_URL should be renamed to NEXT_PUBLIC_STACK_SERVER_DASHBOARD_URL
  NEXT_PUBLIC_SERVER_STACK_DASHBOARD_URL: resolveInlineRenamedEnvVar("NEXT_PUBLIC_SERVER_HEXCLAVE_DASHBOARD_URL", "NEXT_PUBLIC_SERVER_STACK_DASHBOARD_URL", process.env.NEXT_PUBLIC_SERVER_HEXCLAVE_DASHBOARD_URL, process.env.NEXT_PUBLIC_SERVER_STACK_DASHBOARD_URL),
  // TODO: NEXT_PUBLIC_POSTHOG_KEY should be renamed to NEXT_PUBLIC_STACK_POSTHOG_KEY
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
} as const;

// This will be replaced with the actual env vars after a docker build.
// Hexclave rebrand: sentinel STRING values intentionally keep their legacy
// NEXT_PUBLIC_STACK_* names. docker/server/entrypoint.sh derives the env var to
// substitute via `${sentinel#STACK_ENV_VAR_SENTINEL_}` and only exports the
// NEXT_PUBLIC_STACK_* names — renaming the sentinels here would break docker
// self-host substitution. Dual-read in the docker post-build path needs an
// entrypoint.sh change (separate work-area). Hexclave-only variables that are
// injected outside the docker entrypoint can use Hexclave sentinel names.
const _postBuildEnvVars = {
  NEXT_PUBLIC_STACK_API_URL: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_API_URL",
  NEXT_PUBLIC_BROWSER_STACK_API_URL: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_BROWSER_STACK_API_URL",
  NEXT_PUBLIC_SERVER_STACK_API_URL: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_SERVER_STACK_API_URL",
  NEXT_PUBLIC_STACK_DASHBOARD_URL: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_DASHBOARD_URL",
  NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL",
  NEXT_PUBLIC_SERVER_STACK_DASHBOARD_URL: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_SERVER_STACK_DASHBOARD_URL",
  NEXT_PUBLIC_STACK_PROJECT_ID: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_PROJECT_ID",
  NEXT_PUBLIC_POSTHOG_KEY: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_POSTHOG_KEY",
  NEXT_PUBLIC_STACK_SVIX_SERVER_URL: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_SVIX_SERVER_URL",
  NEXT_PUBLIC_SENTRY_DSN: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_SENTRY_DSN",
  NEXT_PUBLIC_VERSION_ALERTER_SEVERE_ONLY: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_VERSION_ALERTER_SEVERE_ONLY",
  NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT",
  NEXT_PUBLIC_STACK_IS_PREVIEW: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_IS_PREVIEW",
  NEXT_PUBLIC_HEXCLAVE_LOCAL_DASHBOARD_PORT: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_HEXCLAVE_LOCAL_DASHBOARD_PORT",
  NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY",
  NEXT_PUBLIC_STACK_URL: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_URL",
  NEXT_PUBLIC_STACK_INBUCKET_WEB_URL: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_INBUCKET_WEB_URL",
  NEXT_PUBLIC_STACK_ENABLE_DEVELOPMENT_FEATURES_PROJECT_IDS: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_ENABLE_DEVELOPMENT_FEATURES_PROJECT_IDS",
  NEXT_PUBLIC_STACK_STRIPE_PUBLISHABLE_KEY: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_STRIPE_PUBLISHABLE_KEY",
  NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX",
  NEXT_PUBLIC_STACK_DOCS_BASE_URL: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_DOCS_BASE_URL",
  NEXT_PUBLIC_STACK_ENABLE_REACT_SCAN_IN_DEVELOPMENT: "STACK_ENV_VAR_SENTINEL_NEXT_PUBLIC_STACK_ENABLE_REACT_SCAN_IN_DEVELOPMENT",
  // The Quick Tunnel transport is a next-dev-only build option and must never
  // become activatable through runtime substitution in a production image.
  NEXT_PUBLIC_HEXCLAVE_TV_QUICK_TUNNEL_ENABLED: "",
} satisfies typeof _inlineEnvVars;

// If this is not replaced with "true", then we will not use inline env vars
const _usePostBuildEnvVars = 'STACK_ENV_VAR_SENTINEL_USE_INLINE_ENV_VARS';

export function getPublicEnvVar(name: keyof typeof _inlineEnvVars): string | undefined {
  // This is a hack to force the compiler not to do any smart optimizations
  const _ = _usePostBuildEnvVars.toString() + _inlineEnvVars.toString(); // Force runtime evaluation

  const value = _usePostBuildEnvVars.slice(0) === 'true' ? _postBuildEnvVars[name] : _inlineEnvVars[name];

  if (_usePostBuildEnvVars.slice(0) === 'true' && value && value.startsWith('STACK_ENV_VAR_SENTINEL')) {
    return undefined;
  }

  return name.startsWith('NEXT_PUBLIC_STACK_') ? expandHexclavePortPrefix(value) : value;
}
