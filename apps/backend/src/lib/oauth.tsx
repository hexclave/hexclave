import { getAuthContactChannelWithEmailNormalization } from "@/lib/contact-channel";
import { Tenancy } from "@/lib/tenancies";
import { createOrUpgradeAnonymousUserWithRules, SignUpRuleOptions } from "@/lib/users";
import { PrismaClientTransaction } from "@/prisma-client";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { captureError, HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";

/**
 * Find an existing OAuth account for sign-in.
 *
 * @returns The existing account if found, or null if no account exists
 * @throws HexclaveAssertionError if multiple accounts are found (should never happen)
 */
export async function findExistingOAuthAccount(
  prisma: PrismaClientTransaction,
  tenancyId: string,
  providerId: string,
  providerAccountId: string,
) {
  const existingAccounts = await prisma.projectUserOAuthAccount.findMany({
    where: {
      tenancyId,
      configOAuthProviderId: providerId,
      providerAccountId,
      allowSignIn: true,
    },
  });

  if (existingAccounts.length > 1) {
    throw new HexclaveAssertionError("Multiple accounts found for the same provider and account ID", {
      providerId,
      providerAccountId,
    });
  }

  const account = existingAccounts[0];
  return account ?? null;
}

/**
 * Get the project user ID from an OAuth account, throwing if it doesn't exist.
 */
export function getProjectUserIdFromOAuthAccount(
  account: Awaited<ReturnType<typeof findExistingOAuthAccount>>
): string {
  if (!account) {
    throw new HexclaveAssertionError("OAuth account is null");
  }
  return account.projectUserId ?? throwErr("OAuth account exists but has no associated user");
}

/**
 * Handle the OAuth email merge strategy.
 *
 * This determines whether a new OAuth sign-up should be linked to an existing user
 * based on email address, according to the project's merge strategy setting.
 *
 * @returns linkedUserId - The user ID to link to, or null if creating a new user
 * @returns primaryEmailAuthEnabled - Whether the email should be used for auth
 */
export async function handleOAuthEmailMergeStrategy(
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  email: string,
  emailVerified: boolean,
): Promise<{ linkedUserId: string | null, primaryEmailAuthEnabled: boolean }> {
  let primaryEmailAuthEnabled = true;
  let linkedUserId: string | null = null;

  const existingContactChannel = await getAuthContactChannelWithEmailNormalization(
    prisma,
    {
      tenancyId: tenancy.id,
      type: "EMAIL",
      value: email,
    }
  );

  // Check if we should link this OAuth account to an existing user based on email
  if (existingContactChannel && existingContactChannel.usedForAuth) {
    const accountMergeStrategy = tenancy.config.auth.oauth.accountMergeStrategy;
    switch (accountMergeStrategy) {
      case "link_method": {
        if (!existingContactChannel.isVerified) {
          throw new KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse("email", email, true);
        }

        if (!emailVerified) {
          // TODO: Handle this case
          const err = new HexclaveAssertionError(
            "OAuth account merge strategy is set to link_method, but the NEW email is not verified. This is an edge case that we don't handle right now",
            { existingContactChannel, email, emailVerified }
          );
          captureError("oauth-link-method-email-not-verified", err);
          throw new KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse("email", email);
        }

        // Link to existing user
        linkedUserId = existingContactChannel.projectUserId;
        break;
      }
      case "raise_error": {
        throw new KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse("email", email);
      }
      case "allow_duplicates": {
        primaryEmailAuthEnabled = false;
        break;
      }
    }
  }

  return { linkedUserId, primaryEmailAuthEnabled };
}

/**
 * Link an OAuth account to an existing user.
 *
 * This is used when the email merge strategy determines that a new OAuth sign-in
 * should be linked to an existing user account.
 *
 * Creates:
 * - OAuth account record (connected to the existing user)
 * - Auth method record with nested oauthAuthMethod
 *
 * @returns oauthAccountId - The ID of the created OAuth account
 */
export async function linkOAuthAccountToUser(
  prisma: PrismaClientTransaction,
  params: {
    tenancyId: string,
    providerId: string,
    providerAccountId: string,
    email: string | null,
    projectUserId: string,
  }
): Promise<{ oauthAccountId: string }> {
  // Create OAuth account link
  const oauthAccount = await prisma.projectUserOAuthAccount.create({
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

  // Create auth method for the linked user
  await prisma.authMethod.create({
    data: {
      tenancyId: params.tenancyId,
      projectUserId: params.projectUserId,
      oauthAuthMethod: {
        create: {
          projectUserId: params.projectUserId,
          configOAuthProviderId: params.providerId,
          providerAccountId: params.providerAccountId,
        }
      }
    }
  });

  return { oauthAccountId: oauthAccount.id };
}

/**
 * Create a new user and OAuth account.
 *
 * This is used when a new OAuth sign-up should create a new user account.
 *
 * Creates:
 * - User record (via createOrUpgradeAnonymousUserWithRules)
 * - Auth method record
 * - OAuth account record with nested oauthAuthMethod
 *
 * @returns projectUserId - The ID of the created user
 * @returns oauthAccountId - The ID of the created OAuth account
 */
export async function createOAuthUserAndAccount(
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  params: {
    providerId: string,
    providerAccountId: string,
    email: string | null,
    emailVerified: boolean,
    primaryEmailAuthEnabled: boolean,
    currentUser: UsersCrud["Admin"]["Read"] | null,
    displayName: string | null,
    profileImageUrl: string | null,
    signUpRuleOptions: SignUpRuleOptions,
  }
): Promise<{ projectUserId: string, oauthAccountId: string }> {
  // Check if sign up is allowed
  if (!tenancy.config.auth.allowSignUp) {
    throw new KnownErrors.SignUpNotEnabled();
  }

  // Create new user (or upgrade anonymous user) with sign-up rule evaluation
  const newUser = await createOrUpgradeAnonymousUserWithRules(
    tenancy,
    params.currentUser,
    {
      display_name: params.displayName,
      profile_image_url: params.profileImageUrl,
      primary_email: params.email,
      primary_email_verified: params.emailVerified,
      primary_email_auth_enabled: params.primaryEmailAuthEnabled,
    },
    [],
    params.signUpRuleOptions,
  );

  // Create auth method
  const authMethod = await prisma.authMethod.create({
    data: {
      tenancyId: tenancy.id,
      projectUserId: newUser.id,
    }
  });

  // Create OAuth account link
  const oauthAccount = await prisma.projectUserOAuthAccount.create({
    data: {
      tenancyId: tenancy.id,
      configOAuthProviderId: params.providerId,
      providerAccountId: params.providerAccountId,
      email: params.email,
      projectUserId: newUser.id,
      oauthAuthMethod: {
        create: {
          authMethodId: authMethod.id,
        }
      },
      allowConnectedAccounts: true,
      allowSignIn: true,
    },
  });

  return { projectUserId: newUser.id, oauthAccountId: oauthAccount.id };
}
