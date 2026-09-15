'use client';

import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { Typography } from "@hexclave/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCard } from "../components/message-cards/message-card";
import { getStringField, postConfirmationRequest, redirectRestrictedUserToCompleteSignIn, useConfirmationFlow, useUrlQueryParam } from "../lib/device-auth-confirmation";
import { hexclaveAppInternalsSymbol } from "../lib/hexclave-app/common";
import type { StackClientApp } from "../lib/hexclave-app/apps/interfaces/client-app";
import { useStackApp } from "../lib/hooks";
import { useTranslation } from "../lib/translations";

async function postCliAuthComplete(app: StackClientApp, body: Record<string, unknown>) {
  return await postConfirmationRequest(app, { endpoint: "/auth/cli/complete", body });
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
  const flow = useConfirmationFlow<Exclude<CliAuthConfirmationStatus, "invalid" | "error">>("idle");
  const autoCompleteRef = useRef(false);
  const loginCode = useUrlQueryParam("login_code");
  const [confirmed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return loginCode != null && isConfirmed(loginCode);
  });

  const completeWithCurrentUser = useCallback(async () => {
    if (loginCode == null) {
      throw new Error("Missing login code in URL parameters");
    }
    if (user == null) {
      throw new Error("Cannot complete CLI authorization without a signed-in user");
    }
    const refreshToken = (await user.currentSession.getTokens()).refreshToken;
    if (refreshToken == null) {
      throw new Error("Could not retrieve session token");
    }
    flow.setStatus("authorizing");
    await postCliAuthComplete(app, { login_code: loginCode, refresh_token: refreshToken });
    clearConfirmed();
    flow.setStatus("success");
  }, [app, flow, loginCode, user]);

  // Coming back from sign-in/sign-up: the user clicked Authorize before, so
  // finish without asking again.
  useEffect(() => {
    if (!confirmed || user == null || user.isRestricted || autoCompleteRef.current) {
      return;
    }
    autoCompleteRef.current = true;
    runAsynchronouslyWithAlert(flow.run(completeWithCurrentUser));
  }, [confirmed, user, completeWithCurrentUser, flow]);

  const authorize = useCallback(async () => await flow.run(async () => {
    if (loginCode == null) {
      throw new Error("Missing login code in URL parameters");
    }
    if (user != null) {
      if (user.isRestricted) {
        markConfirmed(loginCode);
        flow.setStatus("redirecting");
        await redirectRestrictedUserToCompleteSignIn(app, user);
        return;
      }
      await completeWithCurrentUser();
      return;
    }

    // Nobody is signed in. If the CLI already has an anonymous session, adopt
    // it in this browser so sign-up upgrades that user instead of creating a new one.
    flow.setStatus("authorizing");
    const checkData = await postCliAuthComplete(app, { login_code: loginCode, mode: "check" });
    if (getStringField(checkData, "cli_session_state") === "anonymous") {
      const tokens = await postCliAuthComplete(app, { login_code: loginCode, mode: "claim-anon-session" });
      const accessToken = getStringField(tokens, "access_token");
      const refreshToken = getStringField(tokens, "refresh_token");
      if (accessToken == null || refreshToken == null) {
        throw new Error("Anonymous CLI session claim did not return tokens");
      }
      await app[hexclaveAppInternalsSymbol].signInWithTokens({ accessToken, refreshToken });
      markConfirmed(loginCode);
      flow.setStatus("redirecting");
      await app.redirectToSignUp({ replace: true });
      return;
    }

    markConfirmed(loginCode);
    flow.setStatus("redirecting");
    await app.redirectToSignIn({ replace: true });
  }), [app, completeWithCurrentUser, flow, loginCode, user]);

  const retry = useCallback(() => {
    autoCompleteRef.current = false;
    flow.reset("idle");
  }, [flow]);

  const visibleStatus = loginCode == null ? "invalid" : flow.status;
  return {
    status: visibleStatus,
    loginCode,
    error: flow.error,
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
