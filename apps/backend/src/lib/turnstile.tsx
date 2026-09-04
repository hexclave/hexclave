import { KnownErrors } from "@hexclave/shared";
import { yupString } from "@hexclave/shared/dist/schema-fields";
import { getEnvBoolean, getEnvVariable, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { captureError, HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import {
  TurnstileAction,
  TurnstilePhase,
  TurnstileResult,
  turnstileDevelopmentKeys,
  turnstilePhaseValues,
} from "@hexclave/shared/dist/utils/turnstile";
import { BestEffortEndUserRequestContext, getBestEffortEndUserRequestContext } from "./end-users";
import { validateRedirectHostname } from "./redirect-urls";
import { Tenancy } from "./tenancies";


// ── Types ──────────────────────────────────────────────────────────────

export type SignUpTurnstileAssessment = {
  status: TurnstileResult,
  visibleChallengeResult?: TurnstileResult,
};

export type BotChallengeFlowRequest = {
  bot_challenge_token?: string,
  bot_challenge_phase?: TurnstilePhase,
  bot_challenge_unavailable?: "true",
};

export const botChallengeFlowRequestSchemaFields = {
  bot_challenge_token: yupString().optional(),
  bot_challenge_phase: yupString().oneOf(turnstilePhaseValues).optional(),
  bot_challenge_unavailable: yupString().oneOf(["true"]).optional(),
} as const;

type SiteverifyResponse = {
  success: boolean,
  action?: string,
  hostname?: string,
  "error-codes"?: string[],
};


// ── Configuration ──────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 10_000;

function isAllowedTurnstileHostname(hostname: string, tenancy: Tenancy): boolean {
  return validateRedirectHostname(hostname, tenancy);
}

function getSecretKey(override?: string): string {
  if (override) return override;
  const isDev = ["development", "test"].includes(getNodeEnvironment());
  return getEnvVariable("STACK_TURNSTILE_SECRET_KEY", isDev ? turnstileDevelopmentKeys.secretKey : "");
}

function getSiteverifyUrl(): string {
  return getEnvVariable("STACK_TURNSTILE_SITEVERIFY_URL", "https://challenges.cloudflare.com/turnstile/v0/siteverify");
}

const visibleChallengeSignupBypassActions = new Set<TurnstileAction>([
  "sign_up_with_credential",
  "send_magic_link_email",
  "oauth_authenticate",
]);

export function isBotChallengeDisabled(): boolean {
  return getEnvBoolean("STACK_DISABLE_BOT_CHALLENGE");
}

export function getDisabledBotChallengeAssessment(): SignUpTurnstileAssessment {
  return { status: "ok" };
}

function shouldAllowInvalidVisibleChallengeBypass(expectedAction: TurnstileAction): boolean {
  return getEnvBoolean("STACK_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE")
    && visibleChallengeSignupBypassActions.has(expectedAction);
}


// ── Siteverify ─────────────────────────────────────────────────────────

function isSiteverifyResponse(value: unknown): value is SiteverifyResponse {
  return value != null && typeof value === "object" && !Array.isArray(value)
    && "success" in value && typeof value.success === "boolean";
}

async function fetchSiteverify(token: string, remoteIp: string | null, secretKey: string): Promise<SiteverifyResponse> {
  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp != null) {
    body.set("remoteip", remoteIp);
  }

  // No retry — a failed verification triggers a visible challenge on the client,
  // which is preferable to silently accepting a potentially-replayed token.
  const response = await fetch(getSiteverifyUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new HexclaveAssertionError("Turnstile siteverify request failed", {
      status: response.status,
      statusText: response.statusText,
    });
  }

  const json = await response.json();
  if (!isSiteverifyResponse(json)) {
    throw new HexclaveAssertionError("Turnstile siteverify response missing required fields", { json });
  }

  return json;
}


// ── Token verification ─────────────────────────────────────────────────

export async function verifyTurnstileToken(params: {
  token: string | undefined,
  remoteIp: string | null,
  expectedAction: TurnstileAction,
  isAllowedHostname?: (hostname: string) => boolean,
  secretKey?: string,
  captureRejectedAsError?: boolean,
}): Promise<SignUpTurnstileAssessment> {
  const token = params.token?.trim() ?? "";
  if (!token) {
    return { status: "invalid" };
  }

  const result = await Result.fromThrowingAsync(
    () => fetchSiteverify(token, params.remoteIp, getSecretKey(params.secretKey)),
  );

  if (result.status === "error") {
    captureError("turnstile-siteverify-error", new HexclaveAssertionError("Turnstile siteverify request failed", {
      cause: result.error,
      expectedAction: params.expectedAction,
    }));
    return { status: "error" };
  }

  const data = result.data;

  if (!data.success) {
    if (params.captureRejectedAsError ?? true) {
      captureError("turnstile-siteverify-rejected", new HexclaveAssertionError("Turnstile siteverify returned success=false", {
        errorCodes: data["error-codes"],
        expectedAction: params.expectedAction,
        receivedAction: data.action,
        hostname: data.hostname,
      }));
    }
    return { status: "invalid" };
  }

  if (data.hostname != null && params.isAllowedHostname != null && !params.isAllowedHostname(data.hostname)) {
    captureError("turnstile-hostname-mismatch", new HexclaveAssertionError("Turnstile hostname does not match any allowed domain", {
      receivedHostname: data.hostname,
    }));
    return { status: "invalid" };
  }

  if (data.action != null && data.action !== params.expectedAction) {
    return { status: "invalid" };
  }

  return { status: "ok" };
}

export async function verifyTurnstileTokenWithOptionalVisibleChallenge(params: {
  token: string | undefined,
  remoteIp: string | null,
  expectedAction: TurnstileAction,
  isAllowedHostname?: (hostname: string) => boolean,
  phase?: "invisible" | "visible",
  challengeUnavailable?: boolean,
  secretKey?: string,
}): Promise<SignUpTurnstileAssessment> {
  if (isBotChallengeDisabled()) {
    return getDisabledBotChallengeAssessment();
  }

  const phase = params.phase;
  if (params.challengeUnavailable) {
    if (params.token != null || phase != null) {
      throw new HexclaveAssertionError("challengeUnavailable cannot be combined with a bot challenge token or phase");
    }
    return { status: "error", visibleChallengeResult: "error" };
  }

  const assessment = await verifyTurnstileToken({
    ...params,
    // Invisible rejection is often the normal escalation path into a visible challenge,
    // so only capture rejections as errors once we're outside that first phase.
    captureRejectedAsError: phase !== "invisible",
  });

  if (phase == null) {
    // Legacy clients do not participate in the multi-phase challenge flow, so they
    // still receive the raw assessment directly.
    return assessment;
  }

  if (phase === "invisible") {
    if (assessment.status !== "ok") {
      throw new KnownErrors.BotChallengeRequired();
    }
    return assessment;
  }

  if (assessment.status !== "ok") {
    if (shouldAllowInvalidVisibleChallengeBypass(params.expectedAction)) {
      return { status: "invalid", visibleChallengeResult: "invalid" };
    }
    throw new KnownErrors.BotChallengeFailed("Visible bot challenge verification failed");
  }

  // Visible passed but invisible failed — always record "invalid" rather than
  // trusting a client-supplied value (a malicious client could claim "error"
  // to avoid the risk-score penalty that "invalid" carries).
  return { status: "invalid", visibleChallengeResult: "ok" };
}


// ── Convenience ────────────────────────────────────────────────────────

export async function getRequestContextAndBotChallengeAssessment(
  botChallenge: BotChallengeFlowRequest,
  expectedAction: TurnstileAction,
  tenancy: Tenancy,
): Promise<{
  requestContext: BestEffortEndUserRequestContext,
  turnstileAssessment: SignUpTurnstileAssessment,
}> {
  const requestContext = await getBestEffortEndUserRequestContext();
  const turnstileAssessment = await verifyTurnstileTokenWithOptionalVisibleChallenge({
    token: botChallenge.bot_challenge_token,
    remoteIp: requestContext.ipAddress,
    expectedAction,
    isAllowedHostname: (hostname) => isAllowedTurnstileHostname(hostname, tenancy),
    phase: botChallenge.bot_challenge_phase,
    challengeUnavailable: botChallenge.bot_challenge_unavailable === "true",
  });
  return { requestContext, turnstileAssessment };
}


// ── Tests ──────────────────────────────────────────────────────────────

import.meta.vitest?.describe("verifyTurnstileToken(...)", () => {
  const { vi, test, afterEach } = import.meta.vitest!;

  const stubFetch = (response: Partial<SiteverifyResponse>, status = 200) => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response), {
      status,
      headers: { "Content-Type": "application/json" },
    }));
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const baseParams = {
    remoteIp: null as string | null,
    expectedAction: "sign_up_with_credential" as const,
    secretKey: "secret-key",
  };

  test("returns invalid for empty or omitted token", async ({ expect }) => {
    await expect(verifyTurnstileToken({ ...baseParams, token: "" })).resolves.toEqual({ status: "invalid" });
    await expect(verifyTurnstileToken({ ...baseParams, token: undefined })).resolves.toEqual({ status: "invalid" });
  });

  test("maps siteverify success, rejection, and action mismatch", async ({ expect }) => {
    const cases = [
      { response: { success: true, action: "sign_up_with_credential" }, expected: "ok" },
      { response: { success: false, action: "sign_up_with_credential" }, expected: "invalid" },
      { response: { success: true, action: "oauth_authenticate" }, expected: "invalid" },
    ] as const;

    for (const { response, expected } of cases) {
      stubFetch(response);
      await expect(verifyTurnstileToken({ ...baseParams, token: "real-token", remoteIp: "127.0.0.1" }))
        .resolves.toEqual({ status: expected });
    }
  });

  test("returns error when siteverify network fails", async ({ expect }) => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    await expect(verifyTurnstileToken({ ...baseParams, token: "real-token", remoteIp: "127.0.0.1" }))
      .resolves.toEqual({ status: "error" });
  });

  test("can suppress captureError for expected siteverify rejections", async ({ expect }) => {
    const errorsModule = await import("@hexclave/shared/dist/utils/errors");
    const captureErrorSpy = vi.spyOn(errorsModule, "captureError").mockImplementation(() => {});
    stubFetch({ success: false, action: "sign_up_with_credential" });

    await expect(verifyTurnstileToken({
      ...baseParams,
      token: "real-token",
      remoteIp: "127.0.0.1",
      captureRejectedAsError: false,
    })).resolves.toEqual({ status: "invalid" });

    expect(captureErrorSpy).not.toHaveBeenCalled();
  });

  const allowMyapp = (h: string) => h === "myapp.com" || h.endsWith(".myapp.com");

  test("returns invalid when hostname does not match allowed hostnames", async ({ expect }) => {
    stubFetch({ success: true, action: "sign_up_with_credential", hostname: "evil.example.com" });
    await expect(verifyTurnstileToken({
      ...baseParams, token: "real-token", remoteIp: "127.0.0.1",
      isAllowedHostname: allowMyapp,
    })).resolves.toEqual({ status: "invalid" });
  });

  test("returns ok when hostname matches an allowed hostname", async ({ expect }) => {
    stubFetch({ success: true, action: "sign_up_with_credential", hostname: "app.myapp.com" });
    await expect(verifyTurnstileToken({
      ...baseParams, token: "real-token", remoteIp: "127.0.0.1",
      isAllowedHostname: allowMyapp,
    })).resolves.toEqual({ status: "ok" });
  });

  test("returns ok when isAllowedHostname accepts the value", async ({ expect }) => {
    stubFetch({ success: true, action: "sign_up_with_credential", hostname: "localhost" });
    await expect(verifyTurnstileToken({
      ...baseParams, token: "real-token", remoteIp: "127.0.0.1",
      isAllowedHostname: () => true,
    })).resolves.toEqual({ status: "ok" });
  });

  test("skips hostname validation when response omits hostname", async ({ expect }) => {
    stubFetch({ success: true, action: "sign_up_with_credential" });
    await expect(verifyTurnstileToken({
      ...baseParams, token: "real-token", remoteIp: "127.0.0.1",
      isAllowedHostname: () => false,
    })).resolves.toEqual({ status: "ok" });
  });

  test("skips hostname validation when no isAllowedHostname provided", async ({ expect }) => {
    stubFetch({ success: true, action: "sign_up_with_credential", hostname: "anything.com" });
    await expect(verifyTurnstileToken({
      ...baseParams, token: "real-token", remoteIp: "127.0.0.1",
    })).resolves.toEqual({ status: "ok" });
  });

  test("uses development secret key when none is configured", async ({ expect }) => {
    const processEnv = process["env"];
    const originalNodeEnv = processEnv["NODE_ENV"];
    const originalHexclaveKey = processEnv["HEXCLAVE_TURNSTILE_SECRET_KEY"];
    const originalStackKey = processEnv["STACK_TURNSTILE_SECRET_KEY"];
    Reflect.set(processEnv, "NODE_ENV", "development");
    // Clear both spellings so the value resolves to the dev-key default; the
    // canonical HEXCLAVE_ name is set in .env.development and otherwise wins.
    Reflect.set(processEnv, "HEXCLAVE_TURNSTILE_SECRET_KEY", "");
    Reflect.set(processEnv, "STACK_TURNSTILE_SECRET_KEY", "");

    let postedSecret = "";
    try {
      vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body;
        if (!(body instanceof URLSearchParams)) throw new Error("Expected URLSearchParams body");
        postedSecret = body.get("secret") ?? "";
        return new Response(JSON.stringify({ success: true, action: "sign_up_with_credential" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

      await expect(verifyTurnstileToken({ ...baseParams, token: "real-token", remoteIp: "127.0.0.1", secretKey: undefined }))
        .resolves.toEqual({ status: "ok" });
    } finally {
      Reflect.set(processEnv, "NODE_ENV", originalNodeEnv);
      for (const [key, original] of [
        ["HEXCLAVE_TURNSTILE_SECRET_KEY", originalHexclaveKey],
        ["STACK_TURNSTILE_SECRET_KEY", originalStackKey],
      ] as const) {
        if (original === undefined) {
          Reflect.deleteProperty(processEnv, key);
        } else {
          Reflect.set(processEnv, key, original);
        }
      }
    }

    expect(postedSecret).toBe(turnstileDevelopmentKeys.secretKey);
  });
});

import.meta.vitest?.describe("verifyTurnstileTokenWithOptionalVisibleChallenge(...)", () => {
  const { vi, test, afterEach, beforeEach } = import.meta.vitest!;
  const processEnv = process["env"];
  const originalFlag = processEnv["HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE"];
  const originalDisableFlag = processEnv["HEXCLAVE_DISABLE_BOT_CHALLENGE"];

  beforeEach(() => {
    Reflect.deleteProperty(processEnv, "HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE");
    Reflect.deleteProperty(processEnv, "HEXCLAVE_DISABLE_BOT_CHALLENGE");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalFlag === undefined) {
      Reflect.deleteProperty(processEnv, "HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE");
    } else {
      Reflect.set(processEnv, "HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE", originalFlag);
    }
    if (originalDisableFlag === undefined) {
      Reflect.deleteProperty(processEnv, "HEXCLAVE_DISABLE_BOT_CHALLENGE");
    } else {
      Reflect.set(processEnv, "HEXCLAVE_DISABLE_BOT_CHALLENGE", originalDisableFlag);
    }
  });

  const baseParams = {
    remoteIp: null as string | null,
    expectedAction: "send_magic_link_email" as const,
    secretKey: "secret-key",
  };

  test("preserves legacy behavior when no phase is provided", async ({ expect }) => {
    await expect(verifyTurnstileTokenWithOptionalVisibleChallenge({ ...baseParams, token: undefined }))
      .resolves.toEqual({ status: "invalid" });
  });

  test("throws challenge-required for invisible failures", async ({ expect }) => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ success: false }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await expect(verifyTurnstileTokenWithOptionalVisibleChallenge({ ...baseParams, token: "bad", phase: "invisible" }))
      .rejects.toThrowError("An additional bot challenge is required before sign-up can continue.");
  });

  test("returns recovered assessment after successful visible retry", async ({ expect }) => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ success: true, action: "send_magic_link_email" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await expect(verifyTurnstileTokenWithOptionalVisibleChallenge({ ...baseParams, token: "visible-token", phase: "visible" }))
      .resolves.toEqual({ status: "invalid", visibleChallengeResult: "ok" });
  });

  test("returns a distinct visible-failure assessment when the challenge was unavailable", async ({ expect }) => {
    await expect(verifyTurnstileTokenWithOptionalVisibleChallenge({
      ...baseParams,
      token: undefined,
      challengeUnavailable: true,
    })).resolves.toEqual({ status: "error", visibleChallengeResult: "error" });
  });

  test("skips all bot challenge verification when disabled", async ({ expect }) => {
    Reflect.set(processEnv, "HEXCLAVE_DISABLE_BOT_CHALLENGE", "true");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(verifyTurnstileTokenWithOptionalVisibleChallenge({
      ...baseParams,
      token: undefined,
      phase: "invisible",
      challengeUnavailable: true,
    })).resolves.toEqual({ status: "ok" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("can downgrade visible invalid responses into a scored assessment when bypass is enabled", async ({ expect }) => {
    Reflect.set(processEnv, "HEXCLAVE_ALLOW_SIGN_UP_ON_VISIBLE_BOT_CHALLENGE_FAILURE", "true");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ success: false }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    await expect(verifyTurnstileTokenWithOptionalVisibleChallenge({
      ...baseParams,
      token: "visible-token",
      phase: "visible",
    })).resolves.toEqual({ status: "invalid", visibleChallengeResult: "invalid" });
  });

  test("rejects contradictory unavailable and token inputs", async ({ expect }) => {
    await expect(verifyTurnstileTokenWithOptionalVisibleChallenge({
      ...baseParams,
      token: "visible-token",
      phase: "visible",
      challengeUnavailable: true,
    })).rejects.toThrowError("challengeUnavailable cannot be combined with a bot challenge token or phase");
  });
});
