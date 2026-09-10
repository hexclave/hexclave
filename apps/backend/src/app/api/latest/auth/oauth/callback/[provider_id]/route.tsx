import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { logSignInAttemptInBackground } from "@/lib/compliance-events";
import { getBestEffortEndUserRequestContext } from "@/lib/end-users";
import { buildSignUpRuleOptions, reconstructTurnstileAssessment } from "@/lib/sign-up-context";
import { checkApiKeySet, throwCheckApiKeySetError } from "@/lib/internal-api-keys";
import { createOAuthUserAndAccount, findExistingOAuthAccount, handleOAuthEmailMergeStrategy, linkOAuthAccountToUser } from "@/lib/oauth";
import { isAcceptedNativeAppUrl, validateRedirectUrl } from "@/lib/redirect-urls";
import { getApiUrlForRequest } from "@/lib/request-api-url";
import { Tenancy, getTenancy } from "@/lib/tenancies";
import { oauthCookieSchema } from "@/lib/tokens";
import { createOAuthServer, getProvider } from "@/oauth";
import { PrismaClientTransaction, getPrismaClientForTenancy, globalPrismaClient, isPrismaError } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { InvalidClientError, InvalidScopeError, Request as OAuthRequest, Response as OAuthResponse } from "@node-oauth/oauth2-server";
import { KnownError, KnownErrors } from "@hexclave/shared";
import { yupMixed, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError, StatusError, captureError } from "@hexclave/shared/dist/utils/errors";
import { deindent, extractScopes, mergeScopeStrings } from "@hexclave/shared/dist/utils/strings";
import { cookies } from "@/lib/runtime/headers";
import { redirect } from "@/lib/runtime/navigation";
import { oauthResponseToSmartResponse } from "../../oauth-helpers";

/**
 * Create a project user OAuth account with the provided data.
 * Used for the "link" flow which doesn't go through the standard sign-up path.
 */
async function createProjectUserOAuthAccountForLink(prisma: PrismaClientTransaction, params: {
  tenancyId: string,
  providerId: string,
  providerAccountId: string,
  email: string | null,
  projectUserId: string,
}) {
  return await prisma.projectUserOAuthAccount.create({
    data: {
      configOAuthProviderId: params.providerId,
      providerAccountId: params.providerAccountId,
      email: params.email,
      projectUser: {
        connect: {
          tenancyId_projectUserId: {
            tenancyId: params.tenancyId,
            projectUserId: params.projectUserId,
          },
        },
      },
    },
  });
}

const redirectOrThrowError = (error: KnownError, tenancy: Tenancy, options: {
  oauthCallbackRedirectUrl?: string,
  errorRedirectUrl?: string,
  afterCallbackRedirectUrl?: string,
}) => {
  const targetRedirectUrl =
    options.oauthCallbackRedirectUrl && (validateRedirectUrl(options.oauthCallbackRedirectUrl, tenancy) || isAcceptedNativeAppUrl(options.oauthCallbackRedirectUrl))
      ? options.oauthCallbackRedirectUrl
      : options.errorRedirectUrl && (validateRedirectUrl(options.errorRedirectUrl, tenancy) || isAcceptedNativeAppUrl(options.errorRedirectUrl))
        ? options.errorRedirectUrl
        : null;
  if (!targetRedirectUrl) {
    throw error;
  }

  const url = new URL(targetRedirectUrl);
  url.searchParams.set("error", "server_error");
  url.searchParams.set("error_description", error.message);
  url.searchParams.set("errorCode", error.errorCode);
  url.searchParams.set("message", error.message);
  url.searchParams.set("details", error.details ? JSON.stringify(error.details) : JSON.stringify({}));
  if (
    options.afterCallbackRedirectUrl != null
    && (validateRedirectUrl(options.afterCallbackRedirectUrl, tenancy) || isAcceptedNativeAppUrl(options.afterCallbackRedirectUrl))
  ) {
    // The callback page must consume the OAuth error before the browser can return to this
    // continuation, so preserve it as metadata rather than redirecting there directly.
    url.searchParams.set("after_callback_redirect_url", options.afterCallbackRedirectUrl);
  }
  redirect(url.toString());
};

function getFirstQueryString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

/**
 * Apple (the only provider we support that uses `response_mode=form_post`) delivers its
 * authorization response as a cross-site POST of an HTML form instead of a top-level GET
 * redirect. Returns the form fields for such a request, or `null` for every other request
 * shape, so the callback can bounce them into a same-origin GET.
 */
function getFormPostCallbackParams(req: { method: string, body: unknown, headers: Record<string, string[] | undefined> }): [string, string][] | null {
  if (req.method !== "POST") return null;
  if (req.headers["content-type"]?.[0]?.split(";")[0].trim() !== "application/x-www-form-urlencoded") return null;
  if (typeof req.body !== "object" || req.body === null) return null;
  const entries = Object.entries(req.body).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  // Only the authorization response itself is worth bouncing; anything without a state has
  // no chance of succeeding on the GET path either, and shouldn't cause an extra roundtrip.
  if (!entries.some(([key]) => key === "state")) return null;
  return entries;
}

import.meta.vitest?.test("getFormPostCallbackParams only picks up form-encoded authorization responses", ({ expect }) => {
  const formHeaders = { "content-type": ["application/x-www-form-urlencoded"] };
  expect(getFormPostCallbackParams({ method: "POST", body: { code: "c", state: "s" }, headers: formHeaders })).toEqual([["code", "c"], ["state", "s"]]);
  expect(getFormPostCallbackParams({ method: "POST", body: { code: "c", state: "s" }, headers: { "content-type": ["application/x-www-form-urlencoded; charset=UTF-8"] } })).toEqual([["code", "c"], ["state", "s"]]);
  expect(getFormPostCallbackParams({ method: "GET", body: undefined, headers: {} })).toBe(null);
  expect(getFormPostCallbackParams({ method: "POST", body: { code: "c", state: "s" }, headers: { "content-type": ["application/json"] } })).toBe(null);
  expect(getFormPostCallbackParams({ method: "POST", body: { code: "c" }, headers: formHeaders })).toBe(null);
  expect(getFormPostCallbackParams({ method: "POST", body: "state=s", headers: formHeaders })).toBe(null);
});

const shouldRedirectOAuthCallbackKnownError = (error: KnownError) => (
  KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse.isInstance(error)
  || KnownErrors.OAuthConnectionAlreadyConnectedToAnotherUser.isInstance(error)
  || KnownErrors.SignUpNotEnabled.isInstance(error)
  || KnownErrors.SignUpRejected.isInstance(error)
);

const handler = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    params: yupObject({
      provider_id: yupString().defined(),
    }).defined(),
    query: yupMixed().optional(),
    body: yupMixed().optional(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([307, 303]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupMixed().defined(),
    headers: yupMixed().defined(),
  }),
  async handler({ params, query, body }, fullReq) {
    const apiUrl = getApiUrlForRequest(fullReq);

    // Apple is the only provider that answers with `response_mode=form_post`: the
    // browser lands here with a cross-site POST instead of the usual top-level GET.
    // Browsers omit SameSite=Lax cookies on cross-site POSTs, so the inner CSRF
    // cookie /authorize set would be missing — and because the single-use outer
    // info is consumed below regardless, the retry that follows then failed with
    // "Invalid OAuth state". Bounce the form parameters into a top-level GET on our
    // own origin (which does receive Lax cookies) and handle it on the normal path.
    const formPostParams = getFormPostCallbackParams(fullReq);
    if (formPostParams) {
      const target = new URL(fullReq.url);
      target.search = new URLSearchParams([...target.searchParams, ...formPostParams]).toString();
      return {
        statusCode: 303,
        bodyType: "json",
        body: {},
        headers: {
          location: [target.pathname + target.search],
        },
      };
    }

    const innerState = query.state ?? (body as any)?.state ?? "";

    let outerInfoDB;
    try {
      outerInfoDB = await globalPrismaClient.oAuthOuterInfo.delete({
        where: {
          innerState: innerState,
        },
      });
    } catch (e) {
      if (isPrismaError(e, "DEPENDENT_RECORD_NOT_FOUND")) {
        // No matching outer info (never existed, expired-and-swept, or already consumed by a concurrent/replayed callback).
        throw new StatusError(StatusError.BadRequest, "Invalid OAuth state. Please try signing in again.");
      }
      throw e;
    }

    let outerInfo: Awaited<ReturnType<typeof oauthCookieSchema.validate>>;
    try {
      outerInfo = await oauthCookieSchema.validate(outerInfoDB.info);
    } catch (error) {
      throw new HexclaveAssertionError("Invalid outer info");
    }

    // The inner CSRF cookie is host-scoped to the host that served /authorize.
    // The OAuth redirect_uri (and thus this callback's host) is config-derived
    // and can be a sibling brand (e.g. authorize on api.hexclave.com, callback
    // on api.stack-auth.com for a legacy/shared provider). Cookies can't span
    // those hosts, so when the landing host legitimately differs from the
    // authorize host we skip the cookie check and rely on the single-use,
    // server-side outer info plus the outer flow's PKCE — the same protection
    // JSON mode already uses.
    const isCrossHostCallback = !!outerInfo.authorizeApiUrl && outerInfo.authorizeApiUrl !== apiUrl;

    // JSON-mode requests use PKCE for CSRF protection and don't set a cookie.
    // Only check the CSRF cookie for same-host browser-redirect mode requests.
    if (outerInfo.responseMode !== 'json' && !isCrossHostCallback) {
      // Hexclave rebrand: read whichever inner-OAuth cookie name is present (prefer the new name), and delete both.
      const cookieStore = await cookies();
      const cookieInfo = cookieStore.get("hexclave-oauth-inner-" + innerState)
        ?? cookieStore.get("stack-oauth-inner-" + innerState);
      cookieStore.delete("hexclave-oauth-inner-" + innerState);
      cookieStore.delete("stack-oauth-inner-" + innerState);

      if (cookieInfo?.value !== 'true') {
        throw new StatusError(StatusError.BadRequest, "Inner OAuth cookie not found. This is likely because you refreshed the page during the OAuth sign in process. Please try signing in again");
      }
    }

    const {
      tenancyId,
      innerCodeVerifier,
      type,
      projectUserId,
      providerScope,
      errorRedirectUrl,
      redirectUri,
      afterCallbackRedirectUrl,
    } = outerInfo;

    const tenancy = await getTenancy(tenancyId);
    if (!tenancy) {
      throw new HexclaveAssertionError("Tenancy in outerInfo not found; has it been deleted?", { tenancyId });
    }
    const prisma = await getPrismaClientForTenancy(tenancy);

    try {
      if (outerInfoDB.expiresAt < new Date()) {
        throw new KnownErrors.OuterOAuthTimeout();
      }

      const providerRaw = Object.entries(tenancy.config.auth.oauth.providers).find(([providerId, _]) => providerId === params.provider_id);
      if (!providerRaw) {
        throw new KnownErrors.OAuthProviderNotFoundOrNotEnabled();
      }

      const provider = { id: providerRaw[0], ...providerRaw[1] };

      const keyCheck = await checkApiKeySet(tenancy.project.id, { publishableClientKey: outerInfo.publishableClientKey });
      if (keyCheck.status === "error") {
        throwCheckApiKeySetError(keyCheck.error, tenancy.project.id, new KnownErrors.InvalidPublishableClientKey(tenancy.project.id));
      }

      const providerObj = await getProvider(provider as any, provider.id);
      let callbackResult: Awaited<ReturnType<typeof providerObj.getCallback>>;
      try {
        callbackResult = await providerObj.getCallback({
          codeVerifier: innerCodeVerifier,
          state: innerState,
          extraScope: providerScope,
          callbackParams: {
            ...query,
            ...body,
          },
        });
      } catch (error) {
        if (
          KnownErrors.OAuthProviderAccessDenied.isInstance(error) ||
          KnownErrors.OAuthProviderTemporarilyUnavailable.isInstance(error)
        ) {
          // Only sign-in/sign-up flows are compliance sign-in attempts; a "link" flow is an
          // already-signed-in user connecting another provider, so its failures must not inflate
          // failed sign-in counts (matches the success and conflict-failure paths below).
          if (type !== "link") {
            logSignInAttemptInBackground(tenancy, {
              outcome: "failed",
              method: "oauth",
              failureReason: KnownErrors.OAuthProviderAccessDenied.isInstance(error)
                ? "provider_denied"
                : "provider_unavailable",
              oauthProvider: params.provider_id,
              userId: projectUserId ?? null,
            });
          }
          redirectOrThrowError(error, tenancy, { oauthCallbackRedirectUrl: redirectUri, errorRedirectUrl, afterCallbackRedirectUrl });
        }
        throw error;
      }

      const { userInfo, tokenSet } = callbackResult;

      if (type === "link") {
        if (!projectUserId) {
          throw new HexclaveAssertionError("projectUserId not found in cookie when authorizing signed in user");
        }

        const user = await prisma.projectUser.findUnique({
          where: {
            tenancyId_projectUserId: {
              tenancyId,
              projectUserId,
            },
          },
          include: {
            projectUserOAuthAccounts: true,
          }
        });
        if (!user) {
          throw new HexclaveAssertionError("User not found");
        }
      }

      const oauthRequest = new OAuthRequest({
        headers: {},
        body: {},
        method: "GET",
        query: {
          client_id: `${tenancy.project.id}#${tenancy.branchId}`,
          client_secret: outerInfo.publishableClientKey,
          redirect_uri: outerInfo.redirectUri,
          state: outerInfo.state,
          scope: outerInfo.scope,
          grant_type: outerInfo.grantType,
          code_challenge: outerInfo.codeChallenge,
          code_challenge_method: outerInfo.codeChallengeMethod,
          response_type: outerInfo.responseType,
        }
      });

      const storeTokens = async (oauthAccountId: string) => {
        const tokenScopes = extractScopes(mergeScopeStrings(providerObj.scope, providerScope ?? ""));
        if (tokenSet.refreshToken) {
          await prisma.oAuthToken.create({
            data: {
              tenancyId: outerInfo.tenancyId,
              refreshToken: tokenSet.refreshToken,
              scopes: tokenScopes,
              oauthAccountId,
            }
          });
        }

        await prisma.oAuthAccessToken.create({
          data: {
            tenancyId: outerInfo.tenancyId,
            accessToken: tokenSet.accessToken,
            scopes: tokenScopes,
            expiresAt: tokenSet.accessTokenExpiredAt,
            oauthAccountId,
          }
        });
      };

      const oauthResponse = new OAuthResponse();
      const oauthServer = createOAuthServer({ apiUrl });
      const logOAuthSuccess = (userId: string) => {
        if (type !== "link") {
          logSignInAttemptInBackground(tenancy, {
            outcome: "success",
            method: "oauth",
            oauthProvider: provider.id,
            email: userInfo.email ?? null,
            userId,
          });
        }
      };
      // The sign-in isn't actually complete until oauthServer.authorize() finishes: it calls
      // OAuthModel.saveToken() *after* authenticateHandler.handle() returns, and that's where TOTP
      // MFA is enforced and refresh tokens are persisted. So we defer the success event until after
      // authorize() resolves — otherwise an MFA challenge or a token-persistence failure would be
      // recorded as a successful sign-in in the Compliance Center.
      const successfulSignInUserIdRef: { current: string | null } = { current: null };
      try {
        await oauthServer.authorize(
          oauthRequest,
          oauthResponse,
          {
            authenticateHandler: {
              handle: async () => {
                try {
                  // Find existing OAuth account (used by both link and sign-in flows)
                  const oldAccount = await findExistingOAuthAccount(
                    prisma,
                    outerInfo.tenancyId,
                    provider.id,
                    userInfo.accountId
                  );

                  // ========================== link account with user ==========================
                  // This flow is when a signed-in user wants to connect an OAuth account
                  if (type === "link") {
                    if (!projectUserId) {
                      throw new HexclaveAssertionError("projectUserId not found in cookie when authorizing signed in user");
                    }

                    if (oldAccount) {
                      // ========================== account already connected ==========================
                      if (oldAccount.projectUserId !== projectUserId) {
                        throw new KnownErrors.OAuthConnectionAlreadyConnectedToAnotherUser();
                      }
                      await storeTokens(oldAccount.id);
                    } else {
                      // ========================== connect account with user ==========================
                      const newOAuthAccount = await createProjectUserOAuthAccountForLink(prisma, {
                        tenancyId: outerInfo.tenancyId,
                        providerId: provider.id,
                        providerAccountId: userInfo.accountId,
                        email: userInfo.email ?? null,
                        projectUserId,
                      });

                      await storeTokens(newOAuthAccount.id);
                    }

                    return {
                      id: projectUserId,
                      newUser: false,
                      afterCallbackRedirectUrl,
                    };
                  }

                  // ========================== sign in / sign up flow ==========================

                  // Check if user already exists with this OAuth account
                  if (oldAccount) {
                    await storeTokens(oldAccount.id);
                    if (oldAccount.projectUserId == null) {
                      throw new HexclaveAssertionError("Existing OAuth account is missing its project user ID.");
                    }
                    successfulSignInUserIdRef.current = oldAccount.projectUserId;

                    return {
                      id: oldAccount.projectUserId,
                      newUser: false,
                      afterCallbackRedirectUrl,
                      email: userInfo.email ?? null,
                      oauthProvider: provider.id,
                    };
                  }

                  // ========================== sign up user ==========================

                  // Handle email merge strategy if email is provided
                  const { linkedUserId, primaryEmailAuthEnabled } = userInfo.email
                    ? await handleOAuthEmailMergeStrategy(prisma, tenancy, userInfo.email, userInfo.emailVerified)
                    : { linkedUserId: null, primaryEmailAuthEnabled: false };

                  if (linkedUserId) {
                    // ========================== Link OAuth account to existing user via email ==========================
                    const { oauthAccountId } = await linkOAuthAccountToUser(prisma, {
                      tenancyId: outerInfo.tenancyId,
                      providerId: provider.id,
                      providerAccountId: userInfo.accountId,
                      email: userInfo.email ?? null,
                      projectUserId: linkedUserId,
                    });

                    await storeTokens(oauthAccountId);
                    successfulSignInUserIdRef.current = linkedUserId;
                    return {
                      id: linkedUserId,
                      newUser: false,
                      afterCallbackRedirectUrl,
                      email: userInfo.email ?? null,
                      oauthProvider: provider.id,
                    };
                  }

                  // ========================== Create new user ==========================

                  // Get currentUser for anonymous user upgrade (if they were signed in during /authorize)
                  let currentUser = null;
                  if (projectUserId) {
                    // Note: it's possible that the user has been deleted, but the request is still
                    // done with a token that was issued before the user was deleted (or the user was
                    // deleted between the /authorize and /callback requests)
                    try {
                      currentUser = await usersCrudHandlers.adminRead({
                        tenancy,
                        user_id: projectUserId,
                        allowedErrorTypes: [KnownErrors.UserNotFound],
                      });
                    } catch (error) {
                      if (!KnownErrors.UserNotFound.isInstance(error)) {
                        throw error;
                      }
                    }
                  }

                  const requestContext = await getBestEffortEndUserRequestContext();
                  const { projectUserId: newUserId, oauthAccountId } = await createOAuthUserAndAccount(
                    prisma,
                    tenancy,
                    {
                      providerId: provider.id,
                      providerAccountId: userInfo.accountId,
                      email: userInfo.email ?? null,
                      emailVerified: userInfo.emailVerified,
                      primaryEmailAuthEnabled,
                      currentUser,
                      displayName: userInfo.displayName ?? null,
                      profileImageUrl: userInfo.profileImageUrl ?? null,
                      signUpRuleOptions: buildSignUpRuleOptions({
                        authMethod: 'oauth',
                        oauthProvider: provider.id,
                        oauthAccountCreatedAtMillis: userInfo.accountCreatedAtMillis,
                        requestContext,
                        turnstileAssessment: reconstructTurnstileAssessment(
                          outerInfo.turnstileResult ?? "invalid",
                          outerInfo.turnstileVisibleChallengeResult,
                        ),
                      }),
                    }
                  );

                  await storeTokens(oauthAccountId);
                  successfulSignInUserIdRef.current = newUserId;

                  return {
                    id: newUserId,
                    newUser: true,
                    afterCallbackRedirectUrl,
                    email: userInfo.email ?? null,
                    oauthProvider: provider.id,
                  };
                } catch (error) {
                  if (KnownError.isKnownError(error) && shouldRedirectOAuthCallbackKnownError(error)) {
                    if (type !== "link") {
                      const failureReason = KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse.isInstance(error)
                        ? "contact_channel_already_used"
                        : KnownErrors.OAuthConnectionAlreadyConnectedToAnotherUser.isInstance(error)
                          ? "already_connected_to_another_user"
                          : null;
                      if (failureReason != null) {
                        logSignInAttemptInBackground(tenancy, {
                          outcome: "failed",
                          method: "oauth",
                          failureReason,
                          oauthProvider: params.provider_id,
                          userId: projectUserId ?? null,
                        });
                      }
                    }
                    redirectOrThrowError(error, tenancy, { oauthCallbackRedirectUrl: redirectUri, errorRedirectUrl, afterCallbackRedirectUrl });
                  }
                  throw error;
                }
              }
            }
          }
        );
      } catch (error) {
        if (error instanceof InvalidClientError) {
          if (error.message.includes("redirect_uri") || error.message.includes("redirectUri")) {
            console.log("User is trying to authorize OAuth with an invalid redirect URI", error, { redirectUri: oauthRequest.query?.redirect_uri, clientId: oauthRequest.query?.client_id });
            throw new KnownErrors.RedirectUrlNotWhitelisted(getFirstQueryString(oauthRequest.query?.redirect_uri));
          }
        } else if (error instanceof InvalidScopeError) {
          // which scopes are being requested, and by whom?
          // I think this is a bug in the client? But just to be safe, let's log an error to make sure that it is not our fault
          // TODO: remove the captureError once you see in production that our own clients never trigger this
          captureError("outer-oauth-callback-invalid-scope", new HexclaveAssertionError(deindent`
            A client requested an invalid scope. Is this a bug in the client, or our fault?

              Scopes requested: ${oauthRequest.query?.scope}
          `, { outerInfo, cause: error, scopes: oauthRequest.query?.scope }));
          throw new StatusError(400, "Invalid scope requested. Please check the scopes you are requesting.");
        }
        throw error;
      }

      if (successfulSignInUserIdRef.current != null) {
        logOAuthSuccess(successfulSignInUserIdRef.current);
      }

      return oauthResponseToSmartResponse(oauthResponse);
    } catch (error) {
      if (KnownError.isKnownError(error)) {
        redirectOrThrowError(error, tenancy, { oauthCallbackRedirectUrl: redirectUri, errorRedirectUrl, afterCallbackRedirectUrl });
      }
      throw error;
    }
  },
});

export const GET = handler;
export const POST = handler;
