import { getPublicEnvVar } from "@/lib/env";
import { isLocalhost } from "@hexclave/shared/dist/utils/urls";

type TvDisplayUrlSources = {
  browserDashboardUrl?: string,
  dashboardUrl?: string,
  currentOrigin?: string,
};

export function buildTvDisplayUrl(sources: TvDisplayUrlSources): string | null {
  for (const candidate of [sources.browserDashboardUrl, sources.dashboardUrl, sources.currentOrigin]) {
    if (candidate == null || candidate.trim() === "" || !URL.canParse("/tv", candidate)) continue;
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    return new URL("/tv", parsed).toString();
  }
  return null;
}

export function getConfiguredTvDisplayUrl(currentOrigin?: string): string | null {
  return buildTvDisplayUrl({
    browserDashboardUrl: getPublicEnvVar("NEXT_PUBLIC_BROWSER_STACK_DASHBOARD_URL"),
    dashboardUrl: getPublicEnvVar("NEXT_PUBLIC_STACK_DASHBOARD_URL"),
    currentOrigin,
  });
}

export function isLocalTvDisplayUrl(url: string): boolean {
  return isLocalhost(new URL(url));
}
