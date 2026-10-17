import { KnownError, KnownErrors, HexclaveClientInterface } from "@hexclave/shared";
import { InternalSession } from "@hexclave/shared/dist/sessions";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { Result } from "@hexclave/shared/dist/utils/results";
import { deindent } from "@hexclave/shared/dist/utils/strings";
import { constructRedirectUrl } from "../utils/url";
import { consumeVerifierAndStateCookie, saveVerifierAndState } from "./cookie";
export async function getNewOAuthProviderOrScopeUrl(
  iface: HexclaveClientInterface,
  options: {
    provider: string,
    redirectUrl: string,
    errorRedirectUrl: string,
    providerScope?: string,
  },
  session: InternalSession,
): Promise<string> {
  const { codeChallenge, state } = await saveVerifierAndState();
  return await iface.getOAuthUrl({
    provider: options.provider,
    redirectUrl: constructRedirectUrl(options.redirectUrl, "redirectUrl"),
    errorRedirectUrl: constructRedirectUrl(options.errorRedirectUrl, "errorRedirectUrl"),
    // Unlike callback URLs, this is the final user-facing location and may legitimately use a
    // fragment for an account-settings tab. Preserve it exactly.
    afterCallbackRedirectUrl: window.location.href,
    codeChallenge,
    state,
    type: "link",
    session,
    providerScope: options.providerScope,
  });
}

/**
 * Checks if the current URL has the query parameters for an OAuth callback, and if so, removes them.
 *
 * Must be synchronous for the logic in callOAuthCallback to work without race conditions.
 */
type OAuthCallbackConsumptionResult =
  | {
    type: "oauth-response",
    originalUrl: URL,
    codeVerifier: string,
    state: string,
  }
  | {
    type: "known-error",
    error: KnownError,
  };

const oauthErrorParams = ["error", "error_description", "errorCode", "message", "details"] as const;

// A callback URL can carry error params alongside code/state (a previous attempt's
// params also linger when only a subset is stripped), so every consumption path
// must clear the full set. Otherwise the next callback misreads stale params —
// e.g. a successful retry after a cancel still throws OAuthProviderAccessDenied.
const oauthCallbackParams = ["code", "state", ...oauthErrorParams] as const;

function removeOAuthCallbackParamsFromHistory(originalUrl: URL): void {
  const newUrl = new URL(originalUrl);
  for (const param of oauthCallbackParams) {
    newUrl.searchParams.delete(param);
  }
  window.history.replaceState({}, "", newUrl.toString());
}

function getProviderOAuthErrorFromUrl(originalUrl: URL): KnownError | null {
  const providerError = originalUrl.searchParams.get("error");
  const providerErrorDescription = originalUrl.searchParams.get("error_description");
  if (providerError == null && providerErrorDescription == null) {
    return null;
  }

  switch (providerError) {
    case "access_denied":
    case "consent_required": {
      return new KnownErrors.OAuthProviderAccessDenied();
    }
    case "server_error":
    case "temporarily_unavailable":
    default: {
      return new KnownErrors.OAuthProviderTemporarilyUnavailable();
    }
  }
}

function consumeOAuthCallbackQueryParams(options?: {
  dontWarnAboutMissingQueryParams?: boolean,
}): OAuthCallbackConsumptionResult | null {
  const requiredParams = ["code", "state"];
  const originalUrl = new URL(window.location.href);
  const knownErrorCode = originalUrl.searchParams.get("errorCode");
  const knownErrorMessage = originalUrl.searchParams.get("message");
  if (knownErrorCode && knownErrorMessage) {
    const details = originalUrl.searchParams.get("details");
    let detailsJson = {};
    if (details) {
      try {
        detailsJson = JSON.parse(details);
      } catch (error) {
        throw new HexclaveAssertionError("OAuth callback returned malformed known-error details", {
          details,
          cause: error,
        });
      }
    }

    removeOAuthCallbackParamsFromHistory(originalUrl);

    return {
      type: "known-error",
      error: KnownError.fromJson({
        code: knownErrorCode,
        message: knownErrorMessage,
        details: detailsJson,
      }),
    };
  }

  const providerOAuthError = getProviderOAuthErrorFromUrl(originalUrl);
  if (providerOAuthError != null && !requiredParams.every(param => originalUrl.searchParams.has(param))) {
    removeOAuthCallbackParamsFromHistory(originalUrl);
    return {
      type: "known-error",
      error: providerOAuthError,
    };
  }

  for (const param of requiredParams) {
    if (!originalUrl.searchParams.has(param)) {
      if (!options?.dontWarnAboutMissingQueryParams) {
        console.warn(new Error(`Missing required query parameter on OAuth callback: ${param}. Maybe you opened or reloaded the oauth-callback page from your history?`));
      }
      return null;
    }
  }

  const expectedState = originalUrl.searchParams.get("state") ?? throwErr("This should never happen; isn't state required above?");
  const cookieResult = consumeVerifierAndStateCookie(expectedState);

  if (!cookieResult) {
    // If the state can't be found in the cookies, then the callback wasn't meant for us.
    // Maybe the website uses another OAuth library?
    console.warn(deindent`
      Hexclave found an outer OAuth callback state in the query parameters, but not in cookies.

      This could have multiple reasons:
        - The cookie expired, because the OAuth flow took too long.
        - The user's browser deleted the cookie, either manually or because of a very strict cookie policy.
        - The cookie was already consumed by this page, and the user already logged in.
        - You are using another OAuth client library with the same callback URL as Hexclave.
        - The user opened the OAuth callback page from their history.

      Either way, it is probably safe to ignore this warning unless you are debugging an OAuth issue.
    `);
    return null;
  }


  // Clear the authorization code from history (replaceState, not a reload), as the
  // redirectUrl is untrusted when a validation error occurs. Stale error params are
  // cleared too, so a previous attempt can't pollute the next callback.
  removeOAuthCallbackParamsFromHistory(originalUrl);

  return {
    type: "oauth-response",
    originalUrl,
    codeVerifier: cookieResult.codeVerifier,
    state: expectedState,
  };
}

export async function callOAuthCallback(
  iface: HexclaveClientInterface,
  redirectUrl: string,
  options?: {
    dontWarnAboutMissingQueryParams?: boolean,
  },
) {
  // note: this part of the function (until the return) needs
  // to be synchronous, to prevent race conditions when
  // callOAuthCallback is called multiple times in parallel
  const consumed = consumeOAuthCallbackQueryParams(options);
  if (!consumed) return Result.ok(undefined);
  if (consumed.type === "known-error") {
    throw consumed.error;
  }

  // the rest can be asynchronous (we now know that we are the
  // intended recipient of the callback, and the only instance
  // of callOAuthCallback that's running)
  try {
    return Result.ok(await iface.callOAuthCallback({
      oauthParams: consumed.originalUrl.searchParams,
      redirectUri: constructRedirectUrl(redirectUrl, "redirectUri"),
      codeVerifier: consumed.codeVerifier,
      state: consumed.state,
    }));
  } catch (e) {
    if (KnownError.isKnownError(e)) {
      throw e;
    }
    throw new HexclaveAssertionError("Error signing in during OAuth callback. Please try again.", { cause: e });
  }
}
