'use client';

import { KnownErrors } from "@hexclave/shared";
import { hexclaveAppInternalsSymbol, useStackApp, useUser } from "@hexclave/next";
import { turnstileDevelopmentKeys } from "@hexclave/shared/dist/utils/turnstile";
import { publishableClientKeyNotNecessarySentinel } from "@hexclave/shared/dist/utils/oauth";
import { executeTurnstileInvisible, showTurnstileVisibleChallenge, BotChallengeUserCancelledError, withBotChallengeFlow } from "@hexclave/shared/dist/utils/turnstile-flow";
import { Button, Card, CardContent, CardFooter, CardHeader, Input, Label, PasswordInput, Typography } from "@hexclave/ui";
import Link from "next/link";
import { useEffect, useState } from "react";

function createSuggestedEmail() {
  const suffix = crypto.randomUUID().slice(0, 8);
  return `turnstile-demo+${suffix}@example.com`;
}

const testKeys = {
  invisiblePass: turnstileDevelopmentKeys.invisibleSiteKey,
  visiblePass: turnstileDevelopmentKeys.visibleSiteKey,
  forceChallenge: turnstileDevelopmentKeys.forcedChallengeSiteKey,
};

const authReturnStorageKey = "turnstile-auth-demo-last-redirect";
const handlerRoutes = {
  oauthCallback: "/handler/oauth-callback",
  magicLinkCallback: "/handler/magic-link-callback",
  error: "/handler/error",
};

type FlowResult = {
  status: "success" | "error" | "info",
  message: string,
};

type SignupResult =
  | { ok: true, accessToken: string, refreshToken: string }
  | { ok: false, code: string, message: string };

type MagicLinkSendResult =
  | { ok: true, nonce: string }
  | { ok: false, code: string, message: string };

type OAuthAuthorizeResult =
  | { ok: true, location: string }
  | { ok: false, code: string, message: string };

function readDebugInternals(app: ReturnType<typeof useStackApp>): {
  sendRequest: (path: string, init: RequestInit) => Promise<Response>,
  signInWithTokens: (tokens: { accessToken: string, refreshToken: string }) => Promise<void>,
} {
  const candidate = app[hexclaveAppInternalsSymbol];
  const sendRequest = candidate["sendRequest"];
  const signInWithTokens = candidate["signInWithTokens"];

  if (typeof sendRequest !== "function") {
    throw new Error("Expected demo app internals to expose sendRequest for Turnstile debug flows");
  }
  if (typeof signInWithTokens !== "function") {
    throw new Error("Expected demo app internals to expose signInWithTokens for Turnstile debug flows");
  }

  return {
    sendRequest: async (path, init) => await sendRequest(path, init),
    signInWithTokens: async (tokens) => await signInWithTokens(tokens),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  const field = value[key];
  return typeof field === "string" ? field : null;
}

async function readResponseJson(response: Response): Promise<unknown> {
  return await response.json();
}

function getDemoApiUrl(): string {
  const baseUrl = process.env.NEXT_PUBLIC_HEXCLAVE_API_URL
    || process.env.NEXT_PUBLIC_STACK_API_URL
    || process.env.NEXT_PUBLIC_HEXCLAVE_URL
    || process.env.NEXT_PUBLIC_STACK_URL;

  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error("Expected NEXT_PUBLIC_HEXCLAVE_API_URL to be configured for Turnstile OAuth debug flows");
  }

  return `${baseUrl.replace(/\/$/, "")}/api/v1`;
}

function getAppAbsoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

function getCurrentRelativeUrl(): string {
  const currentUrl = new URL(window.location.href);
  currentUrl.hash = "";
  return `${currentUrl.pathname}${currentUrl.search}`;
}

function toBase64Url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createPkcePair(): Promise<{ challenge: string }> {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return {
    challenge: toBase64Url(challengeBytes),
  };
}

async function createOAuthDebugState(): Promise<{ codeChallenge: string, state: string }> {
  const codeVerifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  const codeChallenge = toBase64Url(challengeBytes);
  const state = crypto.randomUUID();

  document.cookie = [
    `stack-oauth-outer-${encodeURIComponent(state)}=${encodeURIComponent(codeVerifier)}`,
    "Path=/",
    "Max-Age=3600",
    "SameSite=Lax",
  ].join("; ");

  return {
    codeChallenge,
    state,
  };
}

/**
 * Sends a signup request through the SDK's internal request pipeline.
 * Catches KnownErrors (which sendClientRequest throws) and returns structured results.
 */
async function debugSignup(
  sendRequest: (path: string, init: RequestInit) => Promise<Response>,
  options: {
    email: string,
    password: string,
    turnstileToken?: string,
    turnstilePhase?: "invisible" | "visible",
  },
): Promise<SignupResult> {
  const bodyObj: Record<string, string> = {
    email: options.email,
    password: options.password,
  };
  if (options.turnstileToken) {
    bodyObj.bot_challenge_token = options.turnstileToken;
  }
  if (options.turnstilePhase) {
    bodyObj.bot_challenge_phase = options.turnstilePhase;
  }

  try {
    const res = await sendRequest("/auth/password/sign-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
    });
    if (res.ok) {
      const resBody = await readResponseJson(res);
      const accessToken = readStringField(resBody, "access_token");
      const refreshToken = readStringField(resBody, "refresh_token");
      if (accessToken === null || refreshToken === null) throw new Error("Sign-up response did not include session tokens.");
      return { ok: true, accessToken, refreshToken };
    }
    const resBody = await readResponseJson(res);
    return { ok: false, code: readStringField(resBody, "code") ?? `HTTP_${res.status}`, message: readStringField(resBody, "message") ?? res.statusText };
  } catch (e: unknown) {
    // sendClientRequest throws KnownErrors instead of returning error responses
    if (e instanceof KnownErrors.BotChallengeRequired) {
      return { ok: false, code: "BOT_CHALLENGE_REQUIRED", message: e.message };
    }
    if (e instanceof KnownErrors.UserWithEmailAlreadyExists) {
      return { ok: false, code: "USER_EMAIL_ALREADY_EXISTS", message: e.message };
    }
    if (e instanceof KnownErrors.PasswordRequirementsNotMet) {
      return { ok: false, code: "PASSWORD_REQUIREMENTS_NOT_MET", message: e.message };
    }
    // Re-throw unknown errors
    throw e;
  }
}

function isChallengeRequired(result: SignupResult): boolean {
  return !result.ok && result.code === "BOT_CHALLENGE_REQUIRED";
}

async function debugMagicLinkSend(
  sendRequest: (path: string, init: RequestInit) => Promise<Response>,
  options: {
    email: string,
    callbackUrl: string,
    turnstileToken?: string,
    turnstilePhase?: "invisible" | "visible",
  },
): Promise<MagicLinkSendResult> {
  const bodyObj: Record<string, string> = {
    email: options.email,
    callback_url: options.callbackUrl,
  };
  if (options.turnstileToken) {
    bodyObj.bot_challenge_token = options.turnstileToken;
  }
  if (options.turnstilePhase) {
    bodyObj.bot_challenge_phase = options.turnstilePhase;
  }

  try {
    const res = await sendRequest("/auth/otp/send-sign-in-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
    });
    if (res.ok) {
      const resBody = await readResponseJson(res);
      return { ok: true, nonce: readStringField(resBody, "nonce") ?? "" };
    }
    const resBody = await readResponseJson(res);
    return { ok: false, code: readStringField(resBody, "code") ?? `HTTP_${res.status}`, message: readStringField(resBody, "message") ?? res.statusText };
  } catch (e: unknown) {
    if (e instanceof KnownErrors.BotChallengeRequired) {
      return { ok: false, code: "BOT_CHALLENGE_REQUIRED", message: e.message };
    }
    if (e instanceof KnownErrors.RedirectUrlNotWhitelisted) {
      return { ok: false, code: "REDIRECT_URL_NOT_WHITELISTED", message: e.message };
    }
    throw e;
  }
}

function isMagicLinkChallengeRequired(result: MagicLinkSendResult): boolean {
  return !result.ok && result.code === "BOT_CHALLENGE_REQUIRED";
}

async function debugOAuthAuthorize(
  options: {
    apiUrl: string,
    provider: "github" | "google",
    projectId: string,
    publishableClientKey: string,
    codeChallenge: string,
    state: string,
    redirectUrl: string,
    errorRedirectUrl: string,
    turnstileToken?: string,
    turnstilePhase?: "invisible" | "visible",
  },
): Promise<OAuthAuthorizeResult> {
  const params = new URLSearchParams({
    client_id: options.projectId,
    client_secret: options.publishableClientKey,
    redirect_uri: options.redirectUrl,
    scope: "legacy",
    state: options.state,
    grant_type: "authorization_code",
    code_challenge: options.codeChallenge,
    code_challenge_method: "S256",
    response_type: "code",
    type: "authenticate",
    error_redirect_url: options.errorRedirectUrl,
    stack_response_mode: "json",
  });

  if (options.turnstileToken) {
    params.set("bot_challenge_token", options.turnstileToken);
  }
  if (options.turnstilePhase) {
    params.set("bot_challenge_phase", options.turnstilePhase);
  }

  try {
    const res = await fetch(`${options.apiUrl}/auth/oauth/authorize/${options.provider}?${params.toString()}`, {
      method: "GET",
    });
    if (res.ok) {
      const resBody = await readResponseJson(res);
      const location = readStringField(resBody, "location");
      if (location === null) {
        return { ok: false, code: "MISSING_LOCATION", message: "OAuth authorize response did not include a redirect location." };
      }
      return { ok: true, location };
    }
    const resBody = await readResponseJson(res);
    return { ok: false, code: readStringField(resBody, "code") ?? `HTTP_${res.status}`, message: readStringField(resBody, "message") ?? res.statusText };
  } catch (e: unknown) {
    if (e instanceof KnownErrors.BotChallengeRequired) {
      return { ok: false, code: "BOT_CHALLENGE_REQUIRED", message: e.message };
    }
    throw e;
  }
}

function isOAuthChallengeRequired(result: OAuthAuthorizeResult): boolean {
  return !result.ok && result.code === "BOT_CHALLENGE_REQUIRED";
}

export default function TurnstileSignupPageClient() {
  const app = useStackApp();
  const user = useUser({ includeRestricted: true });
  const [email, setEmail] = useState(() => createSuggestedEmail());
  const [password, setPassword] = useState("Demo-password-123!");

  const [sdkActionResult, setSdkActionResult] = useState<FlowResult | null>(null);
  const [loadingSdkAction, setLoadingSdkAction] = useState<string | null>(null);
  const [returnMessage, setReturnMessage] = useState<string | null>(null);

  // Debug card state
  const [loadingFlow, setLoadingFlow] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<FlowResult | null>(null);

  const internals = readDebugInternals(app);
  const sendRequest = internals.sendRequest;
  const signInWithTokens = internals.signInWithTokens;
  const apiUrl = getDemoApiUrl();
  const oauthClientSecret = app[hexclaveAppInternalsSymbol].toClientJson().publishableClientKey
    || process.env.NEXT_PUBLIC_HEXCLAVE_PUBLISHABLE_CLIENT_KEY
    || process.env.NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY
    || process.env.HEXCLAVE_PUBLISHABLE_CLIENT_KEY
    || process.env.STACK_PUBLISHABLE_CLIENT_KEY
    || publishableClientKeyNotNecessarySentinel;

  useEffect(() => {
    const redirectSource = window.sessionStorage.getItem(authReturnStorageKey);
    if (redirectSource == null) {
      return;
    }

    window.sessionStorage.removeItem(authReturnStorageKey);
    setReturnMessage(`Returned from the ${redirectSource} flow. If the provider account was new, this also exercised OAuth sign-up with Turnstile enabled.`);
  }, []);

  function freshEmail() {
    const e = createSuggestedEmail();
    setEmail(e);
    return e;
  }

  function getOAuthCallbackUrlForTurnstileLab() {
    const callbackUrl = new URL(getAppAbsoluteUrl(handlerRoutes.oauthCallback));
    callbackUrl.searchParams.set("after_auth_return_to", getCurrentRelativeUrl());
    return callbackUrl.toString();
  }

  async function runSdkAction(id: string, fn: () => Promise<FlowResult>) {
    setLoadingSdkAction(id);
    setSdkActionResult(null);
    try {
      setSdkActionResult(await fn());
    } catch (e) {
      if (e instanceof BotChallengeUserCancelledError) {
        setSdkActionResult({ status: "error", message: "Turnstile challenge cancelled by user." });
      } else {
        setSdkActionResult({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setLoadingSdkAction(null);
    }
  }

  if (user != null) {
    return (
      <div className="container mx-auto p-6 max-w-4xl">
        <Card>
          <CardHeader>
            <Typography type="h2">Turnstile Auth Lab</Typography>
          </CardHeader>
          <CardContent className="space-y-3">
            <Typography>
              Signed in as <span className="font-mono">{user.primaryEmail ?? user.id}</span>.
            </Typography>
            {returnMessage && (
              <Typography className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900/60 dark:bg-green-950/40 dark:text-green-200">
                {returnMessage}
              </Typography>
            )}
            <Typography className="text-sm text-gray-600 dark:text-gray-300">
              Sign out to rerun password, magic-link, OAuth, and hosted flows from a clean state.
            </Typography>
          </CardContent>
          <CardFooter className="flex gap-3">
            <Button onClick={async () => await user.signOut({ redirectUrl: "/turnstile-signup" })}>
              Sign out and retry
            </Button>
            <Link href="/" className="inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium">
              Back to home
            </Link>
          </CardFooter>
        </Card>
      </div>
    );
  }

  // ── SDK signup ──
  async function handleSdkSignUp(): Promise<FlowResult> {
    const result = await app.signUpWithCredential({
      email,
      password,
      noRedirect: true,
      noVerificationCallback: true,
    });
    if (result.status === "error") {
      return { status: "error", message: result.error.message };
    }

    return { status: "success", message: "Password sign-up succeeded. Turnstile was handled transparently by the SDK." };
  }

  async function handleMagicLinkSend(): Promise<FlowResult> {
    const result = await app.sendMagicLinkEmail(email);
    if (result.status === "error") {
      return { status: "error", message: result.error.message };
    }

    return {
      status: "success",
      message: `Magic link / OTP send succeeded for ${email}. Complete it from Inbucket or your inbox to continue the user flow.`,
    };
  }

  async function handleOAuthStart(provider: "github" | "google"): Promise<FlowResult> {
    window.sessionStorage.setItem(authReturnStorageKey, `${provider} OAuth`);
    await app.signInWithOAuth(provider, { returnTo: getOAuthCallbackUrlForTurnstileLab() });
    return {
      status: "info",
      message: `Redirecting to ${provider} OAuth...`,
    };
  }

  async function handleMagicLinkVisibleDrill(): Promise<FlowResult> {
    const drillEmail = freshEmail();
    const callbackUrl = getAppAbsoluteUrl(handlerRoutes.magicLinkCallback);

    const firstRes = await debugMagicLinkSend(sendRequest, {
      email: drillEmail,
      callbackUrl,
      turnstileToken: "mock-turnstile-invalid",
      turnstilePhase: "invisible",
    });

    if (!isMagicLinkChallengeRequired(firstRes)) {
      return { status: "error", message: `Expected BOT_CHALLENGE_REQUIRED, got: ${firstRes.ok ? "ok" : firstRes.code}` };
    }

    const visibleToken = await showTurnstileVisibleChallenge(testKeys.forceChallenge, "send_magic_link_email");
    const secondRes = await debugMagicLinkSend(sendRequest, {
      email: drillEmail,
      callbackUrl,
      turnstileToken: visibleToken,
      turnstilePhase: "visible",
    });

    if (!secondRes.ok) {
      return { status: "error", message: `Visible retry failed: ${secondRes.code} — ${secondRes.message}` };
    }

    return {
      status: "success",
      message: `Magic link / OTP send succeeded after a forced visible challenge for ${drillEmail}. Complete the link or code from Inbucket to continue the new-user flow.`,
    };
  }

  async function handleOAuthVisibleDrill(provider: "github" | "google"): Promise<FlowResult> {
    const oauthDebugState = await createOAuthDebugState();

    const firstRes = await debugOAuthAuthorize({
      apiUrl,
      provider,
      projectId: app.projectId,
      publishableClientKey: oauthClientSecret,
      codeChallenge: oauthDebugState.codeChallenge,
      state: oauthDebugState.state,
      redirectUrl: getOAuthCallbackUrlForTurnstileLab(),
      errorRedirectUrl: getAppAbsoluteUrl(handlerRoutes.error),
      turnstileToken: "mock-turnstile-invalid",
      turnstilePhase: "invisible",
    });

    if (!isOAuthChallengeRequired(firstRes)) {
      return { status: "error", message: `Expected BOT_CHALLENGE_REQUIRED, got: ${firstRes.ok ? "ok" : firstRes.code}` };
    }

    const visibleToken = await showTurnstileVisibleChallenge(testKeys.forceChallenge, "oauth_authenticate");
    const secondRes = await debugOAuthAuthorize({
      apiUrl,
      provider,
      projectId: app.projectId,
      publishableClientKey: oauthClientSecret,
      codeChallenge: oauthDebugState.codeChallenge,
      state: oauthDebugState.state,
      redirectUrl: getOAuthCallbackUrlForTurnstileLab(),
      errorRedirectUrl: getAppAbsoluteUrl(handlerRoutes.error),
      turnstileToken: visibleToken,
      turnstilePhase: "visible",
    });

    if (!secondRes.ok) {
      return { status: "error", message: `Visible retry failed: ${secondRes.code} — ${secondRes.message}` };
    }

    window.sessionStorage.setItem(authReturnStorageKey, `${provider} OAuth visible challenge`);
    window.location.assign(secondRes.location);
    return {
      status: "info",
      message: `Redirecting to ${provider} OAuth after the forced visible challenge...`,
    };
  }

  // ── Debug flow runner ──
  async function runFlow(
    id: string,
    fn: (signupEmail: string) => Promise<FlowResult>,
  ) {
    setLoadingFlow(id);
    setLastResult(null);
    const signupEmail = freshEmail();
    try {
      const result = await fn(signupEmail);
      setLastResult(result);
    } catch (e) {
      if (e instanceof BotChallengeUserCancelledError) {
        setLastResult({ status: "error", message: "User cancelled the visible challenge — signup blocked." });
      } else {
        setLastResult({ status: "error", message: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      setLoadingFlow(null);
    }
  }

  // Flow: invisible token succeeds → signup
  async function flowInvisibleOk(signupEmail: string): Promise<FlowResult> {
    const token = await executeTurnstileInvisible(testKeys.invisiblePass, "sign_up_with_credential");
    const res = await debugSignup(sendRequest, {
      email: signupEmail, password,
      turnstileToken: token,
      turnstilePhase: "invisible",
    });
    if (res.ok) {
      await signInWithTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      return { status: "success", message: "Signup succeeded. Invisible token was accepted." };
    }
    return { status: "error", message: `Signup failed: ${res.code} — ${res.message}` };
  }

  // Flow: invisible fails → visible challenge → signup
  async function flowChallengeRequired(signupEmail: string): Promise<FlowResult> {
    const firstRes = await debugSignup(sendRequest, {
      email: signupEmail, password,
      turnstileToken: "mock-turnstile-invalid",
      turnstilePhase: "invisible",
    });

    if (firstRes.ok) {
      return { status: "success", message: "Signup unexpectedly succeeded on first attempt (no challenge required)." };
    }

    if (!isChallengeRequired(firstRes)) {
      return { status: "error", message: `Expected BOT_CHALLENGE_REQUIRED, got: ${firstRes.code}` };
    }

    const visibleToken = await showTurnstileVisibleChallenge(testKeys.forceChallenge, "sign_up_with_credential");

    const secondRes = await debugSignup(sendRequest, {
      email: signupEmail, password,
      turnstileToken: visibleToken,
      turnstilePhase: "visible",
    });

    if (secondRes.ok) {
      await signInWithTokens({ accessToken: secondRes.accessToken, refreshToken: secondRes.refreshToken });
      return { status: "success", message: "Signup succeeded after visible challenge." };
    }
    return { status: "error", message: `Retry failed: ${secondRes.code} — ${secondRes.message}` };
  }

  // Flow: both invisible and visible fail → blocked
  async function flowBothFail(signupEmail: string): Promise<FlowResult> {
    const firstRes = await debugSignup(sendRequest, {
      email: signupEmail, password,
      turnstileToken: "mock-turnstile-invalid",
      turnstilePhase: "invisible",
    });

    if (!isChallengeRequired(firstRes)) {
      return { status: "error", message: `Expected BOT_CHALLENGE_REQUIRED, got: ${firstRes.ok ? "ok" : firstRes.code}` };
    }

    const secondRes = await debugSignup(sendRequest, {
      email: signupEmail, password,
      turnstileToken: "mock-turnstile-invalid",
      turnstilePhase: "visible",
    });

    if (secondRes.ok) {
      return { status: "error", message: "Signup unexpectedly succeeded even with invalid visible token." };
    }
    return { status: "success", message: `Signup correctly blocked: ${secondRes.code}` };
  }

  // Flow: no token at all
  async function flowNoToken(signupEmail: string): Promise<FlowResult> {
    const res = await debugSignup(sendRequest, { email: signupEmail, password });
    if (res.ok) {
      await signInWithTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      return { status: "success", message: "Signup succeeded without any token. Backend accepted it." };
    }
    return { status: "error", message: `Signup failed: ${res.code} — ${res.message}` };
  }

  // Flow: withBotChallengeFlow orchestrator
  async function flowOrchestrator(signupEmail: string): Promise<FlowResult> {
    const result = await withBotChallengeFlow({
      invisibleSiteKey: testKeys.invisiblePass,
      visibleSiteKey: testKeys.forceChallenge,
      action: "sign_up_with_credential",
      execute: async (turnstile) => {
        return await debugSignup(sendRequest, {
          email: signupEmail, password,
          turnstileToken: turnstile.token,
          turnstilePhase: turnstile.phase,
        });
      },
      isChallengeRequired: (res) => {
        return !res.ok && res.code === "BOT_CHALLENGE_REQUIRED";
      },
    });

    if (result.ok) {
      await signInWithTokens({ accessToken: result.accessToken, refreshToken: result.refreshToken });
      return { status: "success", message: "Signup succeeded via withBotChallengeFlow orchestrator." };
    }
    return { status: "error", message: `Signup failed: ${result.code} — ${result.message}` };
  }

  // Flow: random outcome (simulates realistic behavior)
  async function flowRandom(signupEmail: string): Promise<FlowResult> {
    const rand = Math.random();
    if (rand < 0.4) {
      // 40%: invisible succeeds
      const token = await executeTurnstileInvisible(testKeys.invisiblePass, "sign_up_with_credential");
      const res = await debugSignup(sendRequest, {
        email: signupEmail, password,
        turnstileToken: token,
        turnstilePhase: "invisible",
      });
      if (res.ok) {
        await signInWithTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
        return { status: "success", message: "[Random: invisible pass] Signup succeeded." };
      }
      return { status: "error", message: `[Random: invisible pass] Failed: ${res.code}` };
    } else if (rand < 0.7) {
      // 30%: invisible fails → visible challenge → succeeds
      const firstRes = await debugSignup(sendRequest, {
        email: signupEmail, password,
        turnstileToken: "mock-turnstile-invalid",
        turnstilePhase: "invisible",
      });
      if (!isChallengeRequired(firstRes)) {
        return { status: "info", message: `[Random: challenge] Unexpected: ${firstRes.ok ? "ok" : firstRes.code}` };
      }
      const visibleToken = await showTurnstileVisibleChallenge(testKeys.forceChallenge, "sign_up_with_credential");
      const secondRes = await debugSignup(sendRequest, {
        email: signupEmail, password,
        turnstileToken: visibleToken,
        turnstilePhase: "visible",
      });
      if (secondRes.ok) {
        await signInWithTokens({ accessToken: secondRes.accessToken, refreshToken: secondRes.refreshToken });
        return { status: "success", message: "[Random: challenge -> pass] Signup succeeded after challenge." };
      }
      return { status: "error", message: `[Random: challenge -> pass] Retry failed: ${secondRes.code}` };
    } else if (rand < 0.9) {
      // 20%: both fail → blocked
      const firstRes = await debugSignup(sendRequest, {
        email: signupEmail, password,
        turnstileToken: "mock-turnstile-invalid",
        turnstilePhase: "invisible",
      });
      if (!isChallengeRequired(firstRes)) {
        return { status: "info", message: `[Random: both fail] Unexpected: ${firstRes.ok ? "ok" : firstRes.code}` };
      }
      const secondRes = await debugSignup(sendRequest, {
        email: signupEmail, password,
        turnstileToken: "mock-turnstile-invalid",
        turnstilePhase: "visible",
      });
      if (secondRes.ok) {
        return { status: "error", message: "[Random: both fail] Signup unexpectedly succeeded." };
      }
      return { status: "success", message: `[Random: both fail] Signup correctly blocked: ${secondRes.code}` };
    } else {
      // 10%: no token
      const res = await debugSignup(sendRequest, { email: signupEmail, password });
      if (res.ok) {
        await signInWithTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
        return { status: "success", message: "[Random: no token] Signup succeeded." };
      }
      return { status: "error", message: `[Random: no token] Failed: ${res.code}` };
    }
  }

  return (
    <div className="container mx-auto p-6 max-w-5xl space-y-8">
      {/* Header */}
      <div className="relative overflow-hidden rounded-3xl border border-slate-200/80 bg-[radial-gradient(circle_at_top_left,_rgba(14,165,233,0.18),_transparent_35%),linear-gradient(135deg,_rgba(255,255,255,0.96),_rgba(241,245,249,0.92))] p-8 shadow-sm dark:border-slate-800 dark:bg-[radial-gradient(circle_at_top_left,_rgba(34,211,238,0.16),_transparent_35%),linear-gradient(135deg,_rgba(15,23,42,0.96),_rgba(2,6,23,0.9))]">
        <div className="space-y-3">
          <Typography type="h1">Turnstile Auth Lab</Typography>
          <Typography className="max-w-3xl text-gray-600 dark:text-gray-300">
            Exercise password sign-up, magic links, OAuth sign-up, and hosted auth screens with Turnstile turned on. The upper grid uses real SDK entrypoints; the lower grid still exposes the raw password-debug scenarios.
          </Typography>
        </div>
      </div>

      {/* Shared credentials */}
      <Card>
        <CardHeader>
          <Typography type="h3">Shared credentials</Typography>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="demo-email">Email</Label>
              <Input
                id="demo-email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="demo-password">Password</Label>
              <PasswordInput
                id="demo-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                }}
              />
            </div>
          </div>
        </CardContent>
        <CardFooter>
          <Button variant="secondary" size="sm" onClick={() => { freshEmail(); }}>
            Generate new email
          </Button>
        </CardFooter>
      </Card>

      {/* SDK coverage */}
      <Card>
        <CardHeader>
          <Typography type="h3">SDK auth coverage</Typography>
          <Typography className="text-sm text-gray-500">
            These are the real consumer-facing auth entrypoints. Turnstile is handled by the SDK and hosted flows without any custom demo glue.
          </Typography>
        </CardHeader>
        <CardContent className="space-y-4">
          {sdkActionResult && (
            <Typography className={
              sdkActionResult.status === "error" ? "text-red-600 dark:text-red-400"
                : sdkActionResult.status === "success" ? "text-green-700 dark:text-green-300"
                  : "text-blue-600 dark:text-blue-300"
            }>
              {sdkActionResult.message}
            </Typography>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="border-dashed">
              <CardHeader>
                <Typography type="h4">Password sign-up</Typography>
              </CardHeader>
              <CardContent>
                <Typography className="text-sm text-gray-500">
                  Calls <span className="font-mono">app.signUpWithCredential()</span>. This is the cleanest example of transparent Turnstile handling for direct sign-up.
                </Typography>
              </CardContent>
              <CardFooter>
                <Button loading={loadingSdkAction === "sdk-signup"} onClick={async () => await runSdkAction("sdk-signup", handleSdkSignUp)}>
                  Sign up with SDK
                </Button>
              </CardFooter>
            </Card>

            <Card className="border-dashed">
              <CardHeader>
                <Typography type="h4">Magic link / OTP send</Typography>
              </CardHeader>
              <CardContent>
                <Typography className="text-sm text-gray-500">
                  Calls <span className="font-mono">app.sendMagicLinkEmail()</span>. For a brand-new email, completing the link covers the new-user flow backed by the OTP send endpoint.
                </Typography>
              </CardContent>
              <CardFooter>
                <Button
                  variant="secondary"
                  loading={loadingSdkAction === "magic-link"}
                  onClick={async () => await runSdkAction("magic-link", handleMagicLinkSend)}
                >
                  Send magic link
                </Button>
              </CardFooter>
            </Card>

            <Card className="border-dashed">
              <CardHeader>
                <Typography type="h4">OAuth sign-up / sign-in</Typography>
              </CardHeader>
              <CardContent>
                <Typography className="text-sm text-gray-500">
                  Starts <span className="font-mono">app.signInWithOAuth()</span>. If the provider account is new, the callback path creates the user and applies sign-up rules with stored Turnstile context.
                </Typography>
              </CardContent>
              <CardFooter className="flex gap-2">
                <Button
                  variant="secondary"
                  loading={loadingSdkAction === "oauth-github"}
                  onClick={async () => await runSdkAction("oauth-github", async () => await handleOAuthStart("github"))}
                >
                  GitHub OAuth
                </Button>
                <Button
                  variant="secondary"
                  loading={loadingSdkAction === "oauth-google"}
                  onClick={async () => await runSdkAction("oauth-google", async () => await handleOAuthStart("google"))}
                >
                  Google OAuth
                </Button>
              </CardFooter>
            </Card>

            <Card className="border-dashed">
              <CardHeader>
                <Typography type="h4">Hosted flows</Typography>
              </CardHeader>
              <CardContent>
                <Typography className="text-sm text-gray-500">
                  Opens the hosted Stack screens so you can verify Turnstile behavior in the out-of-the-box UI too.
                </Typography>
              </CardContent>
              <CardFooter className="flex gap-2">
                <Button variant="secondary" onClick={async () => await app.redirectToSignUp()}>
                  Hosted sign-up
                </Button>
                <Button variant="secondary" onClick={async () => await app.redirectToSignIn()}>
                  Hosted sign-in
                </Button>
              </CardFooter>
            </Card>

            <Card className="border-dashed">
              <CardHeader>
                <Typography type="h4">Forced visible: magic link / OTP</Typography>
              </CardHeader>
              <CardContent>
                <Typography className="text-sm text-gray-500">
                  Deterministically triggers <span className="font-mono">BOT_CHALLENGE_REQUIRED</span> on the send step, then opens the visible challenge before retrying.
                </Typography>
              </CardContent>
              <CardFooter>
                <Button
                  variant="secondary"
                  loading={loadingSdkAction === "magic-link-visible"}
                  onClick={async () => await runSdkAction("magic-link-visible", handleMagicLinkVisibleDrill)}
                >
                  Force visible challenge
                </Button>
              </CardFooter>
            </Card>

            <Card className="border-dashed">
              <CardHeader>
                <Typography type="h4">Forced visible: OAuth authorize</Typography>
              </CardHeader>
              <CardContent>
                <Typography className="text-sm text-gray-500">
                  Forces the visible Turnstile step during OAuth authorize, then redirects into the provider login once the challenge passes.
                </Typography>
              </CardContent>
              <CardFooter className="flex gap-2">
                <Button
                  variant="secondary"
                  loading={loadingSdkAction === "oauth-github-visible"}
                  onClick={async () => await runSdkAction("oauth-github-visible", async () => await handleOAuthVisibleDrill("github"))}
                >
                  GitHub visible
                </Button>
                <Button
                  variant="secondary"
                  loading={loadingSdkAction === "oauth-google-visible"}
                  onClick={async () => await runSdkAction("oauth-google-visible", async () => await handleOAuthVisibleDrill("google"))}
                >
                  Google visible
                </Button>
              </CardFooter>
            </Card>
          </div>
        </CardContent>
      </Card>

      {/* Debug flows */}
      <div className="space-y-4">
        <Typography type="h2">Password flow debugger</Typography>
        <Typography className="text-sm text-gray-600 dark:text-gray-300">
          Each card sends controlled Turnstile params to the backend via the SDK&apos;s internal request pipeline. A fresh email is generated per attempt so you can reproduce individual password sign-up states.
        </Typography>

        <div className="grid gap-4 md:grid-cols-2">
          {/* Invisible pass */}
          <Card>
            <CardHeader>
              <Typography type="h4">Invisible token succeeds</Typography>
            </CardHeader>
            <CardContent>
              <Typography className="text-sm text-gray-500">
                Acquires a valid invisible token (always-pass test key) and signs up.
              </Typography>
            </CardContent>
            <CardFooter>
              <Button
                size="sm"
                loading={loadingFlow === "invisible-ok"}
                onClick={() => runFlow("invisible-ok", flowInvisibleOk)}
              >
                Run
              </Button>
            </CardFooter>
          </Card>

          {/* Challenge required → visible → signup */}
          <Card>
            <CardHeader>
              <Typography type="h4">Invisible fails → visible challenge</Typography>
            </CardHeader>
            <CardContent>
              <Typography className="text-sm text-gray-500">
                Sends an invalid invisible token, then shows the visible challenge overlay. Solve it to complete signup.
              </Typography>
            </CardContent>
            <CardFooter>
              <Button
                size="sm"
                loading={loadingFlow === "challenge"}
                onClick={() => runFlow("challenge", flowChallengeRequired)}
              >
                Run
              </Button>
            </CardFooter>
          </Card>

          {/* Both fail → blocked */}
          <Card>
            <CardHeader>
              <Typography type="h4">Both fail → signup blocked</Typography>
            </CardHeader>
            <CardContent>
              <Typography className="text-sm text-gray-500">
                Invalid invisible token, then invalid visible token. Signup should be rejected.
              </Typography>
            </CardContent>
            <CardFooter>
              <Button
                size="sm"
                variant="destructive"
                loading={loadingFlow === "both-fail"}
                onClick={() => runFlow("both-fail", flowBothFail)}
              >
                Run
              </Button>
            </CardFooter>
          </Card>

          {/* No token */}
          <Card>
            <CardHeader>
              <Typography type="h4">No token (backwards compat)</Typography>
            </CardHeader>
            <CardContent>
              <Typography className="text-sm text-gray-500">
                Sends signup with no Turnstile token at all. Tests backwards compatibility.
              </Typography>
            </CardContent>
            <CardFooter>
              <Button
                size="sm"
                variant="secondary"
                loading={loadingFlow === "no-token"}
                onClick={() => runFlow("no-token", flowNoToken)}
              >
                Run
              </Button>
            </CardFooter>
          </Card>

          {/* withBotChallengeFlow orchestrator */}
          <Card>
            <CardHeader>
              <Typography type="h4">withBotChallengeFlow orchestrator</Typography>
            </CardHeader>
            <CardContent>
              <Typography className="text-sm text-gray-500">
                Uses <span className="font-mono">withBotChallengeFlow()</span> to automatically handle invisible → visible fallback.
              </Typography>
            </CardContent>
            <CardFooter>
              <Button
                size="sm"
                variant="secondary"
                loading={loadingFlow === "orchestrator"}
                onClick={() => runFlow("orchestrator", flowOrchestrator)}
              >
                Run
              </Button>
            </CardFooter>
          </Card>

          {/* Random */}
          <Card>
            <CardHeader>
              <Typography type="h4">Random scenario</Typography>
            </CardHeader>
            <CardContent>
              <Typography className="text-sm text-gray-500">
                Randomly picks a scenario (40% invisible pass, 30% challenge, 20% both fail, 10% no token) for realistic testing.
              </Typography>
            </CardContent>
            <CardFooter>
              <Button
                size="sm"
                variant="secondary"
                loading={loadingFlow === "random"}
                onClick={() => runFlow("random", flowRandom)}
              >
                Run
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>

      {/* Last result */}
      {lastResult && (
        <Card>
          <CardHeader>
            <Typography type="h4">Last result</Typography>
          </CardHeader>
          <CardContent>
            <Typography className={
              lastResult.status === "error" ? "text-red-600 dark:text-red-400"
                : lastResult.status === "success" ? "text-green-700 dark:text-green-300"
                  : "text-blue-600 dark:text-blue-300"
            }>
              {lastResult.message}
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Config info */}
      <Card>
        <CardHeader>
          <Typography type="h4">Config</Typography>
        </CardHeader>
        <CardContent className="space-y-1 text-sm font-mono">
          <Typography>Project: {app.projectId}</Typography>
          <Typography>Invisible key: {testKeys.invisiblePass}</Typography>
          <Typography>Visible key: {testKeys.visiblePass}</Typography>
          <Typography>Force challenge key: {testKeys.forceChallenge}</Typography>
        </CardContent>
        <CardFooter className="flex gap-3">
          <Link href="/" className="inline-flex items-center rounded-md border px-4 py-2 text-sm font-medium">
            Back to home
          </Link>
          <Button variant="secondary" onClick={async () => await app.redirectToSignUp()}>
            Open hosted sign-up
          </Button>
          <Button variant="secondary" onClick={async () => await app.redirectToSignIn()}>
            Open hosted sign-in
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
