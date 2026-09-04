"use client";

import Loading from "@/app/loading";
import { getPublicEnvVar } from "@/lib/env";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import { useStackApp } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useEffect, useState } from "react";
import { fetchWithRemoteDevelopmentEnvironmentBrowserSecret, RemoteDevelopmentEnvironmentBrowserSecretRedirectingError } from "./remote-development-environment-browser-secret-client";

const RDE_ACCESS_TOKEN_MIN_EXPIRATION_MS = 30_000;
const RDE_ACCESS_TOKEN_MAX_AGE_MS = 60_000;
const RDE_ACCESS_TOKEN_MIN_REFRESH_MS = 1_000;

type HexclaveAppTokenInternals = {
  signInWithTokens: (tokens: { accessToken: string, refreshToken: string }) => Promise<void>,
};

type RemoteDevelopmentEnvironmentAccessTokenResponse = {
  accessToken: string,
  expiresAtMillis: number,
  issuedAtMillis: number,
  userId: string,
};

function isHexclaveAppTokenInternals(value: unknown): value is HexclaveAppTokenInternals {
  return (
    value != null &&
    typeof value === "object" &&
    "signInWithTokens" in value &&
    typeof value.signInWithTokens === "function"
  );
}

function getHexclaveAppTokenInternals(appValue: ReturnType<typeof useStackApp>): HexclaveAppTokenInternals {
  if (appValue == null || typeof appValue !== "object") {
    throw new Error("The Stack app instance is unavailable.");
  }

  const internals = appValue[hexclaveAppInternalsSymbol];
  if (!isHexclaveAppTokenInternals(internals)) {
    throw new Error("The Stack client app cannot install remote development environment tokens.");
  }

  return internals;
}

function parseRemoteDevelopmentEnvironmentAccessTokenResponse(value: unknown): RemoteDevelopmentEnvironmentAccessTokenResponse {
  if (
    value == null ||
    typeof value !== "object" ||
    !("access_token" in value) ||
    typeof value.access_token !== "string" ||
    !("expires_at_millis" in value) ||
    typeof value.expires_at_millis !== "number" ||
    !("issued_at_millis" in value) ||
    typeof value.issued_at_millis !== "number" ||
    !("user_id" in value) ||
    typeof value.user_id !== "string"
  ) {
    throw new Error("Remote development environment auth endpoint returned an invalid response.");
  }

  return {
    accessToken: value.access_token,
    expiresAtMillis: value.expires_at_millis,
    issuedAtMillis: value.issued_at_millis,
    userId: value.user_id,
  };
}

function getRefreshInMillis(token: RemoteDevelopmentEnvironmentAccessTokenResponse): number {
  const now = Date.now();
  const refreshBeforeExpirationInMillis = token.expiresAtMillis - RDE_ACCESS_TOKEN_MIN_EXPIRATION_MS - now;
  const refreshBeforeMaxAgeInMillis = token.issuedAtMillis + RDE_ACCESS_TOKEN_MAX_AGE_MS - now;
  return Math.max(
    RDE_ACCESS_TOKEN_MIN_REFRESH_MS,
    Math.min(refreshBeforeExpirationInMillis, refreshBeforeMaxAgeInMillis),
  );
}

function shouldRefreshAccessToken(token: RemoteDevelopmentEnvironmentAccessTokenResponse | undefined): boolean {
  if (token === undefined) return true;
  const now = Date.now();
  return (
    token.expiresAtMillis - now < RDE_ACCESS_TOKEN_MIN_EXPIRATION_MS ||
    now - token.issuedAtMillis > RDE_ACCESS_TOKEN_MAX_AGE_MS
  );
}

async function getRemoteDevelopmentEnvironmentAccessToken(): Promise<RemoteDevelopmentEnvironmentAccessTokenResponse> {
  const response = await fetchWithRemoteDevelopmentEnvironmentBrowserSecret("/api/remote-development-environment/auth", {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to authenticate local remote development environment dashboard (${response.status}): ${await response.text()}`);
  }

  return parseRemoteDevelopmentEnvironmentAccessTokenResponse(await response.json());
}

async function installRemoteDevelopmentEnvironmentAccessToken(app: ReturnType<typeof useStackApp>): Promise<RemoteDevelopmentEnvironmentAccessTokenResponse> {
  const token = await getRemoteDevelopmentEnvironmentAccessToken();
  await getHexclaveAppTokenInternals(app).signInWithTokens({
    accessToken: token.accessToken,
    refreshToken: "",
  });
  return token;
}

function RemoteDevelopmentEnvironmentAuthGateInner(props: { children: React.ReactNode }) {
  const app = useStackApp();
  const [accessTokenInstalled, setAccessTokenInstalled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
    let refreshPromise: Promise<void> | undefined;
    let currentToken: RemoteDevelopmentEnvironmentAccessTokenResponse | undefined;

    const refreshAccessToken = async (): Promise<void> => {
      try {
        const token = await installRemoteDevelopmentEnvironmentAccessToken(app);
        const currentUser = await app.getUser({
          or: "anonymous-if-exists[deprecated]",
        });
        if (currentUser?.id !== token.userId) {
          throw new Error("Installed remote development environment token did not match the expected anonymous user.");
        }
        if (cancelled) return;
        currentToken = token;
        setAccessTokenInstalled(true);

        refreshTimeout = setTimeout(() => {
          refreshPromise = undefined;
          requestRefresh();
        }, getRefreshInMillis(token));
      } catch (e) {
        if (e instanceof RemoteDevelopmentEnvironmentBrowserSecretRedirectingError) {
          return;
        }
        throw e;
      }
    };

    const requestRefresh = (options?: { force?: boolean }) => {
      if (options?.force !== true && !shouldRefreshAccessToken(currentToken)) {
        return;
      }
      if (refreshTimeout !== undefined) {
        clearTimeout(refreshTimeout);
        refreshTimeout = undefined;
      }
      refreshPromise ??= refreshAccessToken().finally(() => {
        refreshPromise = undefined;
      });
      runAsynchronouslyWithAlert(refreshPromise);
    };

    const refreshOnWake = () => {
      if (document.visibilityState === "hidden") return;
      requestRefresh();
    };

    requestRefresh({ force: true });
    window.addEventListener("focus", refreshOnWake);
    document.addEventListener("visibilitychange", refreshOnWake);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", refreshOnWake);
      document.removeEventListener("visibilitychange", refreshOnWake);
      if (refreshTimeout !== undefined) {
        clearTimeout(refreshTimeout);
      }
    };
  }, [app]);

  if (!accessTokenInstalled) {
    return <Loading />;
  }

  return props.children;
}

export function RemoteDevelopmentEnvironmentAuthGate(props: { children: React.ReactNode, disabled?: boolean }) {
  const isRemoteDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";
  if (!isRemoteDevelopmentEnvironment || props.disabled === true) {
    return props.children;
  }

  return (
    <RemoteDevelopmentEnvironmentAuthGateInner>
      {props.children}
    </RemoteDevelopmentEnvironmentAuthGateInner>
  );
}
