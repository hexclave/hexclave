'use client';

import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";
import { Typography } from "@hexclave/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCard } from "../components/message-cards/message-card";
import { useTranslation } from "../lib/translations";
import { hexclaveAppInternalsSymbol } from "../lib/hexclave-app/common";
import type { StackClientApp } from "../lib/hexclave-app/apps/interfaces/client-app";
import { useStackApp } from "../lib/hooks";

async function postCliAuthComplete(app: StackClientApp, body: Record<string, unknown>) {
  return await app[hexclaveAppInternalsSymbol].sendRequest("/auth/cli/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function ensureCliCompleteOk(result: Response) {
  if (!result.ok) {
    throw new Error(`Authorization failed: ${result.status} ${await result.text()}`);
  }
}

async function completeCliAuthWithRefreshToken(app: StackClientApp, loginCode: string, refreshToken: string) {
  const result = await postCliAuthComplete(app, { login_code: loginCode, refresh_token: refreshToken });
  await ensureCliCompleteOk(result);
}

// Hexclave rebrand: sessionStorage key — straight rename (per-tab, low TTL).
const CLI_AUTH_CONFIRMED_KEY = "hexclave-cli-auth-confirmed";

function markConfirmed(loginCode: string) {
  sessionStorage.setItem(CLI_AUTH_CONFIRMED_KEY, loginCode);
}

function isConfirmed(loginCode: string): boolean {
  return sessionStorage.getItem(CLI_AUTH_CONFIRMED_KEY) === loginCode;
}

function clearConfirmed() {
  sessionStorage.removeItem(CLI_AUTH_CONFIRMED_KEY);
}

function getError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function parseObjectField(data: unknown, fieldName: string): Json | undefined {
  if (!isJsonSerializable(data) || data === null || Array.isArray(data)) return undefined;
  return fieldName in data
    ? data[fieldName]
    : undefined;
}

function parseStringField(data: unknown, fieldName: string): string | undefined {
  const value = parseObjectField(data, fieldName);
  return typeof value === "string" ? value : undefined;
}

export type CliAuthConfirmationStatus =
  | "idle"
  | "invalid"
  | "authorizing"
  | "redirecting"
  | "success"
  | "error";

export type CliAuthConfirmationState = {
  status: CliAuthConfirmationStatus,
  loginCode: string | null,
  error: Error | null,
  isLoading: boolean,
  authorize: () => Promise<void>,
  retry: () => void,
};

export function useCliAuthConfirmation(): CliAuthConfirmationState {
  const app = useStackApp();
  const user = app.useUser({ includeRestricted: true });
  const [status, setStatus] = useState<Exclude<CliAuthConfirmationStatus, "invalid">>("idle");
  const [error, setError] = useState<Error | null>(null);
  const autoCompleteRef = useRef(false);
  const authorizeInProgressRef = useRef(false);
  const [loginCode] = useState(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get("login_code");
  });
  const [confirmed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return loginCode != null && isConfirmed(loginCode);
  });

  const completeWithCurrentUser = useCallback(async () => {
    if (!loginCode) {
      throw new Error("Missing login code in URL parameters");
    }
    if (!user) {
      throw new Error("Cannot complete CLI authorization without a signed-in user");
    }
    const refreshToken = (await user.currentSession.getTokens()).refreshToken;
    if (!refreshToken) {
      throw new Error("Could not retrieve session token");
    }
    await completeCliAuthWithRefreshToken(app, loginCode, refreshToken);
  }, [app, loginCode, user]);

  useEffect(() => {
    if (!confirmed || !user || user.isRestricted || autoCompleteRef.current) {
      return;
    }
    autoCompleteRef.current = true;
    runAsynchronouslyWithAlert(async () => {
      setStatus("authorizing");
      try {
        await completeWithCurrentUser();
        clearConfirmed();
        setStatus("success");
      } catch (err) {
        setError(getError(err));
        setStatus("error");
      }
    });
  }, [confirmed, user, completeWithCurrentUser]);

  const authorize = useCallback(async () => {
    if (authorizeInProgressRef.current) {
      return;
    }
    authorizeInProgressRef.current = true;

    try {
      if (!loginCode) {
        setError(new Error("Missing login code in URL parameters"));
        setStatus("error");
        return;
      }

      setError(null);
      setStatus("authorizing");
      if (user) {
        if (user.isRestricted) {
          markConfirmed(loginCode);
          setStatus("redirecting");
          await (
            user.isAnonymous
              ? app.redirectToSignUp({ replace: true })
              : app.redirectToOnboarding({ replace: true })
          );
          return;
        }
        await completeWithCurrentUser();
        clearConfirmed();
        setStatus("success");
        return;
      }

      const checkResult = await postCliAuthComplete(app, { login_code: loginCode, mode: "check" });
      if (!checkResult.ok) {
        throw new Error(`Failed to verify login code: ${checkResult.status} ${await checkResult.text()}`);
      }
      const checkData: unknown = await checkResult.json();
      const cliSessionState = parseStringField(checkData, "cli_session_state") ?? null;

      if (cliSessionState === "anonymous") {
        const claimResult = await postCliAuthComplete(app, { login_code: loginCode, mode: "claim-anon-session" });

        if (!claimResult.ok) {
          throw new Error(`Failed to claim anonymous session: ${claimResult.status} ${await claimResult.text()}`);
        }

        const tokens: unknown = await claimResult.json();
        const accessToken = parseStringField(tokens, "access_token");
        const refreshToken = parseStringField(tokens, "refresh_token");
        if (!accessToken || !refreshToken) {
          throw new Error("Anonymous CLI session claim did not return tokens");
        }
        await app[hexclaveAppInternalsSymbol].signInWithTokens({
          accessToken,
          refreshToken,
        });
        markConfirmed(loginCode);
        setStatus("redirecting");
        await app.redirectToSignUp({ replace: true });
        return;
      }

      markConfirmed(loginCode);
      setStatus("redirecting");
      await app.redirectToSignIn({ replace: true });
    } catch (err) {
      setError(getError(err));
      setStatus("error");
    } finally {
      authorizeInProgressRef.current = false;
    }
  }, [app, completeWithCurrentUser, loginCode, user]);

  const retry = useCallback(() => {
    setError(null);
    autoCompleteRef.current = false;
    setStatus("idle");
  }, []);

  const visibleStatus = loginCode == null ? "invalid" : status;
  return {
    status: visibleStatus,
    loginCode,
    error,
    isLoading: visibleStatus === "authorizing" || visibleStatus === "redirecting",
    authorize,
    retry,
  };
}

export function CliAuthConfirmation({ fullPage = true }: { fullPage?: boolean }) {
  const { t } = useTranslation();
  const cliAuth = useCliAuthConfirmation();

  if (cliAuth.status === "success") {
    return (
      <MessageCard title={t("CLI Authorization Successful")} fullPage={fullPage}>
        <Typography>
          {t("The CLI application has been authorized successfully. You can close this window and return to the command line.")}
        </Typography>
      </MessageCard>
    );
  }

  if (cliAuth.status === "error") {
    return (
      <MessageCard
        title={t("Authorization Failed")}
        fullPage={fullPage}
        primaryButtonText={t("Try Again")}
        primaryAction={cliAuth.retry}
      >
        <Typography className="text-red-600">
          {t("Failed to authorize the CLI application:")}
        </Typography>
        <Typography className="text-red-600">
          {cliAuth.error?.message}
        </Typography>
      </MessageCard>
    );
  }

  if (cliAuth.status === "invalid") {
    return (
      <MessageCard title={t("Invalid CLI Authorization Link")} fullPage={fullPage}>
        <Typography className="text-red-600">
          {t("This CLI authorization link is missing a login code. Please return to the command line and start the login process again.")}
        </Typography>
      </MessageCard>
    );
  }

  if (cliAuth.status === "authorizing" || cliAuth.status === "redirecting") {
    return (
      <MessageCard title={t("Completing Authorization...")} fullPage={fullPage}>
        <Typography>
          {t("Finishing up the CLI authorization...")}
        </Typography>
      </MessageCard>
    );
  }

  return (
    <MessageCard
      title={t("Authorize CLI Application")}
      fullPage={fullPage}
      primaryButtonText={cliAuth.isLoading ? t("Authorizing...") : t("Authorize")}
      primaryAction={cliAuth.authorize}
    >
      <Typography>
        {t("A command line application is requesting access to your account. Click the button below to authorize it.")}
      </Typography>
      <Typography variant="destructive">
        {t("WARNING: Make sure you trust the command line application, as it will gain access to your account. If you did not initiate this request, you can close this page and ignore it. We will never send you this link via email or any other means.")}
      </Typography>
    </MessageCard>
  );
}
