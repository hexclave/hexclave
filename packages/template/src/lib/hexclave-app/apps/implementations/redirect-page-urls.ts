import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { getRelativePart } from "@hexclave/shared/dist/utils/urls";
import { HandlerUrls } from "../../common";

export const crossDomainAuthQueryParams = {
  marker: "hexclave_cross_domain_auth",
  state: "hexclave_cross_domain_state",
  codeChallenge: "hexclave_cross_domain_code_challenge",
  afterCallbackRedirectUrl: "hexclave_cross_domain_after_callback_redirect_url",
} as const;

type CrossDomainAuthQueryParamKey = keyof typeof crossDomainAuthQueryParams;

function getCrossDomainParam(params: URLSearchParams, key: CrossDomainAuthQueryParamKey): string | null {
  return params.get(crossDomainAuthQueryParams[key]);
}

function hasCrossDomainParam(params: URLSearchParams, key: CrossDomainAuthQueryParamKey): boolean {
  return params.has(crossDomainAuthQueryParams[key]);
}

function setCrossDomainParam(params: URLSearchParams, key: CrossDomainAuthQueryParamKey, value: string): void {
  params.set(crossDomainAuthQueryParams[key], value);
}

export type CrossDomainHandoffParams = {
  state: string,
  codeChallenge: string,
};

export function getCrossDomainHandoffParamsFromCurrentUrl(currentUrl: URL): CrossDomainHandoffParams | null {
  const state = getCrossDomainParam(currentUrl.searchParams, "state");
  const codeChallenge = getCrossDomainParam(currentUrl.searchParams, "codeChallenge");
  if (state == null || codeChallenge == null) {
    return null;
  }
  return { state, codeChallenge };
}

type RedirectBackAwareHandlerName = "signIn" | "signUp" | "onboarding" | "signOut";
type ContinuationAwareHandlerName = "forgotPassword" | "passwordReset";
type HandlerRedirectPolicy = "none" | "redirect-back-aware" | "continuation-aware" | "after-auth-return";

type CrossDomainHandoffParamsMaybeMissing = {
  state: string | null,
  codeChallenge: string | null,
  afterCallbackRedirectUrl: string | null,
};

function isRedirectBackAwareHandlerName(handlerName: keyof HandlerUrls): handlerName is RedirectBackAwareHandlerName {
  return handlerName === "signIn"
    || handlerName === "signUp"
    || handlerName === "onboarding"
    || handlerName === "signOut";
}

function isContinuationAwareHandlerName(handlerName: keyof HandlerUrls): handlerName is ContinuationAwareHandlerName {
  return handlerName === "forgotPassword" || handlerName === "passwordReset";
}

function hasCrossDomainHandoffParams(url: URL): boolean {
  return (
    hasCrossDomainParam(url.searchParams, "state")
    && hasCrossDomainParam(url.searchParams, "codeChallenge")
    && hasCrossDomainParam(url.searchParams, "afterCallbackRedirectUrl")
  );
}

function buildCrossDomainAuthCallbackUrl(options: {
  currentUrl: URL,
  localOAuthCallbackUrl: string,
  state?: string,
  codeChallenge?: string,
  afterCallbackRedirectUrl?: string,
}): URL {
  const localOAuthCallbackUrl = new URL(options.localOAuthCallbackUrl, options.currentUrl);
  if (localOAuthCallbackUrl.origin !== options.currentUrl.origin) {
    throw new HexclaveAssertionError("Cross-domain auth callback URL must stay on the current origin", {
      localOAuthCallbackUrl: localOAuthCallbackUrl.toString(),
      currentUrl: options.currentUrl.toString(),
    });
  }
  setCrossDomainParam(localOAuthCallbackUrl.searchParams, "marker", "1");
  if (options.state != null) {
    setCrossDomainParam(localOAuthCallbackUrl.searchParams, "state", options.state);
  }
  if (options.codeChallenge != null) {
    setCrossDomainParam(localOAuthCallbackUrl.searchParams, "codeChallenge", options.codeChallenge);
  }
  if (options.afterCallbackRedirectUrl != null) {
    setCrossDomainParam(localOAuthCallbackUrl.searchParams, "afterCallbackRedirectUrl", options.afterCallbackRedirectUrl);
  }
  return localOAuthCallbackUrl;
}

function buildRedirectBackAwareHandlerUrl(options: {
  handlerName: RedirectBackAwareHandlerName,
  rawHandlerUrl: string,
  currentUrl: URL,
  crossDomainHandoffParams: CrossDomainHandoffParams | null,
  localOAuthCallbackUrl: string,
  noRedirectBack: boolean,
  afterCallbackRedirectUrlOverride: string | null,
}): string {
  const nextUrl = new URL(options.rawHandlerUrl, options.currentUrl);
  // Preserve after_auth_return_to verbatim (not a rebranded param).
  const currentAfterAuthReturnTo = options.currentUrl.searchParams.get("after_auth_return_to");
  if (!options.noRedirectBack && currentAfterAuthReturnTo != null && !nextUrl.searchParams.has("after_auth_return_to")) {
    nextUrl.searchParams.set("after_auth_return_to", currentAfterAuthReturnTo);
  }
  for (const preservedParam of ["state", "codeChallenge", "afterCallbackRedirectUrl"] as const) {
    if (options.noRedirectBack && preservedParam === "afterCallbackRedirectUrl") {
      continue;
    }
    const currentValue = getCrossDomainParam(options.currentUrl.searchParams, preservedParam);
    if (currentValue != null && !hasCrossDomainParam(nextUrl.searchParams, preservedParam)) {
      setCrossDomainParam(nextUrl.searchParams, preservedParam, currentValue);
    }
  }

  if (options.handlerName === "signOut") {
    if (!nextUrl.searchParams.has("after_auth_return_to")) {
      if (options.currentUrl.protocol === nextUrl.protocol && options.currentUrl.host === nextUrl.host) {
        nextUrl.searchParams.set("after_auth_return_to", getRelativePart(options.currentUrl));
      } else {
        nextUrl.searchParams.set("after_auth_return_to", options.currentUrl.toString());
      }
    }
    return nextUrl.origin === options.currentUrl.origin ? getRelativePart(nextUrl) : nextUrl.toString();
  }

  const isCrossDomainHandlerRedirect = options.currentUrl.origin !== nextUrl.origin;
  if (isCrossDomainHandlerRedirect) {
    if (!hasCrossDomainHandoffParams(nextUrl)) {
      const inheritedAfterAuthReturnTo = options.currentUrl.searchParams.get("after_auth_return_to");
      const afterCallbackRedirectUrl = options.afterCallbackRedirectUrlOverride ?? (
        inheritedAfterAuthReturnTo
          ? new URL(inheritedAfterAuthReturnTo, options.currentUrl).toString()
          : options.currentUrl.toString()
      );
      const handoffParams = options.crossDomainHandoffParams
        ?? getCrossDomainHandoffParamsFromCurrentUrl(options.currentUrl);
      const callbackUrl = buildCrossDomainAuthCallbackUrl({
        currentUrl: options.currentUrl,
        localOAuthCallbackUrl: options.localOAuthCallbackUrl,
        state: handoffParams?.state,
        codeChallenge: handoffParams?.codeChallenge,
        afterCallbackRedirectUrl,
      });

      nextUrl.searchParams.set("after_auth_return_to", callbackUrl.toString());
      setCrossDomainParam(nextUrl.searchParams, "afterCallbackRedirectUrl", afterCallbackRedirectUrl);
      if (handoffParams != null) {
        setCrossDomainParam(nextUrl.searchParams, "state", handoffParams.state);
        setCrossDomainParam(nextUrl.searchParams, "codeChallenge", handoffParams.codeChallenge);
      }
    }
  } else if (!options.noRedirectBack && options.currentUrl.protocol === nextUrl.protocol && options.currentUrl.host === nextUrl.host && !nextUrl.searchParams.has("after_auth_return_to")) {
    nextUrl.searchParams.set("after_auth_return_to", getRelativePart(options.currentUrl));
  }

  return nextUrl.origin === options.currentUrl.origin ? getRelativePart(nextUrl) : nextUrl.toString();
}

/**
 * Carries an auth flow's existing return state without ever making the current page the return
 * target. This distinction is important for password flows: forgot-password and password-reset
 * are continuation pages, not destinations customers should return to after signing in.
 */
function buildContinuationAwareHandlerUrl(options: {
  rawHandlerUrl: string,
  currentUrl: URL,
}): string {
  const nextUrl = new URL(options.rawHandlerUrl, options.currentUrl);
  const inheritedAfterAuthReturnTo = options.currentUrl.searchParams.get("after_auth_return_to");
  if (inheritedAfterAuthReturnTo != null && !nextUrl.searchParams.has("after_auth_return_to")) {
    nextUrl.searchParams.set("after_auth_return_to", inheritedAfterAuthReturnTo);
  }
  for (const preservedParam of ["state", "codeChallenge", "afterCallbackRedirectUrl"] as const) {
    const currentValue = getCrossDomainParam(options.currentUrl.searchParams, preservedParam);
    if (currentValue != null && !hasCrossDomainParam(nextUrl.searchParams, preservedParam)) {
      setCrossDomainParam(nextUrl.searchParams, preservedParam, currentValue);
    }
  }
  return nextUrl.origin === options.currentUrl.origin ? getRelativePart(nextUrl) : nextUrl.toString();
}

function getHandlerRedirectPolicy(handlerName: keyof HandlerUrls): HandlerRedirectPolicy {
  if (handlerName === "afterSignIn" || handlerName === "afterSignUp") {
    return "after-auth-return";
  }
  if (isRedirectBackAwareHandlerName(handlerName)) {
    return "redirect-back-aware";
  }
  if (isContinuationAwareHandlerName(handlerName)) {
    return "continuation-aware";
  }
  return "none";
}

type RedirectToHandlerPlan =
  | { type: "redirect", url: string }
  | {
    type: "cross-domain-authorize",
    redirectUri: string,
    state: string,
    codeChallenge: string,
    afterCallbackRedirectUrl: string,
  };


async function resolveRedirectBackAwareHandlerUrlForRedirect(options: {
  handlerName: RedirectBackAwareHandlerName,
  rawHandlerUrl: string,
  currentUrl: URL,
  localOAuthCallbackUrl: string,
  getCrossDomainHandoffParams: (currentUrl: URL) => Promise<CrossDomainHandoffParams>,
  noRedirectBack: boolean,
  afterCallbackRedirectUrlOverride: string | null,
}): Promise<string> {
  const initial = buildRedirectBackAwareHandlerUrl({
    handlerName: options.handlerName,
    rawHandlerUrl: options.rawHandlerUrl,
    currentUrl: options.currentUrl,
    crossDomainHandoffParams: null,
    localOAuthCallbackUrl: options.localOAuthCallbackUrl,
    noRedirectBack: options.noRedirectBack,
    afterCallbackRedirectUrlOverride: options.afterCallbackRedirectUrlOverride,
  });
  if (options.handlerName === "signOut") {
    return initial;
  }

  const initialTarget = new URL(initial, options.currentUrl);
  const isCrossDomainHandlerRedirect = options.currentUrl.origin !== initialTarget.origin;
  if (!isCrossDomainHandlerRedirect || hasCrossDomainHandoffParams(initialTarget)) {
    return initial;
  }

  const crossDomainHandoffParams = await options.getCrossDomainHandoffParams(options.currentUrl);
  return buildRedirectBackAwareHandlerUrl({
    handlerName: options.handlerName,
    rawHandlerUrl: options.rawHandlerUrl,
    currentUrl: options.currentUrl,
    crossDomainHandoffParams,
    localOAuthCallbackUrl: options.localOAuthCallbackUrl,
    noRedirectBack: options.noRedirectBack,
    afterCallbackRedirectUrlOverride: options.afterCallbackRedirectUrlOverride,
  });
}

export async function planRedirectToHandler(options: {
  handlerName: keyof HandlerUrls,
  rawHandlerUrl: string,
  noRedirectBack: boolean,
  currentUrl: URL | null,
  getLocalOAuthCallbackUrl: () => string,
  rawAfterSignInUrl: string,
  getCrossDomainHandoffParams: (currentUrl: URL) => Promise<CrossDomainHandoffParams>,
}): Promise<RedirectToHandlerPlan> {
  if (options.currentUrl == null) {
    return { type: "redirect", url: options.rawHandlerUrl };
  }

  const policy = getHandlerRedirectPolicy(options.handlerName);
  if (options.noRedirectBack) {
    // noRedirectBack suppresses the current deep link, but hosted auth still has to return through
    // the source app so it can finish the cross-domain token handoff. Once that finishes, continue
    // to afterSignIn instead.
    if (policy === "redirect-back-aware" && options.handlerName !== "signOut") {
      const authTarget = new URL(options.rawHandlerUrl, options.currentUrl);
      if (authTarget.origin === options.currentUrl.origin) {
        if (options.handlerName !== "signIn") {
          return { type: "redirect", url: options.rawHandlerUrl };
        }
        return {
          type: "redirect",
          url: buildContinuationAwareHandlerUrl({
            rawHandlerUrl: options.rawHandlerUrl,
            currentUrl: options.currentUrl,
          }),
        };
      }
    } else {
      // Other handlers retain the historical noRedirectBack behavior, including
      // afterSignIn/afterSignUp ignoring all return state.
      return {
        type: "redirect",
        url: options.rawHandlerUrl,
      };
    }
  }
  if (policy === "none") {
    return { type: "redirect", url: options.rawHandlerUrl };
  }
  if (policy === "continuation-aware") {
    return {
      type: "redirect",
      url: buildContinuationAwareHandlerUrl({
        rawHandlerUrl: options.rawHandlerUrl,
        currentUrl: options.currentUrl,
      }),
    };
  }

  if (policy === "after-auth-return") {
    if (options.noRedirectBack) {
      return { type: "redirect", url: options.rawHandlerUrl };
    }
    const redirectBackUrl = options.currentUrl.searchParams.get("after_auth_return_to");
    if (redirectBackUrl == null) {
      return { type: "redirect", url: options.rawHandlerUrl };
    }
    const redirectBackTarget = new URL(redirectBackUrl, options.currentUrl);
    const crossDomainHandoff = getCrossDomainHandoffForRedirect({
      currentUrl: options.currentUrl,
      redirectBackTarget,
    });
    if (crossDomainHandoff == null) {
      return { type: "redirect", url: redirectBackUrl };
    }
    let state = crossDomainHandoff.handoffParams.state;
    let codeChallenge = crossDomainHandoff.handoffParams.codeChallenge;
    let afterCallbackRedirectUrl = crossDomainHandoff.handoffParams.afterCallbackRedirectUrl;
    if (state == null || codeChallenge == null) {
      const generatedHandoffParams = await options.getCrossDomainHandoffParams(options.currentUrl);
      state ??= generatedHandoffParams.state;
      codeChallenge ??= generatedHandoffParams.codeChallenge;
    }
    afterCallbackRedirectUrl ??= options.currentUrl.toString();
    return {
      type: "cross-domain-authorize",
      redirectUri: crossDomainHandoff.redirectBackTarget.toString(),
      state,
      codeChallenge,
      afterCallbackRedirectUrl,
    };
  }

  if (
    options.handlerName !== "signIn"
    && options.handlerName !== "signUp"
    && options.handlerName !== "onboarding"
    && options.handlerName !== "signOut"
  ) {
    throw new HexclaveAssertionError("Unexpected redirect-back-aware handler policy mismatch", {
      handlerName: options.handlerName,
      policy,
    });
  }

  // noRedirectBack suppresses the initiating deep link, not the return journey. Cross-domain auth
  // still needs to return through the source app's callback, but its final destination is the
  // configured post-sign-in page.
  const afterCallbackRedirectUrlOverride = options.noRedirectBack
    ? new URL(options.rawAfterSignInUrl, options.currentUrl).toString()
    : null;

  return {
    type: "redirect",
    url: await resolveRedirectBackAwareHandlerUrlForRedirect({
      handlerName: options.handlerName,
      rawHandlerUrl: options.rawHandlerUrl,
      currentUrl: options.currentUrl,
      localOAuthCallbackUrl: options.getLocalOAuthCallbackUrl(),
      getCrossDomainHandoffParams: options.getCrossDomainHandoffParams,
      noRedirectBack: options.noRedirectBack,
      afterCallbackRedirectUrlOverride,
    }),
  };
}

function readCrossDomainHandoffParams(currentUrl: URL, redirectBackTarget: URL): CrossDomainHandoffParamsMaybeMissing {
  // Hexclave rebrand: accept either param name from both URLs.
  const state = getCrossDomainParam(currentUrl.searchParams, "state")
    ?? getCrossDomainParam(redirectBackTarget.searchParams, "state");
  const codeChallenge = getCrossDomainParam(currentUrl.searchParams, "codeChallenge")
    ?? getCrossDomainParam(redirectBackTarget.searchParams, "codeChallenge");
  const afterCallbackRedirectUrl = getCrossDomainParam(currentUrl.searchParams, "afterCallbackRedirectUrl")
    ?? getCrossDomainParam(redirectBackTarget.searchParams, "afterCallbackRedirectUrl");
  return {
    state,
    codeChallenge,
    afterCallbackRedirectUrl,
  };
}

function resolveCrossDomainRedirectBackTarget(options: {
  currentUrl: URL,
  redirectBackTarget: URL,
  handoffParams: CrossDomainHandoffParamsMaybeMissing,
}): URL | null {
  if (options.redirectBackTarget.origin !== options.currentUrl.origin) {
    return options.redirectBackTarget;
  }
  if (
    options.handoffParams.state == null
    || options.handoffParams.codeChallenge == null
    || options.handoffParams.afterCallbackRedirectUrl == null
  ) {
    return null;
  }
  const afterCallbackRedirectTarget = new URL(options.handoffParams.afterCallbackRedirectUrl, options.currentUrl);
  if (afterCallbackRedirectTarget.origin === options.currentUrl.origin) {
    return null;
  }
  return new URL(
    `${options.redirectBackTarget.pathname}${options.redirectBackTarget.search}${options.redirectBackTarget.hash}`,
    afterCallbackRedirectTarget.origin,
  );
}

function getCrossDomainHandoffForRedirect(options: {
  currentUrl: URL,
  redirectBackTarget: URL,
}): {
  redirectBackTarget: URL,
  handoffParams: CrossDomainHandoffParamsMaybeMissing,
} | null {
  const handoffParams = readCrossDomainHandoffParams(options.currentUrl, options.redirectBackTarget);
  const crossDomainRedirectBackTarget = resolveCrossDomainRedirectBackTarget({
    currentUrl: options.currentUrl,
    redirectBackTarget: options.redirectBackTarget,
    handoffParams,
  });
  if (crossDomainRedirectBackTarget == null) {
    return null;
  }
  return {
    redirectBackTarget: crossDomainRedirectBackTarget,
    handoffParams,
  };
}
