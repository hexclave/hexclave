import type { ResponseCookieOptions } from "@/lib/runtime/request-context";
import { getConfiguredTvDisplayOrigin } from "./display-origin";
import { getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";

const TV_DISPLAY_REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const TV_DISPLAY_LATEST_REFRESH_COOKIE_PATH = "/api/latest/tv-displays";
const TV_DISPLAY_V1_REFRESH_COOKIE_PATH = "/api/v1/tv-displays";
const LEGACY_TV_DISPLAY_REFRESH_COOKIE_PATH = "/api";

type TvDisplayRefreshCookieReader = {
  get: (name: string) => { value: string } | undefined,
};

type TvDisplayRefreshCookieStore = {
  set: (name: string, value: string, options: ResponseCookieOptions) => void,
};

function v1RefreshCookieName(cookieName: string): string {
  return `${cookieName}-v1`;
}

export function readTvDisplayRefreshCookie(
  cookieStore: TvDisplayRefreshCookieReader,
  cookieName: string,
  requestUrl: string,
): string | undefined {
  if (new URL(requestUrl).pathname.startsWith(`${TV_DISPLAY_V1_REFRESH_COOKIE_PATH}/`)) {
    // Existing v1 displays may still have the old name. Fall back only when the
    // new cookie is absent, never after validation fails or detects token reuse.
    const versionedCookie = cookieStore.get(v1RefreshCookieName(cookieName));
    if (versionedCookie != null) return versionedCookie.value;
  }
  return cookieStore.get(cookieName)?.value;
}

function baseTvDisplayRefreshCookieOptions(path: string): ResponseCookieOptions {
  const secure = getNodeEnvironment() !== "development" && getNodeEnvironment() !== "test";
  const configuredDisplayOrigin = getConfiguredTvDisplayOrigin();
  let crossSiteDisplay = false;
  if (configuredDisplayOrigin !== "") {
    const backendOrigin = getEnvVariable("NEXT_PUBLIC_HEXCLAVE_API_URL", "").trim();
    const displayUrl = URL.parse(configuredDisplayOrigin);
    const backendUrl = URL.parse(backendOrigin);
    if (
      displayUrl != null
      && backendUrl != null
      && (displayUrl.protocol === "http:" || displayUrl.protocol === "https:")
      && displayUrl.origin !== backendUrl.origin
    ) {
      crossSiteDisplay = true;
    }
  }
  return {
    httpOnly: true,
    secure,
    // Relax only for an exact-origin credentialed CORS allowlist; this remains
    // HttpOnly, path-scoped, and a rotating 30-day credential.
    sameSite: secure && crossSiteDisplay ? "none" : "strict",
    path,
  };
}

function tvDisplayRefreshCookieOptions(path: string): ResponseCookieOptions {
  return {
    ...baseTvDisplayRefreshCookieOptions(path),
    maxAge: TV_DISPLAY_REFRESH_MAX_AGE_SECONDS,
  };
}

function clearedTvDisplayRefreshCookieOptions(path: string): ResponseCookieOptions {
  return {
    ...baseTvDisplayRefreshCookieOptions(path),
    expires: new Date(0),
    maxAge: 0,
  };
}

export function setTvDisplayRefreshCookie(
  cookieStore: TvDisplayRefreshCookieStore,
  cookieName: string,
  refreshToken: string,
): void {
  // libsoup 3.6.5's SQLite jar replaces cookies by name + host, ignoring path.
  // Using one name for both aliases loses the latest cookie on disk after rotation.
  // Clear legacy scopes BEFORE writing replacements: their deletion can otherwise
  // erase the freshly persisted latest cookie in affected WPE browsers.
  cookieStore.set(cookieName, "", clearedTvDisplayRefreshCookieOptions(LEGACY_TV_DISPLAY_REFRESH_COOKIE_PATH));
  cookieStore.set(cookieName, "", clearedTvDisplayRefreshCookieOptions(TV_DISPLAY_V1_REFRESH_COOKIE_PATH));
  cookieStore.set(cookieName, refreshToken, tvDisplayRefreshCookieOptions(TV_DISPLAY_LATEST_REFRESH_COOKIE_PATH));
  cookieStore.set(v1RefreshCookieName(cookieName), refreshToken, tvDisplayRefreshCookieOptions(TV_DISPLAY_V1_REFRESH_COOKIE_PATH));
}

export function clearTvDisplayRefreshCookie(
  cookieStore: TvDisplayRefreshCookieStore,
  cookieName: string,
): void {
  for (const path of [TV_DISPLAY_LATEST_REFRESH_COOKIE_PATH, TV_DISPLAY_V1_REFRESH_COOKIE_PATH, LEGACY_TV_DISPLAY_REFRESH_COOKIE_PATH]) {
    cookieStore.set(cookieName, "", clearedTvDisplayRefreshCookieOptions(path));
  }
  cookieStore.set(v1RefreshCookieName(cookieName), "", clearedTvDisplayRefreshCookieOptions(TV_DISPLAY_V1_REFRESH_COOKIE_PATH));
}
