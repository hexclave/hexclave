import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { logSignInAttemptInBackground } from "@/lib/compliance-events";
import { createOAuthUserAndAccountWithEvaluatedSignUp, createProjectUserOAuthAccountForLink, findExistingOAuthAccount, storeOAuthProviderTokens } from "@/lib/oauth";
import { Tenancy } from "@/lib/tenancies";
import { evaluatedSignUpSchema } from "@/lib/users";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { yupArray, yupBoolean, yupNumber, yupObject, yupString, yupUnion } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import * as yup from "yup";

/**
 * Side effects of the OAuth callback that attach the provider identity to a user that was chosen by whoever
 * *started* the flow (via the `token` parameter on /authorize), rather than by whoever *completed* it at the
 * provider.
 *
 * The provider leg of the flow (/authorize -> provider -> /callback) is not bound to a browser: the initiator
 * can hand the provider URL (or the /authorize URL itself) to someone else, and that person's provider
 * identity is what arrives at /callback. If we applied these side effects in /callback, an attacker could
 * link a victim's provider account to the attacker's user, or upgrade the attacker's anonymous user into
 * the victim's identity (login CSRF).
 *
 * Instead, /callback stores the action on the authorization code, and it is only applied when that code is
 * redeemed at /token with the matching PKCE verifier. Redeeming needs both the code (delivered to the browser
 * that completed the provider leg) and the verifier (held by the browser that started the flow), so it only
 * succeeds when both are the same party.
 */
const providerTokensSchema = yupObject({
  accessToken: yupString().defined(),
  refreshToken: yupString().nullable().defined(),
  accessTokenExpiresAtMillis: yupNumber().nullable().defined(),
  scopes: yupArray(yupString().defined()).defined(),
}).defined();

export type PendingOAuthProviderTokens = yup.InferType<typeof providerTokensSchema>;

const linkActionSchema = yupObject({
  type: yupString().oneOf(["link"]).defined(),
  providerId: yupString().defined(),
  providerAccountId: yupString().defined(),
  email: yupString().nullable().defined(),
  providerTokens: providerTokensSchema,
}).defined();

const upgradeAnonymousUserActionSchema = yupObject({
  type: yupString().oneOf(["upgrade-anonymous-user"]).defined(),
  providerId: yupString().defined(),
  providerAccountId: yupString().defined(),
  email: yupString().nullable().defined(),
  emailVerified: yupBoolean().defined(),
  primaryEmailAuthEnabled: yupBoolean().defined(),
  displayName: yupString().nullable().defined(),
  profileImageUrl: yupString().nullable().defined(),
  // The sign-up checks (incl. sign-up rules) already ran in /callback, so that a rejection takes the callback's error
  // redirect like on every other OAuth sign-up. SDKs can't surface errors from the code exchange properly; they turn
  // them into a generic error. Only the user creation is deferred.
  evaluatedSignUp: evaluatedSignUpSchema,
  providerTokens: providerTokensSchema,
}).defined();

export const pendingOAuthActionSchema = yupUnion(linkActionSchema, upgradeAnonymousUserActionSchema).defined();

export type PendingOAuthAction = yup.InferType<typeof pendingOAuthActionSchema>;

/**
 * Applies a pending OAuth action. Must only be called after the authorization code it was stored on has been
 * PKCE-verified and atomically consumed, so that it runs at most once and only for the flow's initiator.
 *
 * The state of the world may have changed since /callback, so every precondition is re-checked here.
 */
export async function applyPendingOAuthAction(options: {
  tenancy: Tenancy,
  projectUserId: string,
  rawAction: unknown,
}): Promise<void> {
  const { tenancy, projectUserId } = options;
  let action: PendingOAuthAction;
  try {
    action = await pendingOAuthActionSchema.validate(options.rawAction, { strict: true });
  } catch (error) {
    throw new HexclaveAssertionError("Invalid pending OAuth action stored on authorization code", { cause: error });
  }
  const prisma = await getPrismaClientForTenancy(tenancy);

  const existingAccount = await findExistingOAuthAccount(prisma, tenancy.id, action.providerId, action.providerAccountId);

  switch (action.type) {
    case "link": {
      let oauthAccountId: string;
      if (existingAccount) {
        if (existingAccount.projectUserId !== projectUserId) {
          throw new KnownErrors.OAuthConnectionAlreadyConnectedToAnotherUser();
        }
        oauthAccountId = existingAccount.id;
      } else {
        const newOAuthAccount = await createProjectUserOAuthAccountForLink(prisma, {
          tenancyId: tenancy.id,
          providerId: action.providerId,
          providerAccountId: action.providerAccountId,
          email: action.email,
          projectUserId,
        });
        oauthAccountId = newOAuthAccount.id;
      }
      await storeOAuthProviderTokens(prisma, { tenancyId: tenancy.id, oauthAccountId, providerTokens: action.providerTokens });
      return;
    }
    case "upgrade-anonymous-user": {
      if (existingAccount) {
        // Someone signed up with this provider account between /callback and /token.
        throw new KnownErrors.OAuthConnectionAlreadyConnectedToAnotherUser();
      }
      const currentUser = await usersCrudHandlers.adminRead({ tenancy, user_id: projectUserId });
      if (!currentUser.is_anonymous) {
        // createOAuthUserAndAccount would create a brand-new user instead of upgrading this one, which wouldn't
        // match the user ID the authorization code (and thus the issued tokens) were bound to.
        throw new StatusError(409, "The anonymous user was upgraded by another request during the OAuth flow. Please try signing in again.");
      }
      const result = await createOAuthUserAndAccountWithEvaluatedSignUp(prisma, tenancy, {
        providerId: action.providerId,
        providerAccountId: action.providerAccountId,
        email: action.email,
        emailVerified: action.emailVerified,
        primaryEmailAuthEnabled: action.primaryEmailAuthEnabled,
        currentUser,
        displayName: action.displayName,
        profileImageUrl: action.profileImageUrl,
        evaluatedSignUp: action.evaluatedSignUp,
      });
      if (result.projectUserId !== projectUserId) {
        throw new HexclaveAssertionError("Upgrading an anonymous user via OAuth produced a different user ID", { expected: projectUserId, actual: result.projectUserId });
      }
      await storeOAuthProviderTokens(prisma, { tenancyId: tenancy.id, oauthAccountId: result.oauthAccountId, providerTokens: action.providerTokens });
      logSignInAttemptInBackground(tenancy, {
        outcome: "success",
        method: "oauth",
        oauthProvider: action.providerId,
        email: action.email,
        userId: projectUserId,
      });
      return;
    }
  }
}
