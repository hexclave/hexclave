import { getPublicEnvVar } from "@/lib/env";
import { isLocalhost } from "@hexclave/shared/dist/utils/urls";

type TvDisplayUrlSources = {
  dashboardUrl?: string,
  currentOrigin?: string,
};

export function buildTvDisplayUrl(sources: TvDisplayUrlSources): string | null {
  for (const candidate of [sources.dashboardUrl, sources.currentOrigin]) {
    if (candidate == null || candidate.trim() === "" || !URL.canParse("/tv", candidate)) continue;
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
    return new URL("/tv", parsed).toString();
  }
  return null;
}

export function getConfiguredTvDisplayUrl(currentOrigin?: string): string | null {
  return buildTvDisplayUrl({
    // This legacy lookup key also reads NEXT_PUBLIC_HEXCLAVE_DASHBOARD_URL;
    // keep TV links aligned with the backend's canonical dashboard origin.
    dashboardUrl: getPublicEnvVar("NEXT_PUBLIC_STACK_DASHBOARD_URL"),
    currentOrigin,
  });
}

export function isLocalTvDisplayUrl(url: string): boolean {
  return isLocalhost(new URL(url));
}
