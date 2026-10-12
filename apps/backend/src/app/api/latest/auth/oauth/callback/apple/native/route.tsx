import { createOAuthUserAndAccount, findExistingOAuthAccount, getProjectUserIdFromOAuthAccount, handleOAuthEmailMergeStrategy, linkOAuthAccountToUser } from "@/lib/oauth";
import { isAppleEmailVerified } from "@/oauth/utils";
import { getBestEffortEndUserRequestContext } from "@/lib/end-users";
import { buildSignUpRuleOptions } from "@/lib/sign-up-context";
import { getDisabledBotChallengeAssessment, isBotChallengeDisabled } from "@/lib/turnstile";
import { getApiUrlForRequest } from "@/lib/request-api-url";
import { createAuthTokens } from "@/lib/tokens";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { createRemoteJWKSet, jwtVerify } from "jose";

// Apple's JWKS endpoint for verifying identity tokens
// See: https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_rest_api/verifying_a_user
const appleJWKS = createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

/**
 * Verifies an Apple identity token and extracts user info.
 * For native apps, the audience must be one of the configured Bundle IDs.
 * jwtVerify's audience option accepts an array and validates that the token's aud claim matches any of them.
 */
async function verifyAppleIdToken(idToken: string, allowedBundleIds: string[]): Promise<{
  sub: string,
  email: string | null,
  emailVerified: boolean,
}> {
  try {
    const { payload } = await jwtVerify(idToken, appleJWKS, {
      issuer: "https://appleid.apple.com",
      audience: allowedBundleIds,
    });

    return {
      sub: payload.sub ?? throwErr("No sub claim in Apple ID token"),
      email: typeof payload.email === "string" ? payload.email : null,
      emailVerified: isAppleEmailVerified(payload.email_verified),
    };
  } catch (error) {
    captureError("apple-native-sign-in-token-verification-failed", error);
    throw new KnownErrors.InvalidAppleCredentials();
  }
}

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Native Apple Sign In",
    description: "Authenticate a user using a native Sign In with Apple identity token. This endpoint is used by iOS/macOS apps that use the native ASAuthorizationController flow instead of web-based OAuth. The project must have Apple OAuth configured with the app's Bundle ID.",
    tags: ["Oauth"],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema,
      tenancy: adaptSchema,
    }).defined(),
    body: yupObject({
      id_token: yupString().defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      access_token: yupString().defined(),
      refresh_token: yupString().defined(),
      user_id: yupString().defined(),
      is_new_user: yupBoolean().defined(),
    }).defined(),
  }),
  async handler({ auth: { tenancy }, body }, fullReq) {
    const prisma = await getPrismaClientForTenancy(tenancy);

    // Check if Apple OAuth provider is enabled for this project
    const providerRaw = Object.entries(tenancy.config.auth.oauth.providers).find(([providerId, _]) => providerId === "apple");
    if (!providerRaw) {
      throw new KnownErrors.OAuthProviderNotFoundOrNotEnabled();
    }
    const appleProvider = { id: providerRaw[0], ...providerRaw[1] };
    if (!appleProvider.allowSignIn) {
      throw new KnownErrors.OAuthProviderNotFoundOrNotEnabled();
    }

    // Get Apple Bundle IDs from provider config (stored as Record<uuid, { bundleId: string }>)
    // For native Apple Sign In, we need the app's Bundle ID(s) (not the web Services ID)
    const appleBundleIds = appleProvider.appleBundles
      ? Object.values(appleProvider.appleBundles).flatMap(b => b?.bundleId ? [b.bundleId] : [])
      : [];

    if (appleBundleIds.length === 0) {
      throw new KnownErrors.AppleBundleIdNotConfigured();
    }

    // Verify the identity token against the Bundle IDs
    const appleUser = await verifyAppleIdToken(body.id_token, appleBundleIds);

    // Check if user already exists with this Apple account
    const existingAccount = await findExistingOAuthAccount(prisma, tenancy.id, "apple", appleUser.sub);

    let projectUserId: string;
    let isNewUser = false;

    if (existingAccount) {
      // ========================== Existing user - sign in ==========================
      projectUserId = getProjectUserIdFromOAuthAccount(existingAccount);
    } else {
      // ========================== New user - sign up ==========================

      // Handle email merge strategy if email is provided
      const { linkedUserId, primaryEmailAuthEnabled } = appleUser.email
        ? await handleOAuthEmailMergeStrategy(prisma, tenancy, appleUser.email, appleUser.emailVerified)
        : { linkedUserId: null, primaryEmailAuthEnabled: false };

      if (linkedUserId) {
        // ========================== Link Apple account to existing user ==========================
        await linkOAuthAccountToUser(prisma, {
          tenancyId: tenancy.id,
          providerId: "apple",
          providerAccountId: appleUser.sub,
          email: appleUser.email,
          projectUserId: linkedUserId,
        });
        projectUserId = linkedUserId;
      } else {
        // ========================== Create new user ==========================
        const requestContext = await getBestEffortEndUserRequestContext();
        const result = await createOAuthUserAndAccount(prisma, tenancy, {
          providerId: "apple",
          providerAccountId: appleUser.sub,
          email: appleUser.email,
          emailVerified: appleUser.emailVerified,
          primaryEmailAuthEnabled,
          currentUser: null,
          displayName: null,
          profileImageUrl: null,
          signUpRuleOptions: buildSignUpRuleOptions({
            authMethod: 'oauth',
            oauthProvider: 'apple',
            oauthAccountCreatedAtMillis: null,
            requestContext,
            turnstileAssessment: isBotChallengeDisabled()
              ? getDisabledBotChallengeAssessment()
              : { status: "invalid" },
            // Apple native OAuth doesn't pass a turnstile token because the
            // authentication happens in the native Apple sign-in flow outside our control
          }),
        });
        projectUserId = result.projectUserId;
        isNewUser = true;
      }
    }

    // Generate tokens
    const { refreshToken, accessToken } = await createAuthTokens({
      tenancy,
      projectUserId,
      apiUrl: getApiUrlForRequest(fullReq),
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        access_token: accessToken,
        refresh_token: refreshToken,
        user_id: projectUserId,
        is_new_user: isNewUser,
      },
    };
  },
});
