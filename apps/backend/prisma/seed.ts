/* eslint-disable no-restricted-syntax */
import { usersCrudHandlers } from '@/app/api/latest/users/crud';
import { CustomerType, Prisma, PurchaseCreationSource, SubscriptionStatus } from '@/generated/prisma/client';
import { overrideBranchConfigOverride } from '@/lib/config';
import { ensurePermissionDefinition, grantTeamPermission } from '@/lib/permissions';
import { createOrUpdateProjectWithLegacyConfig, getProject } from '@/lib/projects';
import { seedDummyProject } from '@/lib/seed-dummy-data';
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch } from '@/lib/tenancies';
import { getPrismaClientForTenancy, globalPrismaClient } from '@/prisma-client';
import { ALL_APPS } from '@hexclave/shared/dist/apps/apps-config';
import { DEFAULT_EMAIL_THEME_ID } from '@hexclave/shared/dist/helpers/emails';
import { AdminUserProjectsCrud } from '@hexclave/shared/dist/interface/crud/projects';
import { ITEM_IDS, PLAN_LIMITS } from '@hexclave/shared/dist/plans';
import { DayInterval } from '@hexclave/shared/dist/utils/dates';
import { getEnvVariable } from '@hexclave/shared/dist/utils/env';
import { throwErr } from '@hexclave/shared/dist/utils/errors';
import { typedEntries, typedFromEntries } from '@hexclave/shared/dist/utils/objects';
import { resolveInternalProjectKeyAlias } from './seed-env';

const MONTHLY_REPEAT: DayInterval = [1, "month"];

const DUMMY_PROJECT_ID = '6fbbf22e-f4b2-4c6e-95a1-beab6fa41063';
const DEVELOPMENT_ENVIRONMENT_PROJECT_ID = '5f2a45c8-9096-4f0b-b987-7640a47f7a79';

let didEnableSeedLogTimestamps = false;

function enableSeedLogTimestamps() {
  if (didEnableSeedLogTimestamps) return;
  didEnableSeedLogTimestamps = true;

  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);

  const withTimestamp = (...data: unknown[]) => [`[${new Date().toISOString()}]`, ...data];

  console.log = (...data: Parameters<typeof console.log>) => {
    originalLog(...withTimestamp(...data));
  };
  console.info = (...data: Parameters<typeof console.info>) => {
    originalInfo(...withTimestamp(...data));
  };
  console.warn = (...data: Parameters<typeof console.warn>) => {
    originalWarn(...withTimestamp(...data));
  };
  console.error = (...data: Parameters<typeof console.error>) => {
    originalError(...withTimestamp(...data));
  };
}

export async function seed() {
  enableSeedLogTimestamps();
  process.env.HEXCLAVE_SEED_MODE = 'true';
  console.log('Seeding database...');

  // Optional default admin user
  const adminEmail = getEnvVariable("STACK_SEED_INTERNAL_PROJECT_USER_EMAIL", "");
  const adminPassword = getEnvVariable("STACK_SEED_INTERNAL_PROJECT_USER_PASSWORD", "");
  const adminInternalAccess = getEnvVariable("STACK_SEED_INTERNAL_PROJECT_USER_INTERNAL_ACCESS", "") === 'true';
  const adminGithubId = getEnvVariable("STACK_SEED_INTERNAL_PROJECT_USER_GITHUB_ID", "");

  // dashboard settings
  const dashboardDomain = getEnvVariable("NEXT_PUBLIC_STACK_DASHBOARD_URL", "");
  const rawOauthProviderIds = getEnvVariable("STACK_SEED_INTERNAL_PROJECT_OAUTH_PROVIDERS", "");
  const oauthProviderIds = rawOauthProviderIds ? rawOauthProviderIds.split(',') : [];
  const otpEnabled = getEnvVariable("STACK_SEED_INTERNAL_PROJECT_OTP_ENABLED", "") === 'true';
  const signUpEnabled = getEnvVariable("STACK_SEED_INTERNAL_PROJECT_SIGN_UP_ENABLED", "") === 'true';
  const allowLocalhost = getEnvVariable("STACK_SEED_INTERNAL_PROJECT_ALLOW_LOCALHOST", "") === 'true';

  const apiKeyId = '3142e763-b230-44b5-8636-aa62f7489c26';
  const defaultUserId = '33e7c043-d2d1-4187-acd3-f91b5ed64b46';
  const internalTeamId = 'a23e1b7f-ab18-41fc-9ee6-7a9ca9fa543c';
  let internalProject = await getProject('internal');

  if (!internalProject) {
    internalProject = await createOrUpdateProjectWithLegacyConfig({
      type: 'create',
      projectId: 'internal',
      data: {
        display_name: 'Hexclave Dashboard',
        owner_team_id: internalTeamId,
        description: 'Hexclave\'s admin dashboard',
        is_production_mode: false,
        config: {
          allow_localhost: true,
          oauth_providers: oauthProviderIds.map((id) => ({
            id: id as any,
            type: 'shared',
          })),
          sign_up_enabled: signUpEnabled,
          credential_enabled: true,
          magic_link_enabled: otpEnabled,
        },
      },
    });

    console.log('Internal project created');
  }

  const internalTenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID);
  const internalPrisma = await getPrismaClientForTenancy(internalTenancy);

  internalProject = await createOrUpdateProjectWithLegacyConfig({
    projectId: 'internal',
    branchId: DEFAULT_BRANCH_ID,
    type: 'update',
    data: {
      config: {
        create_team_on_sign_up: true,
        sign_up_enabled: signUpEnabled,
        magic_link_enabled: otpEnabled,
        allow_localhost: allowLocalhost,
        client_team_creation_enabled: true,
        domains: [
          ...(dashboardDomain && new URL(dashboardDomain).hostname !== 'localhost' ? [{ domain: dashboardDomain, handler_path: '/handler' }] : []),
          ...Object.values(internalTenancy.config.domains.trustedDomains)
            .filter((d) => d.baseUrl !== dashboardDomain && d.baseUrl)
            .map((d) => ({ domain: d.baseUrl || throwErr('Domain base URL is required'), handler_path: d.handlerPath })),
        ],
      },
    },
  });

  await overrideBranchConfigOverride({
    projectId: 'internal',
    branchId: DEFAULT_BRANCH_ID,
    branchConfigOverrideOverride: {
      // Disable email verification for internal project - dashboard admins shouldn't need to verify their email
      onboarding: {
        requireEmailVerification: false,
      },
      dataVault: {
        stores: {
          'neon-connection-strings': {
            displayName: 'Neon Connection Strings',
          }
        }
      },
      payments: {
        productLines: {
          plans: {
            displayName: "Plans",
            customerType: "team",
          },
        },
        products: {
          free: {
            productLineId: "plans",
            displayName: "Free",
            customerType: "team",
            serverOnly: false,
            stackable: false,
            prices: {
              "free-monthly": {
                USD: "0",
                interval: [1, "month"] as any,
              },
            },
            includedItems: {
              [ITEM_IDS.seats]: { quantity: PLAN_LIMITS.free.seats, repeat: "never" as const, expires: "when-purchase-expires" as const },
              [ITEM_IDS.authUsers]: { quantity: PLAN_LIMITS.free.authUsers, repeat: "never" as const, expires: "when-purchase-expires" as const },
              [ITEM_IDS.emailsPerMonth]: { quantity: PLAN_LIMITS.free.emailsPerMonth, repeat: MONTHLY_REPEAT, expires: "when-repeated" as const },
              [ITEM_IDS.analyticsTimeoutSeconds]: { quantity: PLAN_LIMITS.free.analyticsTimeoutSeconds, repeat: "never" as const, expires: "when-purchase-expires" as const },
              [ITEM_IDS.analyticsEvents]: { quantity: PLAN_LIMITS.free.analyticsEvents, repeat: MONTHLY_REPEAT, expires: "when-repeated" as const },
              [ITEM_IDS.sessionReplays]: { quantity: PLAN_LIMITS.free.sessionReplays, repeat: MONTHLY_REPEAT, expires: "when-repeated" as const },
            },
          },
          team: {
            productLineId: "plans",
            displayName: "Team",
            customerType: "team",
            serverOnly: false,
            stackable: false,
            prices: {
              monthly: {
                USD: "49",
                interval: MONTHLY_REPEAT,
                serverOnly: false,
              },
            },
            includedItems: {
              [ITEM_IDS.seats]: { quantity: PLAN_LIMITS.team.seats, repeat: "never" as const, expires: "when-purchase-expires" as const },
              [ITEM_IDS.authUsers]: { quantity: PLAN_LIMITS.team.authUsers, repeat: "never" as const, expires: "when-purchase-expires" as const },
              [ITEM_IDS.emailsPerMonth]: { quantity: PLAN_LIMITS.team.emailsPerMonth, repeat: MONTHLY_REPEAT, expires: "when-repeated" as const },
              [ITEM_IDS.analyticsTimeoutSeconds]: { quantity: PLAN_LIMITS.team.analyticsTimeoutSeconds, repeat: "never" as const, expires: "when-purchase-expires" as const },
              [ITEM_IDS.analyticsEvents]: { quantity: PLAN_LIMITS.team.analyticsEvents, repeat: MONTHLY_REPEAT, expires: "when-repeated" as const },
              [ITEM_IDS.sessionReplays]: { quantity: PLAN_LIMITS.team.sessionReplays, repeat: MONTHLY_REPEAT, expires: "when-repeated" as const },
              [ITEM_IDS.onboardingCall]: { quantity: 1, repeat: "never" as const, expires: "when-purchase-expires" as const },
            },
          },
          growth: {
            productLineId: "plans",
            displayName: "Growth",
            customerType: "team",
            serverOnly: false,
            stackable: false,
            prices: {
              monthly: {
                USD: "299",
                interval: MONTHLY_REPEAT,
                serverOnly: false,
              },
            },
            includedItems: {
              [ITEM_IDS.seats]: { quantity: PLAN_LIMITS.growth.seats, repeat: "never" as const, expires: "when-purchase-expires" as const },
              [ITEM_IDS.authUsers]: { quantity: PLAN_LIMITS.growth.authUsers, repeat: "never" as const, expires: "when-purchase-expires" as const },
              [ITEM_IDS.emailsPerMonth]: { quantity: PLAN_LIMITS.growth.emailsPerMonth, repeat: MONTHLY_REPEAT, expires: "when-repeated" as const },
              [ITEM_IDS.analyticsTimeoutSeconds]: { quantity: PLAN_LIMITS.growth.analyticsTimeoutSeconds, repeat: "never" as const, expires: "when-purchase-expires" as const },
              [ITEM_IDS.analyticsEvents]: { quantity: PLAN_LIMITS.growth.analyticsEvents, repeat: MONTHLY_REPEAT, expires: "when-repeated" as const },
              [ITEM_IDS.sessionReplays]: { quantity: PLAN_LIMITS.growth.sessionReplays, repeat: MONTHLY_REPEAT, expires: "when-repeated" as const },
              [ITEM_IDS.onboardingCall]: { quantity: 1, repeat: "never" as const, expires: "when-purchase-expires" as const },
            },
          },
          "extra-seats": {
            productLineId: "plans",
            displayName: "Extra Seats",
            customerType: "team",
            serverOnly: false,
            stackable: true,
            prices: {
              monthly: {
                USD: "29",
                interval: MONTHLY_REPEAT,
                serverOnly: false,
              },
            },
            includedItems: {
              [ITEM_IDS.seats]: { quantity: 1, repeat: "never" as const, expires: "when-purchase-expires" as const },
            },
            isAddOnTo: {
              team: true,
              growth: true,
            },
          },
        },
        items: {
          [ITEM_IDS.seats]: { displayName: "Dashboard Admins", customerType: "team" as const },
          [ITEM_IDS.authUsers]: { displayName: "Auth Users", customerType: "team" as const },
          [ITEM_IDS.emailsPerMonth]: { displayName: "Emails per Month", customerType: "team" as const },
          [ITEM_IDS.analyticsTimeoutSeconds]: { displayName: "Analytics Timeout (seconds)", customerType: "team" as const },
          [ITEM_IDS.analyticsEvents]: { displayName: "Analytics Events", customerType: "team" as const },
          [ITEM_IDS.sessionReplays]: { displayName: "Session Replays", customerType: "team" as const },
          [ITEM_IDS.onboardingCall]: { displayName: "Onboarding Call", customerType: "team" as const },
        },
      },
      apps: {
        installed: typedFromEntries(typedEntries(ALL_APPS).map(([key, value]) => [key, { enabled: true }])),
      },
    }
  });

  await ensurePermissionDefinition(
    globalPrismaClient,
    internalPrisma,
    {
      id: "team_member",
      scope: "team",
      tenancy: internalTenancy,
      data: {
        description: "1",
        contained_permission_ids: ["$read_members"],
      }
    }
  );
  const updatedInternalTenancy = await getSoleTenancyFromProjectBranch("internal", DEFAULT_BRANCH_ID);
  await ensurePermissionDefinition(
    globalPrismaClient,
    internalPrisma,
    {
      id: "team_admin",
      scope: "team",
      tenancy: updatedInternalTenancy,
      data: {
        description: "2",
        contained_permission_ids: ["$read_members", "$remove_members", "$update_team"],
      }
    }
  );


  const internalTeam = await internalPrisma.team.findUnique({
    where: {
      tenancyId_teamId: {
        tenancyId: internalTenancy.id,
        teamId: internalTeamId,
      },
    },
  });
  if (!internalTeam) {
    await internalPrisma.team.create({
      data: {
        tenancyId: internalTenancy.id,
        teamId: internalTeamId,
        displayName: 'Internal Team',
        mirroredProjectId: 'internal',
        mirroredBranchId: DEFAULT_BRANCH_ID,
      },
    });
    console.log('Internal team created');
  }

  // The team-create CRUD path auto-grants the free plan to every team in the
  // internal project, but the internal team itself is written directly above
  // (bypassing that code path), so it would otherwise end up with zero
  // entitlements and trip the plan-limit enforcement. Grant it the Growth plan
  // so Hexclave employees using the dashboard get full quotas. Idempotent —
  // skipped if an active Growth subscription already exists.
  //
  // We create the subscription with raw Prisma (matching seed-dummy-data.ts)
  // rather than grantProductToCustomer because bulldozer storage tables
  // aren't initialized at this point in the seed yet. The row is ingressed into
  // bulldozer later by the explicit db:backfill-bulldozer-from-prisma step.
  const growthProduct = updatedInternalTenancy.config.payments.products.growth;
  if (growthProduct.customerType === 'team') {
    const existingGrowthSub = await internalPrisma.subscription.findFirst({
      where: {
        tenancyId: internalTenancy.id,
        customerId: internalTeamId,
        customerType: CustomerType.TEAM,
        productId: 'growth',
        status: SubscriptionStatus.active,
      },
    });
    if (!existingGrowthSub) {
      const firstPriceId = Object.keys(growthProduct.prices)[0];
      if (!firstPriceId) {
        throw new Error("Internal seed invariant violated: the Growth product must have at least one price configured before seeding the internal team subscription.");
      }
      const now = new Date();
      // Clone to ensure the stored JSON snapshot is independent of the config object
      // (mirrors the pattern used in seed-dummy-data.ts).
      // SAFETY: growthProduct is a normalized config product made entirely of
      // Prisma JSON-compatible primitives; the clone preserves that shape.
      const storedProduct = JSON.parse(JSON.stringify(growthProduct)) as Prisma.InputJsonValue;
      // Mirror what a real Stripe checkout would produce, based on whether
      // the internal project is running in test mode.
      const creationSource = updatedInternalTenancy.config.payments.testMode
        ? PurchaseCreationSource.TEST_MODE
        : PurchaseCreationSource.PURCHASE_PAGE;
      await internalPrisma.subscription.create({
        data: {
          tenancyId: internalTenancy.id,
          customerId: internalTeamId,
          customerType: CustomerType.TEAM,
          status: SubscriptionStatus.active,
          productId: 'growth',
          priceId: firstPriceId,
          product: storedProduct,
          quantity: 1,
          currentPeriodStart: now,
          currentPeriodEnd: new Date('2099-12-31T23:59:59Z'),
          cancelAtPeriodEnd: false,
          creationSource,
        },
      });
      console.log('Granted Growth plan to internal team');
    }
  }

  // Upsert the internal API key set before any flake-prone work (dummy-project
  // seed, email/svix, clickhouse).
  const rawPck = resolveInternalProjectKeyAlias(
    "STACK_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY",
    "STACK_SEED_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY",
    getEnvVariable("STACK_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY", ""),
    getEnvVariable("STACK_SEED_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY", ""),
  );
  const rawSsk = resolveInternalProjectKeyAlias(
    "STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY",
    "STACK_SEED_INTERNAL_PROJECT_SECRET_SERVER_KEY",
    getEnvVariable("STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY", ""),
    getEnvVariable("STACK_SEED_INTERNAL_PROJECT_SECRET_SERVER_KEY", ""),
  );
  const rawAdminKey = getEnvVariable("STACK_SEED_INTERNAL_PROJECT_SUPER_SECRET_ADMIN_KEY", "");
  const hasAnyKey = rawPck !== "" || rawSsk !== "" || rawAdminKey !== "";
  const hasAllKeys = rawPck !== "" && rawSsk !== "" && rawAdminKey !== "";

  if (hasAnyKey && !hasAllKeys) {
    throwErr('HEXCLAVE internal API key bootstrap requires STACK_INTERNAL_PROJECT_PUBLISHABLE_CLIENT_KEY, STACK_INTERNAL_PROJECT_SECRET_SERVER_KEY, and STACK_SEED_INTERNAL_PROJECT_SUPER_SECRET_ADMIN_KEY together');
  }

  if (hasAllKeys) {
    const keySet = {
      publishableClientKey: rawPck,
      secretServerKey: rawSsk,
      superSecretAdminKey: rawAdminKey,
    };

    await globalPrismaClient.apiKeySet.upsert({
      where: { projectId_id: { projectId: 'internal', id: apiKeyId } },
      update: {
        ...keySet,
      },
      create: {
        id: apiKeyId,
        projectId: 'internal',
        description: "Internal API key set",
        expiresAt: new Date('2099-12-31T23:59:59Z'),
        ...keySet,
      }
    });

    console.log('Updated internal API key set');
  } else {
    console.log('Skipped internal API key set bootstrap');
  }

  const shouldSeedDummyProject = getEnvVariable("STACK_SEED_ENABLE_DUMMY_PROJECT", "") === 'true';
  if (shouldSeedDummyProject) {
    await seedDummyProject({
      projectId: DUMMY_PROJECT_ID,
      ownerTeamId: internalTeamId,
      oauthProviderIds,
    });
  }

  const developmentEnvironmentProjectData = {
    display_name: 'Development Environment Project',
    description: 'Seeded project for debugging development-environment dashboard behavior.',
    is_production_mode: false,
    is_development_environment: true,
    owner_team_id: internalTeamId,
    config: {
      allow_localhost: true,
      sign_up_enabled: true,
      credential_enabled: true,
      magic_link_enabled: true,
      passkey_enabled: true,
      client_team_creation_enabled: true,
      client_user_deletion_enabled: true,
      allow_user_api_keys: true,
      allow_team_api_keys: true,
      create_team_on_sign_up: false,
      email_theme: DEFAULT_EMAIL_THEME_ID,
      email_config: {
        type: 'shared',
      },
      oauth_providers: oauthProviderIds.map((id) => ({
        id: id as any,
        type: 'shared',
      })),
      domains: [],
    },
  } satisfies AdminUserProjectsCrud["Admin"]["Create"];
  if (await getProject(DEVELOPMENT_ENVIRONMENT_PROJECT_ID)) {
    await createOrUpdateProjectWithLegacyConfig({
      type: 'update',
      projectId: DEVELOPMENT_ENVIRONMENT_PROJECT_ID,
      branchId: DEFAULT_BRANCH_ID,
      data: developmentEnvironmentProjectData,
    });
  } else {
    await createOrUpdateProjectWithLegacyConfig({
      type: 'create',
      projectId: DEVELOPMENT_ENVIRONMENT_PROJECT_ID,
      data: developmentEnvironmentProjectData,
    });
  }

  // Create optional default admin user if credentials are provided.
  // This user will be able to login to the dashboard with both email/password and magic link.

  if ((adminEmail && adminPassword) || adminGithubId) {
    const oldAdminUser = await internalPrisma.projectUser.findFirst({
      where: {
        mirroredProjectId: 'internal',
        mirroredBranchId: DEFAULT_BRANCH_ID,
        projectUserId: defaultUserId
      }
    });

    if (oldAdminUser) {
      console.log(`Admin user already exists, skipping creation`);
    } else {
      const newUser = await internalPrisma.projectUser.create({
        data: {
          displayName: 'Administrator (created by seed script)',
          projectUserId: defaultUserId,
          tenancyId: internalTenancy.id,
          mirroredProjectId: 'internal',
          mirroredBranchId: DEFAULT_BRANCH_ID,
          signedUpAt: new Date(),
          signUpRiskScoreBot: 0,
          signUpRiskScoreFreeTrialAbuse: 0,
        }
      });

      // Note: TeamMember creation is handled by the upsert below (after this if/else block)
      // to ensure idempotency when adminInternalAccess changes between runs

      if (adminEmail && adminPassword) {
        await usersCrudHandlers.adminUpdate({
          tenancy: internalTenancy,
          user_id: defaultUserId,
          data: {
            password: adminPassword,
            primary_email: adminEmail,
            primary_email_auth_enabled: true,
          },
        });

        console.log(`Added admin user with email ${adminEmail}`);
      }

      if (adminGithubId) {
        const githubAccount = await internalPrisma.projectUserOAuthAccount.findFirst({
          where: {
            tenancyId: internalTenancy.id,
            configOAuthProviderId: 'github',
            providerAccountId: adminGithubId,
          }
        });

        if (githubAccount) {
          console.log(`GitHub account already exists, skipping creation`);
        } else {
          await internalPrisma.projectUserOAuthAccount.create({
            data: {
              tenancyId: internalTenancy.id,
              projectUserId: newUser.projectUserId,
              configOAuthProviderId: 'github',
              providerAccountId: adminGithubId
            }
          });

          await internalPrisma.authMethod.create({
            data: {
              tenancyId: internalTenancy.id,
              projectUserId: newUser.projectUserId,
              oauthAuthMethod: {
                create: {
                  projectUserId: newUser.projectUserId,
                  configOAuthProviderId: 'github',
                  providerAccountId: adminGithubId,
                }
              }
            }
          });

          console.log(`Added admin user with GitHub ID ${adminGithubId}`);
        }
      }
    }

    // Create or ensure TeamMember exists before granting permissions.
    // Using upsert here (instead of create inside the else block above) ensures
    // idempotency when adminInternalAccess changes between seed runs.
    if (adminInternalAccess) {
      await internalPrisma.teamMember.upsert({
        where: {
          tenancyId_projectUserId_teamId: {
            tenancyId: internalTenancy.id,
            projectUserId: defaultUserId,
            teamId: internalTeamId,
          },
        },
        create: {
          tenancyId: internalTenancy.id,
          teamId: internalTeamId,
          projectUserId: defaultUserId,
        },
        update: {},
      });

      await grantTeamPermission(internalPrisma, {
        tenancy: internalTenancy,
        teamId: internalTeamId,
        userId: defaultUserId,
        permissionId: "team_admin",
      });
    }
  }

  console.log('Seeding complete!');
}
