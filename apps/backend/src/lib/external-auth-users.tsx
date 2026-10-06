import { usersCrudHandlers } from "@/app/api/latest/users/crud";
import { getBestEffortEndUserRequestContext } from "@/lib/end-users";
import { ExternalAuthProviderId, VerifiedExternalIdentity } from "@/lib/external-auth";
import { buildSignUpRuleOptions } from "@/lib/sign-up-context";
import { Tenancy } from "@/lib/tenancies";
import { getDisabledBotChallengeAssessment } from "@/lib/turnstile";
import { createOrUpgradeAnonymousUserWithRules } from "@/lib/users";
import { getPrismaClientForTenancy, PRISMA_ERROR_CODES } from "@/prisma-client";
import { Prisma } from "@/generated/prisma/client";
import { KnownErrors } from "@hexclave/shared";
import type { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { throwErr } from "@hexclave/shared/dist/utils/errors";

export async function getOrCreateExternalAuthSession(options: {
  tenancy: Tenancy,
  providerId: ExternalAuthProviderId,
  identity: VerifiedExternalIdentity,
  currentUser: UsersCrud["Admin"]["Read"] | null,
}) {
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const identityWhere = {
    tenancyId: options.tenancy.id,
    providerConfigId: options.providerId,
    issuer: options.identity.issuer,
    subject: options.identity.subject,
  };

  // A returning user's identity may have been committed by an earlier request from this same user,
  // which the automatic replication wait does not cover, so this lookup cannot tolerate replica lag.
  let authMethod = await prisma.$primary().externalAuthMethod.findFirst({ where: identityWhere });
  let isNewUser = false;

  if (authMethod == null) {
    if (!options.tenancy.config.auth.allowSignUp) {
      throw new KnownErrors.SignUpNotEnabled();
    }
    const requestContext = await getBestEffortEndUserRequestContext();
    // User creation commits its own transactions and side effects (sign-up events, webhooks, external
    // DB sync), so wrapping it together with the auth method creation in a transaction would not make
    // the combination atomic anyway — it would only add retry hazards (a retried wrapper re-runs the
    // already-committed user creation and produces duplicate users). Instead, we create the user
    // first and resolve the (rare) concurrent-first-exchange race below via the identity's unique
    // constraint, cleaning up our user if we lost.
    // Provider claims are mapped only here, while creating the user: a returning exchange must not
    // overwrite a profile the end user or an admin edited in the meantime.
    const profile = options.currentUser?.is_anonymous === true
      ? {
        display_name: options.identity.name ?? options.currentUser.display_name,
        primary_email: options.identity.email ?? options.currentUser.primary_email,
        primary_email_verified: options.identity.email == null
          ? options.currentUser.primary_email_verified
          : options.identity.emailVerified,
        primary_email_auth_enabled: options.identity.email == null
          ? options.currentUser.primary_email_auth_enabled
          : false,
      }
      : {
        display_name: options.identity.name,
        primary_email: options.identity.email,
        primary_email_verified: options.identity.email == null ? false : options.identity.emailVerified,
        // The provider owns authentication for this identity, so its address must never become a
        // Hexclave password or OTP login identity of its own.
        primary_email_auth_enabled: false,
      };
    const user = await createOrUpgradeAnonymousUserWithRules(
      options.tenancy,
      options.currentUser?.is_anonymous === true ? options.currentUser : null,
      profile,
      [],
      buildSignUpRuleOptions({
        // External identity providers follow the existing federated sign-up rule path.
        authMethod: "oauth",
        oauthProvider: options.providerId,
        // The external provider's account creation time is not part of the verified identity, so
        // account-age risk rules must treat it as unknown rather than guess.
        oauthAccountCreatedAtMillis: null,
        requestContext,
        turnstileAssessment: getDisabledBotChallengeAssessment(),
      }),
    );

    try {
      // Nested create so the base AuthMethod and the identity projection are inserted atomically —
      // losing the uniqueness race can then never leave behind a dangling AuthMethod row.
      const baseAuthMethod = await prisma.authMethod.create({
        data: {
          tenancyId: options.tenancy.id,
          projectUserId: user.id,
          externalAuthMethod: {
            create: {
              providerConfigId: options.providerId,
              issuer: options.identity.issuer,
              subject: options.identity.subject,
            },
          },
        },
        include: {
          externalAuthMethod: true,
        },
      });
      authMethod = baseAuthMethod.externalAuthMethod ?? throwErr("The nested create should have created the external auth method");
      isNewUser = options.currentUser?.id !== user.id;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== PRISMA_ERROR_CODES.UNIQUE_CONSTRAINT_VIOLATION) {
        throw error;
      }
      // A concurrent first exchange projected the same provider identity between our lookup and our
      // insert. Use the winner's projection and sign into its user instead. This read must go to the
      // primary: the winner's row was committed by a concurrent request, so the read replica may not
      // have caught up yet (the automatic replication wait only covers writes made by ourselves).
      authMethod = await prisma.$primary().externalAuthMethod.findFirst({ where: identityWhere });
      if (authMethod == null) {
        // This is the per-user/provider constraint: the anonymous user already won a different
        // identity for this provider.
        throw new KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn();
      }
      // The user we just created will never be linked to anything, so delete it again — unless it is
      // the caller's own (formerly anonymous, now upgraded) user, which we must not destroy.
      if (options.currentUser?.id !== user.id && authMethod.projectUserId !== user.id) {
        await usersCrudHandlers.adminDelete({
          tenancy: options.tenancy,
          user_id: user.id,
        });
      }
    }
  }

  const session = await prisma.externalAuthSession.upsert({
    where: {
      tenancyId_externalAuthMethodId_providerSessionId: {
        tenancyId: options.tenancy.id,
        externalAuthMethodId: authMethod.authMethodId,
        providerSessionId: options.identity.providerSessionId,
      },
    },
    create: {
      tenancyId: options.tenancy.id,
      externalAuthMethodId: authMethod.authMethodId,
      providerSessionId: options.identity.providerSessionId,
    },
    // Provider verification is the source of truth for this identity, so a fresh valid JWT
    // re-establishes a Hexclave session after a Hexclave-side revocation.
    update: {
      revokedAt: null,
    },
  });

  return {
    authMethod,
    session,
    isNewUser,
  };
}
