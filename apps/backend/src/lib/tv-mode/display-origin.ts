import { getEnvVariable } from "@hexclave/shared/dist/utils/env";

export function getConfiguredTvDisplayOrigin(): string {
  // TV runs on the dashboard origin. Use the same canonical setting as other
  // backend dashboard integrations so stale TV/browser overrides cannot select
  // a different credentialed origin. The shared reader supports the legacy alias.
  return getEnvVariable("NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL", "").trim();
}
