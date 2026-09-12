import { getEnvVariable } from "@hexclave/shared/dist/utils/env";

export function getConfiguredTvDisplayOrigin(): string {
  return getEnvVariable(
    "HEXCLAVE_TV_DISPLAY_ORIGIN",
    getEnvVariable(
      "NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL",
      getEnvVariable("NEXT_PUBLIC_STACK_DASHBOARD_URL", ""),
    ),
  ).trim();
}
