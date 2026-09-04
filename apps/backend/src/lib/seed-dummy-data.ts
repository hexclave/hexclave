/* eslint-disable no-restricted-syntax */
import { teamsCrudHandlers } from '@/app/api/latest/teams/crud';
import { BooleanTrue, ContactChannelType, CustomerType, EmailOutboxCreatedWith, Prisma, PurchaseCreationSource, SubscriptionStatus } from '@/generated/prisma/client';
import { getClickhouseAdminClient, type ClickHouseClient } from '@/lib/clickhouse';
import { overrideBranchConfigOverride, overrideEnvironmentConfigOverride, setBranchConfigOverrideSource } from '@/lib/config';
import { isPreviewModeEnabled } from '@/lib/preview-mode';
import { createOrUpdateProjectWithLegacyConfig, getProject } from '@/lib/projects';
import { DEFAULT_BRANCH_ID, getSoleTenancyFromProjectBranch, type Tenancy } from '@/lib/tenancies';
import { getPrismaClientForTenancy, globalPrismaClient, retryTransaction, type PrismaClientTransaction } from '@/prisma-client';
import { runAsynchronouslyAndWaitUntil } from '@/utils/background-tasks';
import { ALL_APPS } from '@hexclave/shared/dist/apps/apps-config';
import { type Config } from '@hexclave/shared/dist/config/format';
import { DEFAULT_EMAIL_THEME_ID } from '@hexclave/shared/dist/helpers/emails';
import { type AdminUserProjectsCrud, type ProjectsCrud } from '@hexclave/shared/dist/interface/crud/projects';
import { DayInterval } from '@hexclave/shared/dist/utils/dates';
import { getEnvVariable } from '@hexclave/shared/dist/utils/env';
import { throwErr } from '@hexclave/shared/dist/utils/errors';
import { typedEntries, typedFromEntries } from '@hexclave/shared/dist/utils/objects';
import { createHash, randomUUID } from 'node:crypto';

const EXPLORATORY_TEAM_DISPLAY_NAME = 'Exploratory Research and Insight Partnership With Very Long Collaborative Name For Testing';

/** The full Prisma client returned for a tenancy — supports `$transaction` / `retryTransaction`. */
type TenancyPrismaClient = Awaited<ReturnType<typeof getPrismaClientForTenancy>>;

/**
 * Derive a stable v4-shaped UUID from a namespaced string so seed re-runs
 * upsert into existing rows instead of creating duplicates.
 */
function deterministicUuid(namespace: string): string {
  const hex = createHash('sha256').update(namespace).digest('hex');
  const a = hex.slice(0, 8);
  const b = hex.slice(8, 12);
  const c = '4' + hex.slice(13, 16);
  const d = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20);
  const e = hex.slice(20, 32);
  return `${a}-${b}-${c}-${d}-${e}`;
}

/** Mulberry32 — small, fast, deterministic PRNG. */
function deterministicPrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convert a string into a deterministic 32-bit seed for `deterministicPrng`. */
function seedFromString(input: string): number {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 8);
  return parseInt(hex, 16) >>> 0;
}

function daysAgo(d: number, h: number = 12): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - d);
  date.setHours(h, 0, 0, 0);
  return date;
}

// ============= Types =============

type TeamSeed = {
  displayName: string,
  profileImageUrl?: string,
};

type UserSeedOauthProvider = {
  providerId: string,
  accountId: string,
};

type UserSeed = {
  displayName?: string,
  email: string,
  profileImageUrl?: string,
  teamDisplayNames: string[],
  primaryEmailVerified: boolean,
  isAnonymous: boolean,
  oauthProviders: UserSeedOauthProvider[],
  createdAt?: Date,
};

type SeedDummyTeamsOptions = {
  prisma: PrismaClientTransaction,
  tenancy: Tenancy,
  freshProject: boolean,
};

type SeedDummyUsersOptions = {
  prisma: TenancyPrismaClient,
  tenancy: Tenancy,
  teamNameToId: Map<string, string>,
  freshProject: boolean,
};

type PaymentsProducts = {
  [productId: string]: Config | undefined,
};

type PaymentsSetup = {
  paymentsProducts: PaymentsProducts,
  paymentsBranchOverride: Config,
  paymentsEnvironmentOverride: Config,
};

type TransactionsSeedOptions = {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  teamNameToId: Map<string, string>,
  paymentsProducts: PaymentsProducts,
};

type EmailSeedOptions = {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  userEmailToId: Map<string, string>,
};

type EmailOutboxSeed = {
  id: string,
  subject: string,
  html?: string,
  text?: string,
  createdAt: Date,
  userEmail?: string,
  hasError?: boolean,
};

type SessionActivityEventSeedOptions = {
  tenancyId: string,
  projectId: string,
  userEmailToId: Map<string, string>,
  freshProject: boolean,
  clickhouseClient: ClickHouseClient,
};

type BulkActivityRegion = {
  country: string,
  region: string,
  city: string,
  lat: number,
  lon: number,
  tz: string,
  weight: number,
  ipPrefix: string,
};

type SeedDummyProjectOptions = {
  projectId?: string,
  ownerTeamId: string,
  oauthProviderIds: string[],
  excludeAlphaApps?: boolean,
  skipGithubConfigSource?: boolean,
  // An optional pre-warmed ClickHouse client reused for every analytics insert.
  // When omitted, one is created internally. The preview create-project route
  // passes the client it warmed up so the connection / TLS handshake is paid
  // exactly once rather than once per seeder.
  clickhouseClient?: ClickHouseClient,
};

// ============= Seed Data =============

const teamSeeds: TeamSeed[] = [
  { displayName: 'Design Systems Lab', profileImageUrl: 'https://avatar.vercel.sh/design-systems?size=96&background=312e81&color=fff' },
  { displayName: 'Prototype Garage' },
  { displayName: EXPLORATORY_TEAM_DISPLAY_NAME, profileImageUrl: 'https://avatar.vercel.sh/exploratory-research?size=96&background=2563eb&color=fff' },
  { displayName: 'Launch Council', profileImageUrl: 'https://avatar.vercel.sh/launch-council?size=96&background=172554&color=fff' },
  { displayName: 'Growth Loop', profileImageUrl: 'https://avatar.vercel.sh/growth-loop?size=96&background=16a34a&color=fff' },
  { displayName: 'QA Collective' },
  { displayName: 'Customer Advisory Board', profileImageUrl: 'https://avatar.vercel.sh/customer-advisory?size=96&background=854d0e&color=fff' },
  { displayName: 'Ops', profileImageUrl: 'https://avatar.vercel.sh/ops-team?size=96&background=ea580c&color=fff' },
];

const userSeeds: UserSeed[] = [
  {
    displayName: 'Amelia Chen',
    email: 'amelia.chen@dummy.dev',
    teamDisplayNames: ['Design Systems Lab', 'Prototype Garage'],
    primaryEmailVerified: true,
    isAnonymous: false,
    oauthProviders: [
      { providerId: 'github', accountId: 'amelia-chen-gh' },
      { providerId: 'google', accountId: 'amelia-chen-google' },
    ],
    createdAt: daysAgo(28, 9),
  },
  {
    email: 'leo.park@dummy.dev',
    teamDisplayNames: ['Design Systems Lab', 'QA Collective'],
    primaryEmailVerified: false,
    isAnonymous: false,
    oauthProviders: [],
    createdAt: daysAgo(28, 15),
  },
  {
    displayName: 'Some-long-display-name with-middle-name with-last-name',
    email: 'isla.rodriguez@dummy.dev',
    teamDisplayNames: [EXPLORATORY_TEAM_DISPLAY_NAME, 'Customer Advisory Board'],
    primaryEmailVerified: true,
    isAnonymous: false,
    oauthProviders: [
      { providerId: 'google', accountId: 'isla-rodriguez-google' },
      { providerId: 'microsoft', accountId: 'isla-rodriguez-msft' },
    ],
    createdAt: daysAgo(25, 10),
  },
  {
    displayName: 'Al',
    email: 'milo.adeyemi@dummy.dev',
    teamDisplayNames: [EXPLORATORY_TEAM_DISPLAY_NAME, 'Launch Council'],
    primaryEmailVerified: true,
    isAnonymous: true,
    oauthProviders: [],
    createdAt: daysAgo(25, 16),
  },
  {
    displayName: 'Priya Narang',
    email: 'priya.narang@dummy.dev',
    teamDisplayNames: ['Launch Council', 'Ops'],
    primaryEmailVerified: false,
    isAnonymous: false,
    oauthProviders: [
      { providerId: 'spotify', accountId: 'priya-narang-spotify' },
      { providerId: 'github', accountId: 'priya-narang-gh' },
    ],
    createdAt: daysAgo(23, 8),
  },
  {
    displayName: 'Jonas Richter',
    email: 'jonas.richter@dummy.dev',
    profileImageUrl: 'https://avatar.vercel.sh/jonas-richter?size=96',
    teamDisplayNames: ['Launch Council', 'QA Collective'],
    primaryEmailVerified: true,
    isAnonymous: false,
    oauthProviders: [],
    createdAt: daysAgo(21, 14),
  },
  {
    displayName: 'Chioma Mensah',
    email: 'chioma.mensah@dummy.dev',
    profileImageUrl: 'https://avatar.vercel.sh/chioma-mensah?size=96',
    teamDisplayNames: ['Design Systems Lab', 'Ops'],
    primaryEmailVerified: false,
    isAnonymous: true,
    oauthProviders: [
      { providerId: 'google', accountId: 'chioma-mensah-google' },
      { providerId: 'microsoft', accountId: 'chioma-mensah-msft' },
    ],
    createdAt: daysAgo(21, 17),
  },
  {
    displayName: 'Nia Holloway',
    email: 'nia.holloway@dummy.dev',
    teamDisplayNames: ['QA Collective'],
    primaryEmailVerified: true,
    isAnonymous: false,
    oauthProviders: [],
    createdAt: daysAgo(18, 11),
  },
  {
    displayName: 'Mateo Silva',
    email: 'mateo.silva@dummy.dev',
    teamDisplayNames: ['Growth Loop', 'Launch Council'],
    primaryEmailVerified: false,
    isAnonymous: false,
    oauthProviders: [
      { providerId: 'github', accountId: 'mateo-silva-gh' },
      { providerId: 'google', accountId: 'mateo-silva-google' },
    ],
    createdAt: daysAgo(15, 9),
  },
  {
    displayName: 'Harper Lin',
    email: 'harper.lin@dummy.dev',
    teamDisplayNames: ['Growth Loop', 'Customer Advisory Board'],
    primaryEmailVerified: true,
    isAnonymous: false,
    oauthProviders: [
      { providerId: 'google', accountId: 'harper-lin-google' },
      { providerId: 'microsoft', accountId: 'harper-lin-msft' },
    ],
    createdAt: daysAgo(12, 13),
  },
  {
    displayName: 'Zara Malik',
    email: 'zara.malik@dummy.dev',
    profileImageUrl: 'https://avatar.vercel.sh/zara-malik?size=96',
    teamDisplayNames: ['Prototype Garage', EXPLORATORY_TEAM_DISPLAY_NAME],
    primaryEmailVerified: true,
    isAnonymous: false,
    oauthProviders: [
      { providerId: 'github', accountId: 'zara-malik-gh' },
      { providerId: 'spotify', accountId: 'zara-malik-spotify' },
    ],
    createdAt: daysAgo(9, 10),
  },
  {
    displayName: 'Luca Bennett',
    email: 'luca.bennett@dummy.dev',
    teamDisplayNames: ['Growth Loop', 'Ops'],
    primaryEmailVerified: false,
    isAnonymous: false,
    oauthProviders: [],
    createdAt: daysAgo(6, 16),
  },
  {
    displayName: 'Evelyn Brooks',
    email: 'evelyn.brooks@dummy.dev',
    profileImageUrl: 'https://avatar.vercel.sh/evelyn-brooks?size=96&background=15803d&color=fff',
    teamDisplayNames: ['Customer Advisory Board'],
    primaryEmailVerified: true,
    isAnonymous: false,
    oauthProviders: [],
    createdAt: daysAgo(4, 8),
  },
  {
    displayName: 'Theo Fischer',
    email: 'theo.fischer@dummy.dev',
    profileImageUrl: 'https://avatar.vercel.sh/theo-fischer?size=96&background=5b21b6&color=fff',
    teamDisplayNames: ['QA Collective', 'Prototype Garage'],
    primaryEmailVerified: true,
    isAnonymous: false,
    oauthProviders: [
      { providerId: 'microsoft', accountId: 'theo-fischer-msft' },
      { providerId: 'github', accountId: 'theo-fischer-gh' },
    ],
    createdAt: daysAgo(3, 11),
  },
  {
    email: 'naomi.patel@dummy.dev',
    teamDisplayNames: ['Prototype Garage', 'Design Systems Lab'],
    primaryEmailVerified: false,
    isAnonymous: false,
    oauthProviders: [],
    createdAt: daysAgo(1, 9),
  },
  {
    displayName: 'Kai Romero',
    email: 'kai.romero@dummy.dev',
    teamDisplayNames: ['Growth Loop'],
    primaryEmailVerified: true,
    isAnonymous: false,
    oauthProviders: [],
    createdAt: daysAgo(1, 15),
  },
];

const DUMMY_SEED_IDS = {
  subscriptions: {
    designSystemsGrowth: 'a296195f-c460-4cd6-b4c4-6cd359b4c643',
    prototypeStarterTrial: '5a255248-4d42-4d61-95f9-f53e97c3f2dd',
    mateoGrowthAnnual: 'c4acea49-302a-43b9-82a7-446b19e0e662',
  },
  itemQuantityChanges: {
    designSeatsGrant: '44ca1801-0732-4273-ae14-4fd1c3999e24',
    opsAutomationCredit: 'a3e515dd-9332-4b15-b41a-90b9d6a37276',
    legacyReviewPass: 'b3c20e4f-608d-4c34-9c18-4a5c63780666',
  },
  oneTimePurchases: {
    ameliaSeatPack: '0b696a83-c54e-4a74-ae47-3ac5a4db49e6',
    launchCouncilUpfront: '10766081-37fd-410c-8b2e-1c3351e2d364',
  },
  invoices: {
    growthMonthly1: 'e1a2b3c4-d5e6-4f78-9a0b-1c2d3e4f5a60',
    growthMonthly2: 'f2b3c4d5-e6f7-4890-ab1c-2d3e4f5a6b71',
    growthMonthly3: 'a3c4d5e6-f7a8-4901-bc2d-3e4f5a6b7c82',
    growthMonthly4: 'b4d5e6f7-a8b9-4012-cd3e-4f5a6b7c8d93',
    growthMonthly5: 'c5e6f7a8-b9c0-4123-de4f-5a6b7c8d9ea4',
    starterCreation: 'd6f7a8b9-c0d1-4234-ef50-6a7b8c9d0fb5',
  },
  emails: {
    welcomeAmelia: 'af8cfd90-8912-4bf7-93a7-20ff2be54767',
    passkeyMilo: 'd534d777-5aa2-4014-a198-6484bbadcbf2',
    invitePriya: 'b7e31f58-cfd7-46cd-920f-d7616ad66bed',
    statusDigest: '2423e8d8-72cf-4355-a475-c2028e3ea958',
    templateFailure: 'faa33233-ba8d-4819-a89a-d442003cd589',
  },
} as const;

// ============= Seed Functions =============

async function seedDummyTeams(options: SeedDummyTeamsOptions): Promise<Map<string, string>> {
  const { prisma, tenancy, freshProject } = options;

  const teamNameToId = new Map<string, string>();

  // Idempotency: look up which seed teams already exist. Skipped entirely for a
  // fresh project (nothing can pre-exist); otherwise done in one findMany
  // rather than a findFirst per team.
  const existingTeamIdByName = new Map<string, string>();
  if (!freshProject) {
    const existingTeams = await prisma.team.findMany({
      where: {
        tenancyId: tenancy.id,
        displayName: { in: teamSeeds.map((team) => team.displayName) },
      },
      select: { teamId: true, displayName: true },
    });
    for (const existingTeam of existingTeams) {
      existingTeamIdByName.set(existingTeam.displayName, existingTeam.teamId);
    }
  }

  const teamsToCreate: TeamSeed[] = [];
  for (const team of teamSeeds) {
    const existingId = existingTeamIdByName.get(team.displayName);
    if (existingId != null) {
      teamNameToId.set(team.displayName, existingId);
    } else {
      teamsToCreate.push(team);
    }
  }

  // Teams are independent of each other, so create them concurrently instead of
  // in a serial loop. `adminCreate` is kept (rather than a raw bulk insert) so
  // the team-create side effects — default permissions, plan grant — still run.
  const createdTeams = await Promise.all(teamsToCreate.map((team) => teamsCrudHandlers.adminCreate({
    tenancy,
    data: {
      display_name: team.displayName,
      profile_image_url: team.profileImageUrl ?? null,
    },
  })));
  teamsToCreate.forEach((team, index) => {
    teamNameToId.set(team.displayName, createdTeams[index]!.id);
  });

  return teamNameToId;
}

type SeedOauthProvider = { providerId: string, accountId: string, email: string };

/**
 * Sample a random subset of OAuth providers for a bulk synthetic user.
 *
 * Distribution: ~50% get multiple accounts, ~30% get one, ~20% get none.
 * Consumes 1 + (roll < 0.5 ? 1 : 0) + n draws from `rand` per call; callers
 * relying on a deterministic PRNG stream must preserve this invariant.
 */
function pickBulkOauthProviders(params: {
  rand: () => number,
  available: readonly string[],
  email: string,
}): SeedOauthProvider[] {
  const { rand, available, email } = params;
  const roll = rand();
  let n: number;
  if (roll < 0.5) {
    n = 2 + Math.floor(rand() * (available.length - 1));
  } else if (roll < 0.8) {
    n = 1;
  } else {
    n = 0;
  }
  const pool = [...available];
  const picked: string[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rand() * pool.length);
    picked.push(pool[idx]!);
    pool.splice(idx, 1);
  }
  return picked.map((providerId) => ({
    providerId,
    accountId: `${email}-${providerId}`,
    email,
  }));
}

async function seedDummyUsers(options: SeedDummyUsersOptions): Promise<Map<string, string>> {
  const { prisma, tenancy, teamNameToId, freshProject } = options;

  const userEmailToId = new Map<string, string>();

  // Generate additional bulk users for realistic chart data
  // Uses seeded PRNG for reproducibility — each day gets a varying number of sign-ups
  const bulkFirstNames = [
    'Alex', 'Jordan', 'Taylor', 'Morgan', 'Riley', 'Quinn', 'Avery', 'Dakota',
    'Casey', 'Hayden', 'Cameron', 'Rowan', 'Sage', 'Blake', 'Emery', 'Skyler',
    'Reese', 'Peyton', 'Eden', 'Finley', 'Kendall', 'Aubrey', 'Drew', 'Jesse',
    'Parker', 'Robin', 'Sydney', 'River', 'Harley', 'Milan',
  ];
  const bulkLastNames = [
    'Kim', 'Liu', 'Patel', 'Garcia', 'Brown', 'Davis', 'Wilson', 'Martinez',
    'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Clark', 'Lewis',
    'Robinson', 'Walker', 'Young', 'Allen', 'Scott', 'Adams', 'Nelson',
    'Hill', 'Moore', 'Hall', 'King', 'Wright', 'Green', 'Baker', 'Turner',
  ];
  const bulkOauthProviders = ['google', 'github', 'microsoft'];

  // Seeded LCG PRNG for reproducibility
  let bulkSeed = 42;
  const bulkRand = () => {
    bulkSeed = (bulkSeed * 1664525 + 1013904223) & 0x7fffffff;
    return bulkSeed / 0x7fffffff;
  };

  // Per-day sign-up counts (day 0 = 30 days ago, day 29 = yesterday)
  // Pattern: gradual growth with realistic variance and weekend dips
  const dailySignUpCounts = [
    1, 0, 2, 1, 3, 0, 1,   // week 1 (low, starting out)
    2, 3, 1, 2, 4, 1, 0,   // week 2 (picking up)
    3, 2, 4, 3, 2, 5, 1,   // week 3 (steady growth)
    4, 3, 5, 2, 6, 3, 2, 4, // week 4+ (peak recent activity)
  ];

  // Phase 1 (sequential): derive every bulk-user spec from the PRNG up front,
  // so the seed stays deterministic regardless of creation order/concurrency.
  type BulkUserSpec = {
    email: string,
    displayName: string,
    createdAt: Date,
    oauthProviders: ReturnType<typeof pickBulkOauthProviders>,
    primaryEmailVerified: boolean,
  };
  const bulkUserSpecs: BulkUserSpec[] = [];
  let bulkIndex = 0;
  for (let dayOffset = 0; dayOffset < dailySignUpCounts.length; dayOffset++) {
    const count = dailySignUpCounts[dayOffset];
    const dayBack = dailySignUpCounts.length - dayOffset;

    for (let j = 0; j < count; j++) {
      const fnIdx = Math.floor(bulkRand() * bulkFirstNames.length);
      const lnIdx = Math.floor(bulkRand() * bulkLastNames.length);
      const firstName = bulkFirstNames[fnIdx]!;
      const lastName = bulkLastNames[lnIdx]!;
      const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}.bulk${bulkIndex}@dummy.dev`;
      const displayName = `${firstName} ${lastName}`;
      const hour = 8 + Math.floor(bulkRand() * 12);
      const oauthProviders = pickBulkOauthProviders({
        rand: bulkRand,
        available: bulkOauthProviders,
        email,
      });
      const primaryEmailVerified = bulkRand() > 0.3;
      bulkUserSpecs.push({
        email,
        displayName,
        createdAt: daysAgo(dayBack, hour),
        oauthProviders,
        primaryEmailVerified,
      });
      bulkIndex++;
    }
  }

  // Unified list of every user to seed (named seeds + bulk users), so they can
  // all be created with the same bulk-insert path.
  type UserToSeed = {
    email: string,
    displayName: string | null,
    primaryEmailVerified: boolean,
    isAnonymous: boolean,
    profileImageUrl: string | null,
    createdAt: Date | null,
    oauthProviders: SeedOauthProvider[],
  };
  const usersToSeed: UserToSeed[] = [
    ...userSeeds.map((u): UserToSeed => ({
      email: u.email,
      displayName: u.displayName ?? null,
      primaryEmailVerified: u.primaryEmailVerified,
      isAnonymous: u.isAnonymous,
      profileImageUrl: u.profileImageUrl ?? null,
      createdAt: u.createdAt ?? null,
      oauthProviders: u.oauthProviders.map((p) => ({ providerId: p.providerId, accountId: p.accountId, email: u.email })),
    })),
    ...bulkUserSpecs.map((s): UserToSeed => ({
      email: s.email,
      displayName: s.displayName,
      primaryEmailVerified: s.primaryEmailVerified,
      isAnonymous: false,
      profileImageUrl: null,
      createdAt: s.createdAt,
      oauthProviders: s.oauthProviders,
    })),
  ];

  // Idempotency: in one query, find every email that already has a user, and
  // skip re-creating it (seedDummyProject may run against an existing project).
  // Skipped entirely for a fresh project, where nothing can pre-exist.
  const existingChannels = freshProject ? [] : await prisma.contactChannel.findMany({
    where: {
      tenancyId: tenancy.id,
      type: 'EMAIL',
      value: { in: usersToSeed.map((u) => u.email) },
    },
    select: { value: true, projectUserId: true },
  });
  const existingIdByEmail = new Map(existingChannels.map((c) => [c.value, c.projectUserId]));

  // Build every row up front, with all UUIDs pre-generated so foreign keys
  // wire up without round-tripping. This replaces ~N per-user adminCreate
  // transactions with one createMany per table.
  const defaultPermissionIds = Object.keys(tenancy.config.rbac.defaultPermissions.signUp);
  const projectUserRows: Prisma.ProjectUserCreateManyInput[] = [];
  const contactChannelRows: Prisma.ContactChannelCreateManyInput[] = [];
  const authMethodRows: Prisma.AuthMethodCreateManyInput[] = [];
  const oauthAccountRows: Prisma.ProjectUserOAuthAccountCreateManyInput[] = [];
  const oauthAuthMethodRows: Prisma.OAuthAuthMethodCreateManyInput[] = [];
  const directPermissionRows: Prisma.ProjectUserDirectPermissionCreateManyInput[] = [];

  for (const user of usersToSeed) {
    const existingId = existingIdByEmail.get(user.email);
    if (existingId != null) {
      userEmailToId.set(user.email, existingId);
      continue;
    }
    const projectUserId = randomUUID();
    userEmailToId.set(user.email, projectUserId);

    projectUserRows.push({
      tenancyId: tenancy.id,
      projectUserId,
      mirroredProjectId: tenancy.project.id,
      mirroredBranchId: tenancy.branchId,
      displayName: user.displayName,
      isAnonymous: user.isAnonymous,
      profileImageUrl: user.profileImageUrl,
      // Only createdAt is back-dated (mirrors adminCreate + the old updateMany);
      // signedUpAt / lastActiveAt fall back to their now() defaults.
      createdAt: user.createdAt ?? undefined,
    });
    contactChannelRows.push({
      tenancyId: tenancy.id,
      projectUserId,
      id: randomUUID(),
      type: ContactChannelType.EMAIL,
      value: user.email,
      isVerified: user.primaryEmailVerified,
      isPrimary: BooleanTrue.TRUE,
      usedForAuth: BooleanTrue.TRUE,
    });
    for (const provider of user.oauthProviders) {
      const authMethodId = randomUUID();
      authMethodRows.push({ tenancyId: tenancy.id, id: authMethodId, projectUserId });
      oauthAccountRows.push({
        tenancyId: tenancy.id,
        id: randomUUID(),
        projectUserId,
        configOAuthProviderId: provider.providerId,
        providerAccountId: provider.accountId,
        email: provider.email,
        allowConnectedAccounts: true,
        allowSignIn: true,
      });
      oauthAuthMethodRows.push({
        tenancyId: tenancy.id,
        authMethodId,
        projectUserId,
        configOAuthProviderId: provider.providerId,
        providerAccountId: provider.accountId,
      });
    }
    for (const permissionId of defaultPermissionIds) {
      directPermissionRows.push({
        id: randomUUID(),
        tenancyId: tenancy.id,
        projectUserId,
        permissionId,
      });
    }
  }

  // One createMany per table, all inside a single transaction. Order matters
  // for foreign keys: ProjectUser first, OAuthAuthMethod after its referents.
  if (projectUserRows.length > 0) {
    await retryTransaction(prisma, async (tx) => {
      await tx.projectUser.createMany({ data: projectUserRows });
      await tx.contactChannel.createMany({ data: contactChannelRows });
      if (authMethodRows.length > 0) {
        await tx.authMethod.createMany({ data: authMethodRows });
        await tx.projectUserOAuthAccount.createMany({ data: oauthAccountRows });
        await tx.oAuthAuthMethod.createMany({ data: oauthAuthMethodRows });
      }
      if (directPermissionRows.length > 0) {
        await tx.projectUserDirectPermission.createMany({ data: directPermissionRows });
      }
    }, { timeout: 90_000 });
  }

  // Team memberships for the named seed users — bulk-inserted the same way.
  // This mirrors `addUserToTeam`: a TeamMember row plus the project's default
  // team-member permissions (TeamMemberDirectPermission rows). Webhooks are
  // intentionally skipped, as everywhere else in the seed.
  const desiredMemberships: Array<{ userId: string, teamId: string }> = [];
  for (const user of userSeeds) {
    const userId = userEmailToId.get(user.email) ?? throwErr(`Seeded user ${user.email} is missing an id`);
    for (const teamName of user.teamDisplayNames) {
      const teamId = teamNameToId.get(teamName) ?? throwErr(`Unknown dummy project team ${teamName}`);
      desiredMemberships.push({ userId, teamId });
    }
  }
  const namedUserIds = [...new Set(desiredMemberships.map((m) => m.userId))];
  const existingMemberships = (freshProject || namedUserIds.length === 0) ? [] : await prisma.teamMember.findMany({
    where: { tenancyId: tenancy.id, projectUserId: { in: namedUserIds } },
    select: { projectUserId: true, teamId: true },
  });
  const existingMembershipKeys = new Set(existingMemberships.map((m) => `${m.projectUserId}:${m.teamId}`));
  const defaultTeamPermissionIds = Object.keys(tenancy.config.rbac.defaultPermissions.teamMember);

  const teamMemberRows: Prisma.TeamMemberCreateManyInput[] = [];
  const teamMemberPermissionRows: Prisma.TeamMemberDirectPermissionCreateManyInput[] = [];
  for (const { userId, teamId } of desiredMemberships) {
    if (existingMembershipKeys.has(`${userId}:${teamId}`)) continue;
    teamMemberRows.push({ tenancyId: tenancy.id, projectUserId: userId, teamId });
    for (const permissionId of defaultTeamPermissionIds) {
      teamMemberPermissionRows.push({
        id: randomUUID(),
        tenancyId: tenancy.id,
        projectUserId: userId,
        teamId,
        permissionId,
      });
    }
  }
  if (teamMemberRows.length > 0) {
    await retryTransaction(prisma, async (tx) => {
      await tx.teamMember.createMany({ data: teamMemberRows });
      if (teamMemberPermissionRows.length > 0) {
        await tx.teamMemberDirectPermission.createMany({ data: teamMemberPermissionRows });
      }
    }, { timeout: 90_000 });
  }

  return userEmailToId;
}

export function buildDummyPaymentsSetup(): PaymentsSetup {
  const monthlyInterval: DayInterval = [1, 'month'];
  const yearlyInterval: DayInterval = [1, 'year'];
  const twoWeekInterval: DayInterval = [2, 'week'];

  const paymentsProducts: PaymentsProducts = {
    'starter': {
      displayName: 'Starter',
      productLineId: 'workspace',
      customerType: 'team',
      serverOnly: false,
      stackable: false,
      freeTrial: twoWeekInterval as any,
      prices: {
        monthly: {
          USD: '39',
          interval: monthlyInterval as any,
          serverOnly: false,
          freeTrial: twoWeekInterval as any,
        },
      },
      includedItems: {
        studio_seats: {
          quantity: 5,
          repeat: monthlyInterval as any,
          expires: 'when-repeated',
        },
        review_passes: {
          quantity: 50,
          repeat: monthlyInterval as any,
          expires: 'when-repeated',
        },
      },
    },
    'growth': {
      displayName: 'Growth',
      productLineId: 'workspace',
      customerType: 'team',
      serverOnly: false,
      stackable: false,
      prices: {
        monthly: {
          USD: '129',
          interval: monthlyInterval as any,
          serverOnly: false,
        },
        annual: {
          USD: '1290',
          interval: yearlyInterval as any,
          serverOnly: false,
        },
      },
      includedItems: {
        studio_seats: {
          quantity: 25,
          repeat: monthlyInterval as any,
          expires: 'when-repeated',
        },
        review_passes: {
          quantity: 250,
          repeat: monthlyInterval as any,
          expires: 'when-repeated',
        },
        automation_minutes: {
          quantity: 1000,
          repeat: monthlyInterval as any,
          expires: 'when-repeated',
        },
      },
    },
    'regression-addon': {
      displayName: 'Regression Add-on',
      productLineId: 'add_ons',
      customerType: 'team',
      serverOnly: false,
      stackable: true,
      prices: {
        monthly: {
          USD: '199',
          interval: monthlyInterval as any,
          serverOnly: false,
        },
      },
      includedItems: {
        snapshot_credits: {
          quantity: 500,
          repeat: monthlyInterval as any,
          expires: 'when-repeated',
        },
      },
      isAddOnTo: {
        'starter': true,
        'growth': true,
      },
    },
  };

  const paymentsBranchOverride = {
    productLines: {
      workspace: {
        displayName: 'Workspace Plans',
        customerType: 'team',
      },
      add_ons: {
        displayName: 'Add-ons',
        customerType: 'team',
      },
    },
    items: {
      studio_seats: {
        displayName: 'Studio Seats',
        customerType: 'team',
      },
      review_passes: {
        displayName: 'Reviewer Passes',
        customerType: 'team',
      },
      automation_minutes: {
        displayName: 'Automation Minutes',
        customerType: 'team',
      },
      snapshot_credits: {
        displayName: 'Snapshot Credits',
        customerType: 'team',
      },
    },
    products: paymentsProducts,
  };

  const paymentsEnvironmentOverride = {
    testMode: true,
  };

  return {
    paymentsProducts,
    paymentsBranchOverride,
    paymentsEnvironmentOverride,
  };
}

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

type SubscriptionSeed = {
  id: string,
  customerType: CustomerType,
  customerId: string,
  productId?: string,
  priceId?: string,
  product: Prisma.InputJsonValue,
  quantity: number,
  status: SubscriptionStatus,
  creationSource: PurchaseCreationSource,
  currentPeriodStart: Date,
  currentPeriodEnd: Date,
  cancelAtPeriodEnd: boolean,
  stripeSubscriptionId?: string | null,
  createdAt: Date,
};

type ItemQuantityChangeSeed = {
  id: string,
  customerType: CustomerType,
  customerId: string,
  itemId: string,
  quantity: number,
  description?: string,
  expiresAt?: Date | null,
  createdAt: Date,
};

type OneTimePurchaseSeed = {
  id: string,
  customerType: CustomerType,
  customerId: string,
  productId?: string,
  priceId?: string,
  product: Prisma.InputJsonValue,
  quantity: number,
  creationSource: PurchaseCreationSource,
  stripePaymentIntentId?: string | null,
  createdAt: Date,
};

async function seedDummyTransactions(options: TransactionsSeedOptions) {
  const {
    prisma,
    tenancyId,
    teamNameToId,
    paymentsProducts,
  } = options;

  const resolveTeamId = (teamName: string) => teamNameToId.get(teamName) ?? throwErr(`Unknown dummy project team ${teamName}`);
  const resolveProduct = (productId: string): Prisma.InputJsonValue => {
    const product = paymentsProducts[productId];
    if (!product) {
      throwErr(`Unknown payments product ${productId}`);
    }
    return cloneJson(product) as Prisma.InputJsonValue;
  };

  const subscriptionSeeds: SubscriptionSeed[] = [
    {
      id: DUMMY_SEED_IDS.subscriptions.designSystemsGrowth,
      customerType: CustomerType.TEAM,
      customerId: resolveTeamId('Design Systems Lab'),
      productId: 'growth',
      priceId: 'monthly',
      product: resolveProduct('growth'),
      quantity: 25,
      status: SubscriptionStatus.active,
      creationSource: PurchaseCreationSource.PURCHASE_PAGE,
      currentPeriodStart: new Date('2024-05-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2024-06-01T00:00:00.000Z'),
      cancelAtPeriodEnd: false,
      stripeSubscriptionId: 'sub_growth_designsystems',
      createdAt: new Date('2024-04-15T10:00:00.000Z'),
    },
    {
      id: DUMMY_SEED_IDS.subscriptions.prototypeStarterTrial,
      customerType: CustomerType.TEAM,
      customerId: resolveTeamId('Prototype Garage'),
      productId: 'starter',
      priceId: 'monthly',
      product: resolveProduct('starter'),
      quantity: 5,
      status: SubscriptionStatus.trialing,
      creationSource: PurchaseCreationSource.TEST_MODE,
      currentPeriodStart: new Date('2024-05-20T00:00:00.000Z'),
      currentPeriodEnd: new Date('2024-06-03T00:00:00.000Z'),
      cancelAtPeriodEnd: false,
      stripeSubscriptionId: 'sub_starter_prototype',
      createdAt: new Date('2024-05-19T08:00:00.000Z'),
    },
    {
      id: DUMMY_SEED_IDS.subscriptions.mateoGrowthAnnual,
      customerType: CustomerType.TEAM,
      customerId: resolveTeamId('Growth Loop'),
      productId: 'growth',
      priceId: 'annual',
      product: resolveProduct('growth'),
      quantity: 1,
      status: SubscriptionStatus.paused,
      creationSource: PurchaseCreationSource.API_GRANT,
      currentPeriodStart: new Date('2024-02-01T00:00:00.000Z'),
      currentPeriodEnd: new Date('2025-02-01T00:00:00.000Z'),
      cancelAtPeriodEnd: true,
      stripeSubscriptionId: null,
      createdAt: new Date('2024-02-01T00:00:00.000Z'),
    },
  ];

  for (const subscription of subscriptionSeeds) {
    await prisma.subscription.upsert({
      where: {
        tenancyId_id: {
          tenancyId,
          id: subscription.id,
        },
      },
      update: {
        customerId: subscription.customerId,
        customerType: subscription.customerType,
        productId: subscription.productId ?? null,
        priceId: subscription.priceId ?? null,
        product: subscription.product,
        quantity: subscription.quantity,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        currentPeriodStart: subscription.currentPeriodStart,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        creationSource: subscription.creationSource,
        stripeSubscriptionId: subscription.stripeSubscriptionId ?? null,
      },
      create: {
        tenancyId,
        id: subscription.id,
        customerId: subscription.customerId,
        customerType: subscription.customerType,
        productId: subscription.productId ?? null,
        priceId: subscription.priceId ?? null,
        product: subscription.product,
        quantity: subscription.quantity,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        currentPeriodStart: subscription.currentPeriodStart,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        creationSource: subscription.creationSource,
        stripeSubscriptionId: subscription.stripeSubscriptionId ?? null,
        createdAt: subscription.createdAt,
      },
    });
  }

  const itemQuantityChangeSeeds: ItemQuantityChangeSeed[] = [
    {
      id: DUMMY_SEED_IDS.itemQuantityChanges.designSeatsGrant,
      customerType: CustomerType.TEAM,
      customerId: resolveTeamId('Design Systems Lab'),
      itemId: 'studio_seats',
      quantity: 15,
      description: 'Bonus seats for cross-team design sprint',
      expiresAt: new Date('2024-07-15T00:00:00.000Z'),
      createdAt: new Date('2024-05-01T00:00:00.000Z'),
    },
    {
      id: DUMMY_SEED_IDS.itemQuantityChanges.opsAutomationCredit,
      customerType: CustomerType.TEAM,
      customerId: resolveTeamId('Ops'),
      itemId: 'automation_minutes',
      quantity: 1200,
      description: 'Reliability incident credit',
      expiresAt: new Date('2024-08-01T00:00:00.000Z'),
      createdAt: new Date('2024-05-10T09:30:00.000Z'),
    },
    {
      id: DUMMY_SEED_IDS.itemQuantityChanges.legacyReviewPass,
      customerType: CustomerType.CUSTOM,
      customerId: 'visual-review-partner',
      itemId: 'legacy_review_pass',
      quantity: 25,
      description: 'Legacy migration allowance',
      expiresAt: new Date('2024-09-15T00:00:00.000Z'),
      createdAt: new Date('2024-04-18T00:00:00.000Z'),
    },
  ];

  for (const quantityChange of itemQuantityChangeSeeds) {
    await prisma.itemQuantityChange.upsert({
      where: {
        tenancyId_id: {
          tenancyId,
          id: quantityChange.id,
        },
      },
      update: {
        customerId: quantityChange.customerId,
        customerType: quantityChange.customerType,
        itemId: quantityChange.itemId,
        quantity: quantityChange.quantity,
        description: quantityChange.description ?? null,
        expiresAt: quantityChange.expiresAt ?? null,
      },
      create: {
        tenancyId,
        id: quantityChange.id,
        customerId: quantityChange.customerId,
        customerType: quantityChange.customerType,
        itemId: quantityChange.itemId,
        quantity: quantityChange.quantity,
        description: quantityChange.description ?? null,
        expiresAt: quantityChange.expiresAt ?? null,
        createdAt: quantityChange.createdAt,
      },
    });
  }

  const oneTimePurchaseSeeds: OneTimePurchaseSeed[] = [
    {
      id: DUMMY_SEED_IDS.oneTimePurchases.ameliaSeatPack,
      customerType: CustomerType.TEAM,
      customerId: resolveTeamId('Design Systems Lab'),
      productId: 'starter',
      priceId: 'monthly',
      product: resolveProduct('starter'),
      quantity: 2,
      creationSource: PurchaseCreationSource.TEST_MODE,
      stripePaymentIntentId: null,
      createdAt: new Date('2024-05-25T15:00:00.000Z'),
    },
    {
      id: DUMMY_SEED_IDS.oneTimePurchases.launchCouncilUpfront,
      customerType: CustomerType.TEAM,
      customerId: resolveTeamId('Launch Council'),
      productId: 'growth',
      priceId: 'annual',
      product: resolveProduct('growth'),
      quantity: 1,
      creationSource: PurchaseCreationSource.PURCHASE_PAGE,
      stripePaymentIntentId: 'pi_launch_council_growth',
      createdAt: new Date('2024-03-12T00:00:00.000Z'),
    },
  ];

  for (const purchase of oneTimePurchaseSeeds) {
    await prisma.oneTimePurchase.upsert({
      where: {
        tenancyId_id: {
          tenancyId,
          id: purchase.id,
        },
      },
      update: {
        customerId: purchase.customerId,
        customerType: purchase.customerType,
        productId: purchase.productId ?? null,
        priceId: purchase.priceId ?? null,
        product: purchase.product,
        quantity: purchase.quantity,
        creationSource: purchase.creationSource,
        stripePaymentIntentId: purchase.stripePaymentIntentId ?? null,
      },
      create: {
        tenancyId,
        id: purchase.id,
        customerId: purchase.customerId,
        customerType: purchase.customerType,
        productId: purchase.productId ?? null,
        priceId: purchase.priceId ?? null,
        product: purchase.product,
        quantity: purchase.quantity,
        creationSource: purchase.creationSource,
        stripePaymentIntentId: purchase.stripePaymentIntentId ?? null,
        createdAt: purchase.createdAt,
      },
    });
  }

  type InvoiceSeed = {
    id: string,
    stripeSubscriptionId: string,
    stripeInvoiceId: string,
    isSubscriptionCreationInvoice: boolean,
    status: string,
    amountTotal: number,
    createdAt: Date,
  };

  const invoiceSeeds: InvoiceSeed[] = [
    {
      id: DUMMY_SEED_IDS.invoices.growthMonthly1,
      stripeSubscriptionId: 'sub_growth_designsystems',
      stripeInvoiceId: 'in_growth_ds_001',
      isSubscriptionCreationInvoice: true,
      status: 'paid',
      amountTotal: 12900,
      createdAt: daysAgo(25, 10),
    },
    {
      id: DUMMY_SEED_IDS.invoices.growthMonthly2,
      stripeSubscriptionId: 'sub_growth_designsystems',
      stripeInvoiceId: 'in_growth_ds_002',
      isSubscriptionCreationInvoice: false,
      status: 'paid',
      amountTotal: 12900,
      createdAt: daysAgo(18, 10),
    },
    {
      id: DUMMY_SEED_IDS.invoices.growthMonthly3,
      stripeSubscriptionId: 'sub_growth_designsystems',
      stripeInvoiceId: 'in_growth_ds_003',
      isSubscriptionCreationInvoice: false,
      status: 'paid',
      amountTotal: 12900,
      createdAt: daysAgo(11, 10),
    },
    {
      id: DUMMY_SEED_IDS.invoices.growthMonthly4,
      stripeSubscriptionId: 'sub_growth_designsystems',
      stripeInvoiceId: 'in_growth_ds_004',
      isSubscriptionCreationInvoice: false,
      status: 'paid',
      amountTotal: 12900,
      createdAt: daysAgo(4, 10),
    },
    {
      id: DUMMY_SEED_IDS.invoices.growthMonthly5,
      stripeSubscriptionId: 'sub_growth_designsystems',
      stripeInvoiceId: 'in_growth_ds_005',
      isSubscriptionCreationInvoice: false,
      status: 'succeeded',
      amountTotal: 15900,
      createdAt: daysAgo(1, 14),
    },
    {
      id: DUMMY_SEED_IDS.invoices.starterCreation,
      stripeSubscriptionId: 'sub_starter_prototype',
      stripeInvoiceId: 'in_starter_proto_001',
      isSubscriptionCreationInvoice: true,
      status: 'paid',
      amountTotal: 0,
      createdAt: daysAgo(20, 8),
    },
  ];

  for (const invoice of invoiceSeeds) {
    await prisma.subscriptionInvoice.upsert({
      where: {
        tenancyId_id: {
          tenancyId,
          id: invoice.id,
        },
      },
      update: {
        status: invoice.status,
        amountTotal: invoice.amountTotal,
      },
      create: {
        tenancyId,
        id: invoice.id,
        stripeSubscriptionId: invoice.stripeSubscriptionId,
        stripeInvoiceId: invoice.stripeInvoiceId,
        isSubscriptionCreationInvoice: invoice.isSubscriptionCreationInvoice,
        status: invoice.status,
        amountTotal: invoice.amountTotal,
        createdAt: invoice.createdAt,
      },
    });
  }
}

async function seedDummyEmails(options: EmailSeedOptions) {
  const { prisma, tenancyId, userEmailToId } = options;
  const resolveOptionalUserId = (email?: string) => {
    if (!email) return null;
    const userId = userEmailToId.get(email);
    if (!userId) {
      throwErr(`Unknown dummy project user ${email}`);
    }
    return userId;
  };

  const emailSeeds: EmailOutboxSeed[] = [
    {
      id: DUMMY_SEED_IDS.emails.welcomeAmelia,
      subject: 'Welcome to Dummy Project',
      html: '<p>Hi Amelia,<br/>Welcome to Dummy Project.</p>',
      text: 'Hi Amelia,\nWelcome to Dummy Project.',
      createdAt: new Date('2024-05-01T13:00:00.000Z'),
      userEmail: 'amelia.chen@dummy.dev',
    },
    {
      id: DUMMY_SEED_IDS.emails.passkeyMilo,
      subject: 'Your passkey sign-in link',
      html: '<p>Complete your sign-in within <strong>10 minutes</strong>.</p>',
      text: 'Complete your sign-in within 10 minutes.',
      createdAt: new Date('2024-05-02T10:00:00.000Z'),
      userEmail: 'milo.adeyemi@dummy.dev',
    },
    {
      id: DUMMY_SEED_IDS.emails.invitePriya,
      subject: 'Dashboard invite for Ops',
      html: '<p>Welcome to the dashboard!</p>',
      hasError: true,
      createdAt: new Date('2024-05-04T18:30:00.000Z'),
      userEmail: 'priya.narang@dummy.dev',
    },
    {
      id: DUMMY_SEED_IDS.emails.statusDigest,
      subject: 'Nightly status digest',
      text: 'All services operational. 3 warnings acknowledged.',
      createdAt: new Date('2024-05-06T07:45:00.000Z'),
    },
    {
      id: DUMMY_SEED_IDS.emails.templateFailure,
      subject: 'Template rendering failed - Review',
      html: '<p>Rendering failed due to <code>undefined</code> data from billing.</p>',
      hasError: true,
      createdAt: new Date('2024-05-08T12:05:00.000Z'),
    },
  ];

  for (const email of emailSeeds) {
    const userId = resolveOptionalUserId(email.userEmail);
    const recipient = userId
      ? { type: 'user-primary-email', userId }
      : { type: 'custom-emails', emails: ['unknown@dummy.dev'] };

    await globalPrismaClient.emailOutbox.upsert({
      where: {
        tenancyId_id: {
          tenancyId,
          id: email.id,
        },
      },
      update: {},
      create: {
        tenancyId,
        id: email.id,
        tsxSource: '',
        isHighPriority: false,
        to: recipient,
        extraRenderVariables: {},
        shouldSkipDeliverabilityCheck: false,
        createdWith: EmailOutboxCreatedWith.PROGRAMMATIC_CALL,
        scheduledAt: email.createdAt,
        renderedByWorkerId: email.id,
        startedRenderingAt: email.createdAt,
        finishedRenderingAt: email.createdAt,
        renderedSubject: email.subject,
        renderedHtml: email.html ?? null,
        renderedText: email.text ?? null,
        startedSendingAt: email.createdAt,
        finishedSendingAt: email.createdAt,
        canHaveDeliveryInfo: false,
        sendServerErrorExternalMessage: email.hasError ? 'Delivery failed' : null,
        sendServerErrorExternalDetails: email.hasError ? {} : Prisma.DbNull,
        sendServerErrorInternalMessage: email.hasError ? "Delivery failed. This is the internal error message." : null,
        sendServerErrorInternalDetails: email.hasError ? { internalError: "No internal error details." } : Prisma.DbNull,
        createdAt: email.createdAt,
      },
    });
  }
}

const sessionActivityLocations = [
  { countryCode: 'US', regionCode: 'CA', cityName: 'San Francisco', latitude: 37.7749, longitude: -122.4194, tzIdentifier: 'America/Los_Angeles' },
  { countryCode: 'US', regionCode: 'NY', cityName: 'New York', latitude: 40.7128, longitude: -74.0060, tzIdentifier: 'America/New_York' },
  { countryCode: 'GB', regionCode: 'ENG', cityName: 'London', latitude: 51.5074, longitude: -0.1278, tzIdentifier: 'Europe/London' },
  { countryCode: 'DE', regionCode: 'BE', cityName: 'Berlin', latitude: 52.5200, longitude: 13.4050, tzIdentifier: 'Europe/Berlin' },
  { countryCode: 'JP', regionCode: '13', cityName: 'Tokyo', latitude: 35.6762, longitude: 139.6503, tzIdentifier: 'Asia/Tokyo' },
  { countryCode: 'AU', regionCode: 'NSW', cityName: 'Sydney', latitude: -33.8688, longitude: 151.2093, tzIdentifier: 'Australia/Sydney' },
  { countryCode: 'IN', regionCode: 'KA', cityName: 'Bangalore', latitude: 12.9716, longitude: 77.5946, tzIdentifier: 'Asia/Kolkata' },
  { countryCode: 'BR', regionCode: 'SP', cityName: 'São Paulo', latitude: -23.5505, longitude: -46.6333, tzIdentifier: 'America/Sao_Paulo' },
  { countryCode: 'CA', regionCode: 'ON', cityName: 'Toronto', latitude: 43.6532, longitude: -79.3832, tzIdentifier: 'America/Toronto' },
  { countryCode: 'FR', regionCode: 'IDF', cityName: 'Paris', latitude: 48.8566, longitude: 2.3522, tzIdentifier: 'Europe/Paris' },
  { countryCode: 'SG', regionCode: 'SG', cityName: 'Singapore', latitude: 1.3521, longitude: 103.8198, tzIdentifier: 'Asia/Singapore' },
  { countryCode: 'NL', regionCode: 'NH', cityName: 'Amsterdam', latitude: 52.3676, longitude: 4.9041, tzIdentifier: 'Europe/Amsterdam' },
  { countryCode: 'SE', regionCode: 'AB', cityName: 'Stockholm', latitude: 59.3293, longitude: 18.0686, tzIdentifier: 'Europe/Stockholm' },
  { countryCode: 'ES', regionCode: 'MD', cityName: 'Madrid', latitude: 40.4168, longitude: -3.7038, tzIdentifier: 'Europe/Madrid' },
  { countryCode: 'IT', regionCode: 'RM', cityName: 'Rome', latitude: 41.9028, longitude: 12.4964, tzIdentifier: 'Europe/Rome' },
  { countryCode: 'MX', regionCode: 'CMX', cityName: 'Mexico City', latitude: 19.4326, longitude: -99.1332, tzIdentifier: 'America/Mexico_City' },
  { countryCode: 'KR', regionCode: '11', cityName: 'Seoul', latitude: 37.5665, longitude: 126.9780, tzIdentifier: 'Asia/Seoul' },
  { countryCode: 'ZA', regionCode: 'GT', cityName: 'Johannesburg', latitude: -26.2041, longitude: 28.0473, tzIdentifier: 'Africa/Johannesburg' },
  { countryCode: 'AE', regionCode: 'DU', cityName: 'Dubai', latitude: 25.2048, longitude: 55.2708, tzIdentifier: 'Asia/Dubai' },
  { countryCode: 'CH', regionCode: 'ZH', cityName: 'Zurich', latitude: 47.3769, longitude: 8.5417, tzIdentifier: 'Europe/Zurich' },
];

// ── Bulk activity seed fixtures ─────────────────────────────────────────────

const BULK_ACTIVITY_REGIONS: BulkActivityRegion[] = [
  // North America
  { country: 'US', region: 'CA', city: 'San Francisco', lat: 37.7749, lon: -122.4194, tz: 'America/Los_Angeles', weight: 18, ipPrefix: '104.16' },
  { country: 'US', region: 'NY', city: 'New York', lat: 40.7128, lon: -74.0060, tz: 'America/New_York', weight: 14, ipPrefix: '23.56' },
  { country: 'US', region: 'TX', city: 'Austin', lat: 30.2672, lon: -97.7431, tz: 'America/Chicago', weight: 6, ipPrefix: '68.54' },
  { country: 'US', region: 'WA', city: 'Seattle', lat: 47.6062, lon: -122.3321, tz: 'America/Los_Angeles', weight: 5, ipPrefix: '52.10' },
  { country: 'CA', region: 'ON', city: 'Toronto', lat: 43.6532, lon: -79.3832, tz: 'America/Toronto', weight: 5, ipPrefix: '99.240' },
  { country: 'CA', region: 'BC', city: 'Vancouver', lat: 49.2827, lon: -123.1207, tz: 'America/Vancouver', weight: 3, ipPrefix: '206.75' },
  { country: 'MX', region: 'CMX', city: 'Mexico City', lat: 19.4326, lon: -99.1332, tz: 'America/Mexico_City', weight: 2, ipPrefix: '189.148' },
  // Europe
  { country: 'GB', region: 'ENG', city: 'London', lat: 51.5074, lon: -0.1278, tz: 'Europe/London', weight: 10, ipPrefix: '90.196' },
  { country: 'DE', region: 'BE', city: 'Berlin', lat: 52.5200, lon: 13.4050, tz: 'Europe/Berlin', weight: 7, ipPrefix: '91.64' },
  { country: 'FR', region: 'IDF', city: 'Paris', lat: 48.8566, lon: 2.3522, tz: 'Europe/Paris', weight: 5, ipPrefix: '82.64' },
  { country: 'NL', region: 'NH', city: 'Amsterdam', lat: 52.3676, lon: 4.9041, tz: 'Europe/Amsterdam', weight: 3, ipPrefix: '145.14' },
  { country: 'ES', region: 'MD', city: 'Madrid', lat: 40.4168, lon: -3.7038, tz: 'Europe/Madrid', weight: 3, ipPrefix: '85.55' },
  { country: 'IT', region: 'LAZ', city: 'Rome', lat: 41.9028, lon: 12.4964, tz: 'Europe/Rome', weight: 2, ipPrefix: '93.41' },
  { country: 'PL', region: 'MZ', city: 'Warsaw', lat: 52.2297, lon: 21.0122, tz: 'Europe/Warsaw', weight: 2, ipPrefix: '178.42' },
  { country: 'SE', region: 'AB', city: 'Stockholm', lat: 59.3293, lon: 18.0686, tz: 'Europe/Stockholm', weight: 2, ipPrefix: '81.229' },
  { country: 'IE', region: 'D', city: 'Dublin', lat: 53.3498, lon: -6.2603, tz: 'Europe/Dublin', weight: 2, ipPrefix: '185.2' },
  // Asia-Pacific
  { country: 'IN', region: 'KA', city: 'Bangalore', lat: 12.9716, lon: 77.5946, tz: 'Asia/Kolkata', weight: 9, ipPrefix: '157.48' },
  { country: 'IN', region: 'MH', city: 'Mumbai', lat: 19.0760, lon: 72.8777, tz: 'Asia/Kolkata', weight: 4, ipPrefix: '14.140' },
  { country: 'JP', region: '13', city: 'Tokyo', lat: 35.6762, lon: 139.6503, tz: 'Asia/Tokyo', weight: 5, ipPrefix: '126.209' },
  { country: 'SG', region: '01', city: 'Singapore', lat: 1.3521, lon: 103.8198, tz: 'Asia/Singapore', weight: 3, ipPrefix: '165.21' },
  { country: 'AU', region: 'NSW', city: 'Sydney', lat: -33.8688, lon: 151.2093, tz: 'Australia/Sydney', weight: 3, ipPrefix: '203.2' },
  { country: 'KR', region: '11', city: 'Seoul', lat: 37.5665, lon: 126.9780, tz: 'Asia/Seoul', weight: 2, ipPrefix: '211.34' },
  { country: 'CN', region: 'SH', city: 'Shanghai', lat: 31.2304, lon: 121.4737, tz: 'Asia/Shanghai', weight: 2, ipPrefix: '114.88' },
  { country: 'ID', region: 'JK', city: 'Jakarta', lat: -6.2088, lon: 106.8456, tz: 'Asia/Jakarta', weight: 1, ipPrefix: '103.47' },
  // South America / MEA
  { country: 'BR', region: 'SP', city: 'São Paulo', lat: -23.5505, lon: -46.6333, tz: 'America/Sao_Paulo', weight: 3, ipPrefix: '177.66' },
  { country: 'AR', region: 'C', city: 'Buenos Aires', lat: -34.6037, lon: -58.3816, tz: 'America/Argentina/Buenos_Aires', weight: 1, ipPrefix: '181.45' },
  { country: 'ZA', region: 'GT', city: 'Johannesburg', lat: -26.2041, lon: 28.0473, tz: 'Africa/Johannesburg', weight: 1, ipPrefix: '41.76' },
  { country: 'AE', region: 'DU', city: 'Dubai', lat: 25.2048, lon: 55.2708, tz: 'Asia/Dubai', weight: 1, ipPrefix: '94.200' },
  { country: 'NG', region: 'LA', city: 'Lagos', lat: 6.5244, lon: 3.3792, tz: 'Africa/Lagos', weight: 1, ipPrefix: '102.89' },
];

const BULK_ACTIVITY_REGION_WEIGHT_TOTAL = BULK_ACTIVITY_REGIONS.reduce((sum, r) => sum + r.weight, 0);

function pickBulkActivityRegion(rand: () => number): BulkActivityRegion {
  const roll = rand() * BULK_ACTIVITY_REGION_WEIGHT_TOTAL;
  let acc = 0;
  for (const r of BULK_ACTIVITY_REGIONS) {
    acc += r.weight;
    if (roll < acc) return r;
  }
  return BULK_ACTIVITY_REGIONS[BULK_ACTIVITY_REGIONS.length - 1]!;
}

const BULK_FIRST_NAMES = [
  'Alex', 'Jordan', 'Taylor', 'Morgan', 'Riley', 'Quinn', 'Avery', 'Dakota',
  'Casey', 'Hayden', 'Cameron', 'Rowan', 'Sage', 'Blake', 'Emery', 'Skyler',
  'Reese', 'Peyton', 'Eden', 'Finley', 'Kendall', 'Aubrey', 'Drew', 'Jesse',
  'Parker', 'Robin', 'Sydney', 'River', 'Harley', 'Milan', 'Aarav', 'Yuki',
  'Mateo', 'Nia', 'Omar', 'Priya', 'Kai', 'Luca', 'Zara', 'Ines', 'Noa',
];
const BULK_LAST_NAMES = [
  'Kim', 'Liu', 'Patel', 'Garcia', 'Brown', 'Davis', 'Wilson', 'Martinez',
  'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Clark', 'Lewis',
  'Robinson', 'Walker', 'Young', 'Allen', 'Scott', 'Adams', 'Nelson', 'Hill',
  'Moore', 'Hall', 'King', 'Wright', 'Green', 'Baker', 'Turner', 'Okafor',
  'Suzuki', 'Schneider', 'Dubois', 'Rossi', 'Nakamura', 'Silva', 'Ivanov',
];
const BULK_REFERRERS = [
  { url: 'https://www.google.com/', weight: 32 },
  { url: 'https://github.com/', weight: 18 },
  { url: 'https://twitter.com/', weight: 12 },
  { url: 'https://www.producthunt.com/', weight: 8 },
  { url: '', weight: 20 },  // direct traffic
  { url: 'https://news.ycombinator.com/', weight: 6 },
  { url: 'https://www.reddit.com/', weight: 4 },
  { url: 'https://www.bing.com/', weight: 5 },
  { url: 'https://duckduckgo.com/', weight: 3 },
  { url: 'https://www.linkedin.com/', weight: 7 },
  { url: 'https://www.facebook.com/', weight: 5 },
  { url: 'https://www.youtube.com/', weight: 6 },
  { url: 'https://stackoverflow.com/', weight: 5 },
  { url: 'https://dev.to/', weight: 3 },
  { url: 'https://medium.com/', weight: 4 },
  { url: 'https://discord.com/', weight: 3 },
  { url: 'https://t.me/', weight: 2 },
  { url: 'https://www.indiehackers.com/', weight: 2 },
  { url: 'https://hashnode.com/', weight: 2 },
  { url: 'https://lobste.rs/', weight: 1 },
  { url: 'https://www.bing.com/search', weight: 2 },
  { url: 'https://search.brave.com/', weight: 1 },
  { url: 'https://www.quora.com/', weight: 2 },
  { url: 'https://www.tiktok.com/', weight: 2 },
  { url: 'https://mastodon.social/', weight: 1 },
  { url: 'https://bsky.app/', weight: 2 },
  { url: 'https://www.npmjs.com/', weight: 3 },
  { url: 'https://vercel.com/', weight: 2 },
  { url: 'https://supabase.com/', weight: 1 },
  { url: 'https://nextjs.org/', weight: 2 },
  { url: 'https://react.dev/', weight: 1 },
];
const BULK_REFERRER_WEIGHT_TOTAL = BULK_REFERRERS.reduce((sum, r) => sum + r.weight, 0);

function pickBulkReferrer(rand: () => number): string {
  const roll = rand() * BULK_REFERRER_WEIGHT_TOTAL;
  let acc = 0;
  for (const r of BULK_REFERRERS) {
    acc += r.weight;
    if (roll < acc) return r.url;
  }
  return '';
}

const BULK_PAGE_PATHS = [
  '/', '/pricing', '/docs', '/docs/getting-started', '/docs/api-reference',
  '/blog', '/blog/announcing-v2', '/about', '/contact', '/changelog',
  '/dashboard', '/settings', '/settings/profile', '/settings/billing',
  '/integrations', '/features', '/enterprise',
];

function bulkFakeIp(prefix: string, rand: () => number): string {
  const c = Math.floor(rand() * 256);
  const d = Math.floor(rand() * 254) + 1;
  return `${prefix}.${c}.${d}`;
}

function bulkRandomTimestampOnDay(now: Date, daysAgo: number, rand: () => number): Date {
  const ts = new Date(now);
  ts.setUTCDate(ts.getUTCDate() - daysAgo);
  const hour = 8 + Math.floor(rand() * 14);
  ts.setUTCHours(hour, Math.floor(rand() * 60), Math.floor(rand() * 60), Math.floor(rand() * 1000));
  // A random hour-of-day on "today" can land after `now`. Shift such events
  // back a day so seeded activity is never in the future — a future-dated
  // `$token-refresh` event would otherwise satisfy the (upper-bound-free)
  // "live users" window forever and inflate the overview globe's live count.
  if (ts.getTime() > now.getTime()) {
    ts.setUTCDate(ts.getUTCDate() - 1);
  }
  return ts;
}

function distributeBulkSignups(count: number, days: number, rand: () => number, now: Date): number[] {
  const dayWeights: number[] = [];
  for (let d = 0; d < days; d++) {
    const ramp = 0.5 + (d / Math.max(1, days - 1));
    const jitter = 0.75 + rand() * 0.5;
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - (days - 1 - d));
    const dow = date.getUTCDay();
    const weekend = (dow === 0 || dow === 6) ? 0.65 : 1.0;
    dayWeights.push(ramp * jitter * weekend);
  }
  const total = dayWeights.reduce((a, b) => a + b, 0);
  const offsets: number[] = [];
  for (let d = 0; d < days; d++) {
    const share = Math.round((dayWeights[d]! / total) * count);
    const daysAgoOffset = days - 1 - d;
    for (let i = 0; i < share; i++) offsets.push(daysAgoOffset);
  }
  while (offsets.length < count) offsets.push(Math.floor(rand() * days));
  while (offsets.length > count) offsets.pop();
  return offsets;
}

function formatClickhouseTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 23);
}

/**
 * Builds a `$token-refresh` row for the ClickHouse `analytics_internal.events`
 * table. Shared by the historical session-activity seeder and the live-user
 * seeder so the row shape stays defined in exactly one place.
 */
function buildTokenRefreshClickhouseRow(options: {
  projectId: string,
  userId: string,
  refreshTokenId: string,
  eventAt: Date,
  ipAddress: string,
  location: (typeof sessionActivityLocations)[number],
}): Record<string, unknown> {
  const { projectId, userId, refreshTokenId, eventAt, ipAddress, location } = options;
  return {
    event_type: '$token-refresh',
    // Always emit the ClickHouse `YYYY-MM-DD HH:MM:SS.mmm` string form so every
    // caller (the historical and live seeders) writes `event_at` identically.
    event_at: formatClickhouseTimestamp(eventAt),
    data: {
      refresh_token_id: refreshTokenId,
      is_anonymous: false,
      ip_info: {
        ip: ipAddress,
        is_trusted: true,
        country_code: location.countryCode,
        region_code: location.regionCode,
        city_name: location.cityName,
        latitude: location.latitude,
        longitude: location.longitude,
        tz_identifier: location.tzIdentifier,
      },
    },
    project_id: projectId,
    branch_id: DEFAULT_BRANCH_ID,
    user_id: userId,
    team_id: null,
    refresh_token_id: refreshTokenId,
    session_replay_id: null,
    session_replay_segment_id: null,
  };
}

async function seedDummySessionActivityEvents(options: SessionActivityEventSeedOptions) {
  const { tenancyId, projectId, userEmailToId, freshProject } = options;

  // Anchor on midnight today so the seeded window is stable across re-runs
  // within the same day. Across days the window legitimately shifts forward.
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const twoMonthsAgo = new Date(todayUtc);
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);
  const windowMs = todayUtc.getTime() - twoMonthsAgo.getTime();

  const userIds = Array.from(userEmailToId.values());
  const systemEventTypeIds = ['$session-activity', '$user-activity', '$project-activity', '$project'];

  console.log(`Seeding session activity events for ${userIds.length} users...`);

  const eventIpInfos: Prisma.EventIpInfoCreateManyInput[] = [];
  const events: Prisma.EventCreateManyInput[] = [];
  const clickhouseRows: Array<Record<string, unknown>> = [];

  const clickhouseUrl = getEnvVariable('STACK_CLICKHOUSE_URL', '');
  const shouldSeedClickhouse = clickhouseUrl !== '';
  const clickhouseClient = shouldSeedClickhouse ? options.clickhouseClient : null;

  for (const userId of userIds) {
    // Per-user seeded PRNG so event count, timestamps, and locations are
    // deterministic across re-runs. Deterministic IDs mean seeded rows can be
    // replaced in bulk while staying idempotent across runs.
    const userRand = deterministicPrng(seedFromString(`session-events:${tenancyId}:${userId}`));
    const eventCount = 15 + Math.floor(userRand() * 11); // 15-25 events

    for (let i = 0; i < eventCount; i++) {
      const randomTime = new Date(twoMonthsAgo.getTime() + userRand() * windowMs);
      const location = sessionActivityLocations[Math.floor(userRand() * sessionActivityLocations.length)]!;
      const sessionId = `session-${userId.substring(0, 8)}-${i.toString().padStart(3, '0')}`;
      const ipAddress = `${10 + Math.floor(userRand() * 200)}.${Math.floor(userRand() * 256)}.${Math.floor(userRand() * 256)}.${Math.floor(userRand() * 256)}`;
      const refreshTokenId = deterministicUuid(`session-events-refresh-token:${tenancyId}:${userId}:${i}`);

      const ipInfoId = deterministicUuid(`event-ip-info:${tenancyId}:${userId}:${i}`);
      const eventId = deterministicUuid(`event:${tenancyId}:${userId}:${i}`);

      eventIpInfos.push({
        id: ipInfoId,
        ip: ipAddress,
        countryCode: location.countryCode,
        regionCode: location.regionCode,
        cityName: location.cityName,
        latitude: location.latitude,
        longitude: location.longitude,
        tzIdentifier: location.tzIdentifier,
        createdAt: randomTime,
        updatedAt: randomTime,
      });

      events.push({
        id: eventId,
        systemEventTypeIds,
        data: {
          projectId,
          branchId: DEFAULT_BRANCH_ID,
          userId,
          sessionId,
          isAnonymous: false,
        },
        isEndUserIpInfoGuessTrusted: true,
        endUserIpInfoGuessId: ipInfoId,
        isWide: false,
        eventStartedAt: randomTime,
        eventEndedAt: randomTime,
        createdAt: randomTime,
        updatedAt: randomTime,
      });

      if (clickhouseClient) {
        clickhouseRows.push(buildTokenRefreshClickhouseRow({
          projectId,
          userId,
          refreshTokenId,
          eventAt: randomTime,
          ipAddress,
          location,
        }));
      }
    }
  }

  await globalPrismaClient.$transaction(async (tx) => {
    // On a fresh project the deterministic IDs can't already exist, so skip the
    // delete-before-insert that keeps re-seeds idempotent.
    if (!freshProject) {
      const eventIds = events.map((event) => event.id ?? throwErr('Seeded event row is missing id'));
      const ipInfoIds = eventIpInfos.map((info) => info.id ?? throwErr('Seeded event IP info row is missing id'));

      await tx.event.deleteMany({
        where: {
          id: { in: eventIds },
        },
      });
      await tx.eventIpInfo.deleteMany({
        where: {
          id: { in: ipInfoIds },
        },
      });
    }

    await tx.eventIpInfo.createMany({
      data: eventIpInfos,
    });
    await tx.event.createMany({
      data: events,
    });
  }, {
    // Under cross-arch arm64 TCG in the emulator qcow2 build, this batch
    // has been observed to take 40-50s; Prisma's default is 5s. Production
    // (KVM/native) runs it in well under 1s, so the looser bound only kicks
    // in when the DB is genuinely slow.
    timeout: 90_000,
  });

  if (clickhouseClient && clickhouseRows.length > 0) {
    // Large batches: ClickHouse ingests tens of thousands of rows per insert
    // happily, so a bigger batch means far fewer HTTP round-trips.
    const BATCH_SIZE = 10_000;
    const clickhouseBatches: Array<typeof clickhouseRows> = [];
    for (let i = 0; i < clickhouseRows.length; i += BATCH_SIZE) {
      clickhouseBatches.push(clickhouseRows.slice(i, i + BATCH_SIZE));
    }
    await Promise.all(clickhouseBatches.map((batch) => clickhouseClient.insert({
      table: 'analytics_internal.events',
      values: batch,
      format: 'JSONEachRow',
      clickhouse_settings: {
        date_time_input_format: 'best_effort',
        async_insert: 1,
      },
    })));
  }

  console.log(`Finished seeding session activity events (${events.length} events)`);
}

/**
 * Seeds the dummy project with a bulk batch of fake user sign-ups and
 * realistic activity data spread across recent history and various
 * geographic regions. Populates:
 *
 *   1. ProjectUser rows with back-dated signedUpAt/createdAt
 *   2. $token-refresh events in ClickHouse with geolocated ip_info
 *   3. $page-view events in ClickHouse for daily visitors/page views/referrers
 *   4. $click events in ClickHouse for the clicks chart
 */
async function seedBulkSignupsAndActivity(options: {
  tenancy: Tenancy,
  prisma: PrismaClientTransaction,
  freshProject: boolean,
  clickhouseClient: ClickHouseClient,
  count?: number,
  days?: number,
}) {
  const count = options.count ?? 500;
  const days = options.days ?? 60;
  const now = new Date();
  const rand = deterministicPrng(0xC0FFEE);
  const { tenancy, prisma, freshProject } = options;
  const clickhouse = options.clickhouseClient;

  console.log(`[seed-activity] Target: ${count} users across ${days} days in project "${tenancy.project.id}" branch "${tenancy.branchId}"`);

  const dayOffsets = distributeBulkSignups(count, days, rand, now);
  const clickhouseRows: Array<Record<string, unknown>> = [];

  let created = 0;
  let updated = 0;

  const seedUsers: Array<{
    index: number,
    email: string,
    displayName: string,
    signedUpAt: Date,
    signupDaysAgo: number,
    region: BulkActivityRegion,
    primaryEmailVerified: boolean,
    projectUserId: string,
  }> = [];
  for (let i = 0; i < count; i++) {
    const firstName = BULK_FIRST_NAMES[Math.floor(rand() * BULK_FIRST_NAMES.length)]!;
    const lastName = BULK_LAST_NAMES[Math.floor(rand() * BULK_LAST_NAMES.length)]!;
    const displayName = `${firstName} ${lastName}`;
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}.signupseed${i}@dummy.dev`;
    const signedUpAt = bulkRandomTimestampOnDay(now, dayOffsets[i]!, rand);
    const region = pickBulkActivityRegion(rand);
    const primaryEmailVerified = rand() > 0.25;
    seedUsers.push({
      index: i,
      email,
      displayName,
      signedUpAt,
      signupDaysAgo: dayOffsets[i]!,
      region,
      primaryEmailVerified,
      projectUserId: deterministicUuid(`bulk-signup-user:${tenancy.id}:${email}`),
    });
  }

  // Idempotency: find seed users that already exist so they're updated rather
  // than re-created. Skipped for a fresh project, where nothing can pre-exist.
  const existingContactChannels = freshProject ? [] : await prisma.contactChannel.findMany({
    where: {
      tenancyId: tenancy.id,
      type: 'EMAIL',
      isPrimary: 'TRUE',
      usedForAuth: 'TRUE',
      value: { in: seedUsers.map((seedUser) => seedUser.email) },
    },
    select: {
      value: true,
      projectUserId: true,
    },
  });

  const existingUserIdByEmail = new Map<string, string>();
  for (const existingContactChannel of existingContactChannels) {
    const existingUserId = existingUserIdByEmail.get(existingContactChannel.value);
    if (existingUserId != null && existingUserId !== existingContactChannel.projectUserId) {
      throwErr(`Expected one authenticated user per seed email (${existingContactChannel.value}), found multiple project users`);
    }
    existingUserIdByEmail.set(existingContactChannel.value, existingContactChannel.projectUserId);
  }

  const projectUsersToCreate: Prisma.ProjectUserCreateManyInput[] = [];
  const contactChannelsToCreate: Prisma.ContactChannelCreateManyInput[] = [];
  const userActivity: Array<{ userId: string, signupDaysAgo: number, region: BulkActivityRegion, signedUpAt: Date }> = [];
  // Only users that already existed need a timestamp UPDATE afterwards — the
  // `createMany` below already writes correct createdAt/signedUpAt for every
  // newly-inserted row, so re-updating them would be pure wasted work.
  const usersToBackdate: Array<{ userId: string, signedUpAt: Date }> = [];

  for (const seedUser of seedUsers) {
    const userId = existingUserIdByEmail.get(seedUser.email) ?? seedUser.projectUserId;
    const existingUserId = existingUserIdByEmail.get(seedUser.email);
    if (existingUserId == null) {
      created++;
      projectUsersToCreate.push({
        tenancyId: tenancy.id,
        projectUserId: userId,
        mirroredProjectId: tenancy.project.id,
        mirroredBranchId: tenancy.branchId,
        displayName: seedUser.displayName,
        isAnonymous: false,
        createdAt: seedUser.signedUpAt,
        lastActiveAt: seedUser.signedUpAt,
        signedUpAt: seedUser.signedUpAt,
        signUpRiskScoreBot: 0,
        signUpRiskScoreFreeTrialAbuse: 0,
      });
      contactChannelsToCreate.push({
        tenancyId: tenancy.id,
        projectUserId: userId,
        type: 'EMAIL',
        isPrimary: 'TRUE',
        usedForAuth: 'TRUE',
        isVerified: seedUser.primaryEmailVerified,
        value: seedUser.email,
        createdAt: seedUser.signedUpAt,
        updatedAt: seedUser.signedUpAt,
      });
    } else {
      updated++;
      usersToBackdate.push({ userId, signedUpAt: seedUser.signedUpAt });
    }

    userActivity.push({
      userId,
      signupDaysAgo: seedUser.signupDaysAgo,
      region: seedUser.region,
      signedUpAt: seedUser.signedUpAt,
    });

    const ipInfoForUser = {
      ip: bulkFakeIp(seedUser.region.ipPrefix, rand),
      is_trusted: true,
      country_code: seedUser.region.country,
      region_code: seedUser.region.region,
      city_name: seedUser.region.city,
      latitude: seedUser.region.lat,
      longitude: seedUser.region.lon,
      tz_identifier: seedUser.region.tz,
    };

    clickhouseRows.push({
      event_type: '$token-refresh',
      event_at: formatClickhouseTimestamp(seedUser.signedUpAt),
      data: {
        refresh_token_id: randomUUID(),
        is_anonymous: false,
        ip_info: ipInfoForUser,
      },
      project_id: tenancy.project.id,
      branch_id: tenancy.branchId,
      user_id: userId,
      team_id: null,
    });

    if ((seedUser.index + 1) % 100 === 0) {
      console.log(`[seed-activity] ${seedUser.index + 1}/${count} users processed (${created} new, ${updated} updated)`);
    }
  }

  if (projectUsersToCreate.length > 0) {
    await prisma.projectUser.createMany({
      data: projectUsersToCreate,
      skipDuplicates: true,
    });
  }
  if (contactChannelsToCreate.length > 0) {
    await prisma.contactChannel.createMany({
      data: contactChannelsToCreate,
      skipDuplicates: true,
    });
  }

  if (usersToBackdate.length > 0) {
    const seededTimestampRows = usersToBackdate.map((u) => Prisma.sql`(${u.userId}::uuid, ${u.signedUpAt}::timestamptz)`);
    await prisma.$executeRaw`
      UPDATE "ProjectUser" AS pu
      SET "createdAt" = seeded.signed_up_at,
          "signedUpAt" = seeded.signed_up_at
      FROM (VALUES ${Prisma.join(seededTimestampRows)}) AS seeded(project_user_id, signed_up_at)
      WHERE pu."tenancyId" = ${tenancy.id}
        AND pu."projectUserId" = seeded.project_user_id
    `;
  }

  console.log(`[seed-activity] Generating multi-day activity events for ${userActivity.length} users...`);

  for (const { userId, signupDaysAgo, region } of userActivity) {
    if (signupDaysAgo === 0) continue;
    const isReturning = rand() < 0.7;
    if (!isReturning) continue;

    const returnVisits = 2 + Math.floor(rand() * 7);
    const ipInfo = {
      ip: bulkFakeIp(region.ipPrefix, rand),
      is_trusted: true,
      country_code: region.country,
      region_code: region.region,
      city_name: region.city,
      latitude: region.lat,
      longitude: region.lon,
      tz_identifier: region.tz,
    };

    for (let v = 0; v < returnVisits; v++) {
      const visitDaysAgo = Math.floor(rand() * signupDaysAgo);
      const visitTime = bulkRandomTimestampOnDay(now, visitDaysAgo, rand);

      clickhouseRows.push({
        event_type: '$token-refresh',
        event_at: formatClickhouseTimestamp(visitTime),
        data: {
          refresh_token_id: randomUUID(),
          is_anonymous: false,
          ip_info: ipInfo,
        },
        project_id: tenancy.project.id,
        branch_id: tenancy.branchId,
        user_id: userId,
        team_id: null,
      });

      const pageViewCount = 1 + Math.floor(rand() * 4);
      for (let p = 0; p < pageViewCount; p++) {
        const pvOffset = Math.floor(rand() * 3600) * 1000;
        // Clamp to `now`: visitTime is already clamped, but adding the offset
        // can push a same-day event past `now` into the future.
        const pvTime = new Date(Math.min(visitTime.getTime() + pvOffset, now.getTime()));
        clickhouseRows.push({
          event_type: '$page-view',
          event_at: formatClickhouseTimestamp(pvTime),
          data: {
            path: BULK_PAGE_PATHS[Math.floor(rand() * BULK_PAGE_PATHS.length)],
            referrer: p === 0 ? pickBulkReferrer(rand) : '',
            is_anonymous: false,
          },
          project_id: tenancy.project.id,
          branch_id: tenancy.branchId,
          user_id: userId,
          team_id: null,
        });
      }

      if (rand() < 0.4) {
        const clickOffset = Math.floor(rand() * 1800) * 1000;
        // Clamp to `now` so the offset can't push the event into the future.
        const clickTime = new Date(Math.min(visitTime.getTime() + clickOffset, now.getTime()));
        clickhouseRows.push({
          event_type: '$click',
          event_at: formatClickhouseTimestamp(clickTime),
          data: {
            selector: 'button.cta-primary',
            is_anonymous: false,
          },
          project_id: tenancy.project.id,
          branch_id: tenancy.branchId,
          user_id: userId,
          team_id: null,
        });
      }
    }
  }

  console.log(`[seed-activity] Flushing ${clickhouseRows.length} events to ClickHouse...`);
  // Large batches: ClickHouse ingests tens of thousands of rows per insert
  // happily, so a bigger batch means far fewer HTTP round-trips.
  const BATCH = 10_000;
  const clickhouseBatches: Array<Array<Record<string, unknown>>> = [];
  for (let i = 0; i < clickhouseRows.length; i += BATCH) {
    clickhouseBatches.push(clickhouseRows.slice(i, i + BATCH));
  }
  await Promise.all(clickhouseBatches.map((batch) => clickhouse.insert({
    table: 'analytics_internal.events',
    values: batch,
    format: 'JSONEachRow',
    clickhouse_settings: {
      date_time_input_format: 'best_effort',
      async_insert: 1,
    },
  })));

  const tokenRefreshCount = clickhouseRows.filter(r => r.event_type === '$token-refresh').length;
  const pageViewCount = clickhouseRows.filter(r => r.event_type === '$page-view').length;
  const clickCount = clickhouseRows.filter(r => r.event_type === '$click').length;

  console.log(`[seed-activity] Done. created=${created} updated=${updated}`);
  console.log(`[seed-activity] Events: $token-refresh=${tokenRefreshCount} $page-view=${pageViewCount} $click=${clickCount} total=${clickhouseRows.length}`);
}

/**
 * Creates a new project and fills it with dummy data (users, teams, payments, emails, analytics events).
 * Used by both the seed script and the preview project creation endpoint.
 */
export async function seedDummyProject(options: SeedDummyProjectOptions): Promise<string> {
  const projectId = options.projectId ?? randomUUID();

  const baseProjectData = {
    display_name: 'Demo Project',
    is_production_mode: false,
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
      oauth_providers: options.oauthProviderIds.map((id) => ({
        id: id as any,
        type: 'shared',
      })),
      domains: [],
    },
  } satisfies ProjectsCrud["Admin"]["Update"];
  const projectCreateData: AdminUserProjectsCrud["Admin"]["Create"] = {
    ...baseProjectData,
    owner_team_id: options.ownerTeamId,
  };

  const existingProject = await getProject(projectId);
  if (!existingProject) {
    await createOrUpdateProjectWithLegacyConfig({
      type: 'create',
      projectId,
      data: projectCreateData,
    });
  } else {
    await createOrUpdateProjectWithLegacyConfig({
      type: 'update',
      projectId,
      branchId: DEFAULT_BRANCH_ID,
      data: baseProjectData,
    });
  }

  // A brand-new project can't have any pre-existing seed rows, so every seeder
  // can skip its idempotency machinery (existence probes, delete-before-insert).
  // The preview create-project route always hits this path; only the seed
  // script re-running against an existing project needs the idempotent path.
  const freshProject = !existingProject;

  // A single ClickHouse client reused by every analytics seeder below, so the
  // connection / TLS handshake is established once instead of once per seeder.
  // The preview create-project route passes in a client it already warmed up.
  const clickhouseClient = options.clickhouseClient ?? getClickhouseAdminClient();

  // The ClickHouse `analytics_internal.events` table is append-only — unlike
  // the Postgres seeders there is no delete-before-insert. When reseeding an
  // existing project, clear this project's previously-seeded events once, up
  // front (before the concurrent event seeders start), so the reseed refreshes
  // the analytics rather than duplicating them. A fresh project has none.
  if (!freshProject) {
    await clickhouseClient.command({
      query: 'DELETE FROM analytics_internal.events WHERE project_id = {projectId:String}',
      query_params: { projectId },
    });
  }

  const dummyTenancy = await getSoleTenancyFromProjectBranch(projectId, DEFAULT_BRANCH_ID);
  const dummyPrisma = await getPrismaClientForTenancy(dummyTenancy);

  const teamNameToId = await seedDummyTeams({
    prisma: dummyPrisma,
    tenancy: dummyTenancy,
    freshProject,
  });

  const userEmailToId = await seedDummyUsers({
    prisma: dummyPrisma,
    tenancy: dummyTenancy,
    teamNameToId,
    freshProject,
  });
  const { paymentsProducts, paymentsBranchOverride } = buildDummyPaymentsSetup();

  // seedBulkSignupsAndActivity is also a Postgres-write-heavy bulk job, so we
  // deliberately do NOT overlap it with user seeding — two bulk writers on the
  // same database contend and each slows down. Kick it off here, once user
  // seeding is done, to overlap with the lighter (and partly ClickHouse-bound)
  // remaining steps instead.
  const bulkSignupsPromise = seedBulkSignupsAndActivity({
    tenancy: dummyTenancy,
    prisma: dummyPrisma,
    freshProject,
    clickhouseClient,
  });

  await Promise.all([
    overrideBranchConfigOverride({
      projectId,
      branchId: DEFAULT_BRANCH_ID,
      branchConfigOverrideOverride: {
        auth: {
          signUpRulesDefaultAction: "allow",
          signUpRules: {
            "allow-dummy-domain": {
              enabled: true,
              displayName: "Allow @dummy.dev",
              priority: 4,
              condition: 'emailDomain == "dummy.dev"',
              action: {
                type: "allow",
              },
            },
            "block-disposable-emails": {
              enabled: true,
              displayName: "Block disposable emails",
              priority: 3,
              condition: 'emailDomain.matches("(?i)mailinator\\\\.com|tempmail\\\\.com")',
              action: {
                type: "reject",
                message: "Disposable emails are not allowed",
              },
            },
            "restrict-free-domains": {
              enabled: true,
              displayName: "Restrict free email domains",
              priority: 2,
              condition: 'emailDomain in ["gmail.com", "yahoo.com", "outlook.com"]',
              action: {
                type: "restrict",
              },
            },
            "log-test-prefix": {
              enabled: true,
              displayName: "Log test+ emails",
              priority: 1,
              condition: 'email.startsWith("test+")',
              action: {
                type: "log",
              },
            },
          },
        },
        payments: paymentsBranchOverride as any,
        apps: {
          installed: typedFromEntries(typedEntries(ALL_APPS)
            .filter(([, app]) => !options.excludeAlphaApps || app.stage !== "alpha")
            .map(([key]) => [key, { enabled: true }])),
        },
      },
    }),
    overrideEnvironmentConfigOverride({
      projectId,
      branchId: DEFAULT_BRANCH_ID,
      environmentConfigOverrideOverride: {
        "payments.testMode": true,
      },
    }),
    ...options.skipGithubConfigSource ? [] : [setBranchConfigOverrideSource({
      projectId,
      branchId: DEFAULT_BRANCH_ID,
      source: {
        type: "pushed-from-github",
        owner: "hexclave",
        repo: "config-test",
        branch: "main",
        commit_hash: "abc123def456789",
        config_file_path: "hexclave.config.ts",
        workflow_path: ".github/workflows/hexclave-config-sync.yml",
      },
    })],
    globalPrismaClient.project.update({
      where: {
        id: projectId,
      },
      data: {
        stripeAccountId: "sample-stripe-account-id"
      },
    }),
    // Data seeding runs alongside the config-override writes above — they touch
    // different tables and don't depend on each other. Payments seeding is
    // intentionally excluded here; it's deferred to the very end (see below).
    seedDummyEmails({
      prisma: dummyPrisma,
      tenancyId: dummyTenancy.id,
      userEmailToId,
    }),
    seedDummyDeployments({
      prisma: dummyPrisma,
      tenancyId: dummyTenancy.id,
    }),
    seedDummySessionActivityEvents({
      tenancyId: dummyTenancy.id,
      projectId,
      userEmailToId,
      freshProject,
      clickhouseClient,
    }),
    seedDummySessionReplays({
      prisma: dummyPrisma,
      tenancyId: dummyTenancy.id,
      projectId,
      clickhouseClient,
      userEmailToId,
      freshProject,
    }),
  ]);

  // Wait for the concurrently-started bulk signup/activity seeding to finish.
  await bulkSignupsPromise;

  // Populate the ClickHouse tables the overview reads. Both run together: they
  // write distinct tables and don't depend on each other.
  //  - seedDummyAnalyticsMirrorTables mirrors the freshly-seeded
  //    users/teams/contact channels into `analytics_internal.*` so the internal
  //    metrics endpoint reports non-zero user/team totals. In production those
  //    tables are filled by the external-db-sync pipeline, but preview/demo
  //    deployments don't run it — so the seed populates them directly, just
  //    like it already writes `analytics_internal.events`.
  //  - seedDummyLiveTokenRefreshEvents plants "live" activity. It stays in the
  //    last step so the events are as fresh as possible when the dashboard
  //    loads the overview right after creation.
  await Promise.all([
    seedDummyAnalyticsMirrorTables({
      prisma: dummyPrisma,
      tenancyId: dummyTenancy.id,
      projectId,
      clickhouseClient,
    }),
    seedDummyLiveTokenRefreshEvents({
      prisma: dummyPrisma,
      tenancyId: dummyTenancy.id,
      projectId,
      clickhouseClient,
    }),
  ]);

  // Payments data (subscriptions, invoices, …) backs only the billing pages,
  // not the overview the dashboard shows first. In preview mode, seed it as a
  // fire-and-forget background task so a slow payments seed doesn't delay the
  // route response — `runAsynchronouslyAndWaitUntil` keeps the serverless
  // function alive until it finishes. Outside preview mode (e.g. the seed
  // script) it must complete before returning.
  const seedPayments = () => seedDummyTransactions({
    prisma: dummyPrisma,
    tenancyId: dummyTenancy.id,
    teamNameToId,
    paymentsProducts,
  });
  if (isPreviewModeEnabled()) {
    runAsynchronouslyAndWaitUntil(seedPayments);
  } else {
    await seedPayments();
  }

  return projectId;
}

// How many users to surface as currently "live" on the overview globe.
const LIVE_USERS_SEED_COUNT = 8;

/**
 * Inserts a handful of `$token-refresh` events timestamped at ~now so the
 * overview globe's live-user avatars and the "Live" badge are populated.
 *
 * The metrics endpoint classifies a user as "live" when they have a
 * `$token-refresh` event in the last ~2 minutes, measured at query time.
 * Preview/demo deployments have no real traffic, so the seed plants this
 * activity itself. It is emitted as the final seed step (and re-emitted on
 * every re-seed) so the events are as fresh as possible — note the live count
 * naturally decays once the events age past the ~2-minute window.
 */
async function seedDummyLiveTokenRefreshEvents(options: {
  prisma: TenancyPrismaClient,
  tenancyId: string,
  projectId: string,
  clickhouseClient: ClickHouseClient,
}): Promise<void> {
  const { prisma, tenancyId, projectId, clickhouseClient } = options;

  if (getEnvVariable('STACK_CLICKHOUSE_URL', '') === '') {
    return;
  }

  const users = await prisma.projectUser.findMany({
    where: { tenancyId, isAnonymous: false },
    orderBy: { projectUserId: 'asc' },
    take: LIVE_USERS_SEED_COUNT,
  });
  if (users.length === 0) {
    return;
  }

  // One location per distinct country (the locations list repeats some
  // countries) so the live-user avatars spread across the globe rather than
  // stacking on the same spot.
  const liveLocations: typeof sessionActivityLocations = [];
  const seenCountries = new Set<string>();
  for (const location of sessionActivityLocations) {
    if (seenCountries.has(location.countryCode)) {
      continue;
    }
    seenCountries.add(location.countryCode);
    liveLocations.push(location);
    if (liveLocations.length === LIVE_USERS_SEED_COUNT) {
      break;
    }
  }
  const now = Date.now();

  const clickhouseRows = users.map((user, index) => buildTokenRefreshClickhouseRow({
    projectId,
    userId: user.projectUserId,
    refreshTokenId: randomUUID(),
    // Emit at ~now with only a tiny stagger so every event stays well inside
    // the ~2-minute live window even after seed + dashboard-load latency.
    eventAt: new Date(now - index * 1000),
    ipAddress: `203.0.113.${10 + index}`,
    location: liveLocations[index % liveLocations.length]!,
  }));

  // Synchronous insert (no async_insert) so the events are immediately
  // queryable when the dashboard loads the overview right after creation.
  await clickhouseClient.insert({
    table: 'analytics_internal.events',
    values: clickhouseRows,
    format: 'JSONEachRow',
    clickhouse_settings: { date_time_input_format: 'best_effort' },
  });
}

/**
 * Mirrors the seeded users / teams / contact channels into the ClickHouse
 * `analytics_internal.*` tables so the internal metrics endpoint can report
 * non-zero user/team totals without depending on the external-db-sync
 * pipeline (which preview/demo deployments don't run).
 */
async function seedDummyAnalyticsMirrorTables(options: {
  prisma: TenancyPrismaClient,
  tenancyId: string,
  projectId: string,
  clickhouseClient: ClickHouseClient,
}): Promise<void> {
  const { prisma, tenancyId, projectId, clickhouseClient } = options;

  if (getEnvVariable('STACK_CLICKHOUSE_URL', '') === '') {
    return;
  }

  const [users, contactChannels, teams] = await Promise.all([
    prisma.projectUser.findMany({ where: { tenancyId } }),
    prisma.contactChannel.findMany({ where: { tenancyId } }),
    prisma.team.findMany({ where: { tenancyId } }),
  ]);

  // Primary contact channel per user — drives primary_email and the verified /
  // unverified user split on the overview page. Seeded channels are all EMAIL.
  const primaryEmailByUser = new Map<string, { value: string, isVerified: boolean }>();
  for (const cc of contactChannels) {
    if (cc.isPrimary === BooleanTrue.TRUE) {
      primaryEmailByUser.set(cc.projectUserId, { value: cc.value, isVerified: cc.isVerified });
    }
  }

  // `analytics_internal.*` are ReplacingMergeTree(sync_sequence_id) tables.
  // Rows synced by the real external-db-sync pipeline are versioned from the
  // `global_seq_id` Postgres sequence, which starts at 1 — so version 0
  // guarantees that if that pipeline ever runs for this project, any real
  // update/delete supersedes the directly-seeded placeholder row under FINAL.
  // (Re-seeds insert equal versions; ReplacingMergeTree keeps the most
  // recently inserted row, i.e. the newer seed.)
  const SEED_SYNC_SEQUENCE_ID = 0;

  const userRows = users.map((u) => {
    const primaryEmail = primaryEmailByUser.get(u.projectUserId);
    return {
      project_id: projectId,
      branch_id: DEFAULT_BRANCH_ID,
      id: u.projectUserId,
      display_name: u.displayName,
      profile_image_url: u.profileImageUrl,
      primary_email: primaryEmail?.value ?? null,
      primary_email_verified: primaryEmail?.isVerified ? 1 : 0,
      signed_up_at: formatClickhouseTimestamp(u.signedUpAt),
      client_metadata: JSON.stringify(u.clientMetadata ?? {}),
      client_read_only_metadata: JSON.stringify(u.clientReadOnlyMetadata ?? {}),
      server_metadata: JSON.stringify(u.serverMetadata ?? {}),
      is_anonymous: u.isAnonymous ? 1 : 0,
      sign_up_risk_score_bot: u.signUpRiskScoreBot,
      sign_up_risk_score_free_trial_abuse: u.signUpRiskScoreFreeTrialAbuse,
      restricted_by_admin: u.restrictedByAdmin ? 1 : 0,
      restricted_by_admin_reason: u.restrictedByAdminReason,
      restricted_by_admin_private_details: u.restrictedByAdminPrivateDetails,
      sync_sequence_id: SEED_SYNC_SEQUENCE_ID,
      sync_is_deleted: 0,
    };
  });

  const teamRows = teams.map((t) => ({
    project_id: projectId,
    branch_id: DEFAULT_BRANCH_ID,
    id: t.teamId,
    display_name: t.displayName,
    profile_image_url: t.profileImageUrl,
    created_at: formatClickhouseTimestamp(t.createdAt),
    client_metadata: JSON.stringify(t.clientMetadata ?? {}),
    client_read_only_metadata: JSON.stringify(t.clientReadOnlyMetadata ?? {}),
    server_metadata: JSON.stringify(t.serverMetadata ?? {}),
    sync_sequence_id: SEED_SYNC_SEQUENCE_ID,
    sync_is_deleted: 0,
  }));

  const contactChannelRows = contactChannels.map((cc) => ({
    project_id: projectId,
    branch_id: DEFAULT_BRANCH_ID,
    id: cc.id,
    user_id: cc.projectUserId,
    type: cc.type,
    value: cc.value,
    is_primary: cc.isPrimary === BooleanTrue.TRUE ? 1 : 0,
    is_verified: cc.isVerified ? 1 : 0,
    used_for_auth: cc.usedForAuth === BooleanTrue.TRUE ? 1 : 0,
    created_at: formatClickhouseTimestamp(cc.createdAt),
    sync_sequence_id: SEED_SYNC_SEQUENCE_ID,
    sync_is_deleted: 0,
  }));

  // Synchronous insert (no async_insert) so the rows are immediately queryable
  // when the dashboard loads the overview right after project creation.
  const insertTable = async (table: string, values: Array<Record<string, unknown>>) => {
    if (values.length === 0) {
      return;
    }
    await clickhouseClient.insert({
      table,
      values,
      format: 'JSONEachRow',
      clickhouse_settings: { date_time_input_format: 'best_effort' },
    });
  };
  await Promise.all([
    insertTable('analytics_internal.users', userRows),
    insertTable('analytics_internal.teams', teamRows),
    insertTable('analytics_internal.contact_channels', contactChannelRows),
  ]);
}

// Device/browser strings the replay seeder cycles through, so the dashboard's
// replay overview shows a realistic spread of desktop, mobile and tablet
// sessions instead of one hardcoded browser.
const SESSION_REPLAY_DEVICES = [
  { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', screenWidth: 2560, screenHeight: 1440, viewportWidth: 1512, viewportHeight: 916 },
  { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.3485.66', screenWidth: 1920, screenHeight: 1080, viewportWidth: 1920, viewportHeight: 969 },
  { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15', screenWidth: 1728, screenHeight: 1117, viewportWidth: 1440, viewportHeight: 810 },
  { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1', screenWidth: 393, screenHeight: 852, viewportWidth: 393, viewportHeight: 659 },
  { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', screenWidth: 412, screenHeight: 915, viewportWidth: 412, viewportHeight: 780 },
  { userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/604.1', screenWidth: 1024, screenHeight: 1366, viewportWidth: 1024, viewportHeight: 1219 },
  { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0', screenWidth: 1920, screenHeight: 1200, viewportWidth: 1680, viewportHeight: 1050 },
];

async function seedDummySessionReplays({
  prisma,
  tenancyId,
  projectId,
  clickhouseClient,
  userEmailToId,
  freshProject,
  targetSessionReplayCount = 250,
}: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
  projectId: string,
  clickhouseClient: ClickHouseClient,
  userEmailToId: Map<string, string>,
  freshProject: boolean,
  targetSessionReplayCount?: number,
}) {
  const userIds = Array.from(userEmailToId.values());
  if (userIds.length === 0) {
    throw new Error('Cannot seed session replays: no dummy project users exist');
  }

  // Anchor on midnight today so the seeded window is stable across re-runs
  // within the same day.
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const twoWeeksAgo = new Date(todayUtc);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const windowMs = todayUtc.getTime() - twoWeeksAgo.getTime();

  // Single seeded PRNG keyed off tenancy so the whole replay set is
  // deterministic across re-runs and identical IDs upsert in place.
  const rand = deterministicPrng(seedFromString(`session-replays:${tenancyId}`));

  const seeds: Prisma.SessionReplayCreateManyInput[] = [];
  const clickhouseRows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < targetSessionReplayCount; i++) {
    const startedAt = new Date(twoWeeksAgo.getTime() + rand() * windowMs);
    const durationMs = 10_000 + Math.floor(rand() * (20 * 60 * 1000)); // 10s..20m
    const lastEventAt = new Date(startedAt.getTime() + durationMs);
    const projectUserId = userIds[Math.floor(rand() * userIds.length)]!;
    const replayId = deterministicUuid(`session-replay:${tenancyId}:${i}`);
    const refreshTokenId = deterministicUuid(`session-replay-refresh-token:${tenancyId}:${i}`);
    // The overview's bounce rate and average session duration group events by
    // segment (one browser tab), skipping rows where it's null, so seeded events
    // need one too — the browser SDK always sends it.
    const segmentId = deterministicUuid(`session-replay-segment:${tenancyId}:${i}`);

    seeds.push({
      tenancyId,
      refreshTokenId,
      projectUserId,
      id: replayId,
      startedAt,
      lastEventAt,
    });

    // The dashboard reads the device, entry page, referrer and location of a
    // replay from the analytics events recorded alongside it, so a replay
    // without events would render a header full of blanks. Seed the same event
    // shapes the browser SDK emits.
    const device = SESSION_REPLAY_DEVICES[Math.floor(rand() * SESSION_REPLAY_DEVICES.length)]!;
    const location = sessionActivityLocations[Math.floor(rand() * sessionActivityLocations.length)]!;
    clickhouseRows.push(buildTokenRefreshClickhouseRow({
      projectId,
      userId: projectUserId,
      refreshTokenId,
      eventAt: startedAt,
      ipAddress: bulkFakeIp(`${10 + Math.floor(rand() * 200)}.${Math.floor(rand() * 256)}`, rand),
      location,
    }));

    const pageViewCount = 1 + Math.floor(rand() * 4);
    for (let p = 0; p < pageViewCount; p++) {
      const path = BULK_PAGE_PATHS[Math.floor(rand() * BULK_PAGE_PATHS.length)]!;
      clickhouseRows.push({
        event_type: '$page-view',
        event_at: formatClickhouseTimestamp(new Date(startedAt.getTime() + Math.floor((durationMs * p) / pageViewCount))),
        data: {
          url: `https://demo.hexclave.com${path}`,
          path,
          // Only the session's first page-view has a referrer; later ones are
          // internal navigations, exactly like in the real SDK.
          referrer: p === 0 ? pickBulkReferrer(rand) : '',
          title: 'Demo Project',
          user_agent: device.userAgent,
          screen_width: device.screenWidth,
          screen_height: device.screenHeight,
          viewport_width: device.viewportWidth,
          viewport_height: device.viewportHeight,
          is_anonymous: false,
        },
        project_id: projectId,
        branch_id: DEFAULT_BRANCH_ID,
        user_id: projectUserId,
        team_id: null,
        refresh_token_id: refreshTokenId,
        session_replay_id: replayId,
        session_replay_segment_id: segmentId,
      });
    }

    const clickCount = Math.floor(rand() * 12);
    for (let c = 0; c < clickCount; c++) {
      clickhouseRows.push({
        event_type: '$click',
        event_at: formatClickhouseTimestamp(new Date(startedAt.getTime() + Math.floor(rand() * durationMs))),
        data: {
          selector: 'button.cta-primary',
          tag_name: 'button',
          text: 'Get started',
          user_agent: device.userAgent,
          is_anonymous: false,
        },
        project_id: projectId,
        branch_id: DEFAULT_BRANCH_ID,
        user_id: projectUserId,
        team_id: null,
        refresh_token_id: refreshTokenId,
        session_replay_id: replayId,
        session_replay_segment_id: segmentId,
      });
    }
  }

  // Delete existing deterministic IDs first, then bulk-insert (Prisma createMany
  // doesn't support upsert, so we delete+recreate to refresh timestamps). On a
  // fresh project nothing pre-exists, so the delete is skipped.
  if (!freshProject) {
    const seedIds = seeds.map((s) => s.id!);
    await prisma.sessionReplay.deleteMany({
      where: {
        tenancyId,
        id: { in: seedIds },
      },
    });
  }
  await prisma.sessionReplay.createMany({
    data: seeds,
  });

  // Self-hosted setups without ClickHouse still get the replay rows; only the
  // analytics-derived parts of the replay overview stay empty for them.
  const shouldSeedClickhouse = getEnvVariable('STACK_CLICKHOUSE_URL', '') !== '';
  if (shouldSeedClickhouse) {
    await clickhouseClient.insert({
      table: 'analytics_internal.events',
      values: clickhouseRows,
      format: 'JSONEachRow',
      clickhouse_settings: {
        date_time_input_format: 'best_effort',
        async_insert: 1,
      },
    });
  }

  console.log(`Seeded ${targetSessionReplayCount} session replays (${shouldSeedClickhouse ? clickhouseRows.length : 0} analytics events)`);
}

// Services for the demo project's Deployments app, across TWO deployment
// sources — the shape a project deployed from two repositories has, which is
// what the board's per-source colouring and its cross-source connections exist
// for. `storefront` is one repo holding a public serverless frontend;
// `platform` is another holding the private API it calls and the stateful
// `server` database behind that (only a `server` may hold a persistent volume).
//
// The interesting part is `web`'s API_URL: a connection into a service that
// another deploy file declares. Service ids are unique per PROJECT, so the
// reference names no source — and a map scoped to one source could not draw it.
const DUMMY_DEPLOYMENT_SOURCE_IDS = { storefront: 'storefront', platform: 'platform' } as const;

const DUMMY_DEPLOYMENT_SERVICES = [
  {
    sourceId: DUMMY_DEPLOYMENT_SOURCE_IDS.storefront,
    serviceId: 'web',
    type: 'serverless',
    isPublic: true,
    ports: { '3000': { protocol: 'http' } },
    minInstances: 0,
    maxInstances: 3,
    rootDirectory: './apps/web',
    dockerfilePath: null,
    volume: null,
    url: 'https://demo-web.hexclave.app',
    env: [
      ['NEXT_PUBLIC_SITE_NAME', { value: 'Demo' }],
      ['API_URL', { type: 'connection', value: 'api.url:8080' }],
    ],
  },
  {
    sourceId: DUMMY_DEPLOYMENT_SOURCE_IDS.platform,
    serviceId: 'api',
    type: 'serverless',
    isPublic: false,
    ports: { '8080': { protocol: 'http' } },
    minInstances: 0,
    maxInstances: 2,
    rootDirectory: './apps/api',
    dockerfilePath: 'Dockerfile',
    volume: null,
    url: null,
    env: [
      ['DATABASE_HOST', { type: 'connection', value: 'db.hostname' }],
      ['DATABASE_PORT', { value: '5432' }],
      ['OPENAI_API_KEY', { type: 'secret', key: 'OPENAI_API_KEY' }],
    ],
  },
  {
    sourceId: DUMMY_DEPLOYMENT_SOURCE_IDS.platform,
    serviceId: 'db',
    type: 'server',
    isPublic: false,
    ports: { '5432': { protocol: 'tcp' } },
    // A database is the case for an always-on server: suspended, nothing could
    // wake it, since its clients reach it over a raw TCP port.
    minInstances: 1,
    maxInstances: 1,
    rootDirectory: './database',
    dockerfilePath: 'Dockerfile',
    volume: { id: 'pgdata', path: '/data', sizeGb: 10 },
    url: null,
    env: [['POSTGRES_PASSWORD', { type: 'secret', key: 'POSTGRES_PASSWORD' }]],
  },
] as const;

// What each source's `hexclave deploy` PACKAGED, per deployment source. A deploy
// uploads one tree and every source-built service is built from it, so a
// manifest belongs to the source rather than to any one service — the Source tab
// slices it by each service's `rootDirectory`.
//
// Sized to demonstrate what the tab is FOR: `storefront`'s upload is dominated
// by one video and one image under `apps/web/public`, which is the shape of
// every "why is my deploy slow" question, and the answer is visible at a glance.
// Only files that survive .gitignore/.dockerignore are listed, because that is
// all a real manifest contains — which is what lets a reader use it to check
// that an ignore rule worked.
const DUMMY_DEPLOYMENT_SOURCE_FILES: Record<string, { path: string, bytes: number }[]> = {
  storefront: [
    { path: 'apps/web/public/hero.mp4', bytes: 5_412_880 },
    { path: 'apps/web/public/og-image.png', bytes: 842_190 },
    { path: 'apps/web/public/logo.svg', bytes: 11_204 },
    { path: 'apps/web/app/page.tsx', bytes: 6_118 },
    { path: 'apps/web/app/layout.tsx', bytes: 2_940 },
    { path: 'apps/web/app/globals.css', bytes: 2_301 },
    { path: 'apps/web/lib/api-client.ts', bytes: 1_884 },
    { path: 'apps/web/next.config.mjs', bytes: 612 },
    { path: 'apps/web/package.json', bytes: 918 },
    { path: 'hexclave.deploy.ts', bytes: 744 },
    { path: 'pnpm-workspace.yaml', bytes: 96 },
    { path: '.gitignore', bytes: 128 },
  ],
  platform: [
    { path: 'apps/api/vendor/geoip-city.mmdb', bytes: 2_180_640 },
    { path: 'apps/api/src/server.ts', bytes: 14_402 },
    { path: 'apps/api/src/routes/orders.ts', bytes: 8_770 },
    { path: 'apps/api/src/routes/catalog.ts', bytes: 6_205 },
    { path: 'apps/api/src/db/pool.ts', bytes: 1_540 },
    { path: 'apps/api/Dockerfile', bytes: 486 },
    { path: 'apps/api/package.json', bytes: 1_102 },
    { path: 'database/Dockerfile', bytes: 214 },
    { path: 'database/init/01-schema.sql', bytes: 4_860 },
    { path: 'database/init/02-seed.sql', bytes: 1_733 },
    { path: 'hexclave.deploy.ts', bytes: 1_026 },
    { path: '.dockerignore', bytes: 74 },
  ],
};

/**
 * The manifest a deploy of `sourceId` would have reported.
 *
 * Totals are DERIVED from the listing rather than written beside it, so the
 * fixture cannot drift into claiming a file count or a size its own files
 * contradict. The compression ratio is a plausible constant: these trees are
 * mostly already-compressed media, which barely shrinks.
 */
function dummySourceManifest(sourceId: string): Prisma.InputJsonValue {
  const files = DUMMY_DEPLOYMENT_SOURCE_FILES[sourceId] ?? throwErr(`no dummy source files for ${sourceId}`);
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  return {
    file_count: files.length,
    total_bytes: totalBytes,
    compressed_bytes: Math.round(totalBytes * 0.82),
    entries: [...files].sort((a, b) => b.bytes - a.bytes),
  };
}

// Deployments, newest last. Each entry is one `hexclave deploy` of ONE source:
// the services it planned, in dependency order, and the outcome of each. A
// service marked `skipped` was planned but never reached — that is what a
// dependency failure looks like, and the dashboard renders it as such.
//
// The two sources deploy INDEPENDENTLY and interleaved, which is the point of
// the fixture: opening a deployment shows everything running at that moment, so
// each entry below is a different answer. Opening #1 (the first `platform`
// deploy) predates `storefront` entirely, so `web` is absent — it had not been
// deployed yet. Opening #4 shows `web` as that deploy shipped it alongside the
// FAILED `api` from #3, which is what was actually running underneath it.
//
// Every deployment is TERMINAL on purpose. The list refreshes non-terminal
// deployments from the runtime on read, which a demo project has no runtime for;
// a seeded "building" deployment would poll forever and log an error each time.
const DUMMY_DEPLOYMENTS = [
  { minutesAgo: 60 * 26, sourceId: DUMMY_DEPLOYMENT_SOURCE_IDS.platform, status: 'SUCCEEDED', services: { db: 'deployed', api: 'deployed' } },
  { minutesAgo: 60 * 25, sourceId: DUMMY_DEPLOYMENT_SOURCE_IDS.storefront, status: 'SUCCEEDED', services: { web: 'deployed' } },
  { minutesAgo: 60 * 6, sourceId: DUMMY_DEPLOYMENT_SOURCE_IDS.platform, status: 'FAILED', services: { db: 'deployed', api: 'failed' } },
  { minutesAgo: 42, sourceId: DUMMY_DEPLOYMENT_SOURCE_IDS.storefront, status: 'SUCCEEDED', services: { web: 'deployed' } },
] as const;

/**
 * Seeds the Deployments app: two deployment sources, their service definitions,
 * and a short deploy history that interleaves them.
 *
 * Without this the app renders its empty state, which shows none of the states
 * the page exists to display — a partially failed deploy, a skipped service, a
 * service with a persistent volume, and a connection that crosses from one
 * repository's service into another's.
 */
async function seedDummyDeployments(options: {
  prisma: PrismaClientTransaction,
  tenancyId: string,
}) {
  const { prisma, tenancyId } = options;
  const now = Date.now();
  const firstDeployedAt = new Date(now - DUMMY_DEPLOYMENTS[0].minutesAgo * 60_000);

  // An earlier version of this fixture put all three services under a single
  // `demo-app` source. Drop it before seeding the two that replace it: the
  // upserts below re-point the services and deployments by their deterministic
  // ids, but the volume is keyed by (source, volumeId) and would collide with
  // its own old row, and the emptied source would still show up as a
  // repository the demo project no longer deploys from. Cascades to whatever
  // of it survives.
  await prisma.deploymentSource.deleteMany({ where: { tenancyId, sourceId: 'demo-app' } });

  const sourceRowIdOf = (sourceId: string) => deterministicUuid(`deployment-source:${tenancyId}:${sourceId}`);
  for (const sourceId of Object.values(DUMMY_DEPLOYMENT_SOURCE_IDS)) {
    await prisma.deploymentSource.upsert({
      where: { tenancyId_sourceId: { tenancyId, sourceId } },
      create: { tenancyId, id: sourceRowIdOf(sourceId), sourceId },
      update: {},
    });
  }

  for (const service of DUMMY_DEPLOYMENT_SERVICES) {
    const id = deterministicUuid(`deployment-service:${tenancyId}:${service.serviceId}`);
    const sourceRowId = sourceRowIdOf(service.sourceId);
    const definitionColumns = {
      sourceRowId,
      definitionSyncedAt: firstDeployedAt,
      definitionSyncId: deterministicUuid(`deployment-sync:${tenancyId}:${service.serviceId}`),
      type: service.type,
      isPublic: service.isPublic,
      ports: service.ports as unknown as Prisma.InputJsonValue,
      minInstances: service.minInstances,
      maxInstances: service.maxInstances,
      rootDirectory: service.rootDirectory,
      dockerfilePath: service.dockerfilePath,
      env: service.env as unknown as Prisma.InputJsonValue,
      provisionedAt: firstDeployedAt,
    };
    await prisma.deploymentService.upsert({
      where: { tenancyId_serviceId: { tenancyId, serviceId: service.serviceId } },
      create: { tenancyId, id, serviceId: service.serviceId, ...definitionColumns },
      update: definitionColumns,
    });
    // The disk is owned by the deployment source and merely mounted here, so it
    // is a row of its own rather than a column on the service.
    if (service.volume !== null) {
      const volumeColumns = { serviceId: service.serviceId, path: service.volume.path, sizeGb: service.volume.sizeGb };
      await prisma.deploymentVolume.upsert({
        where: { tenancyId_sourceRowId_volumeId: { tenancyId, sourceRowId, volumeId: service.volume.id } },
        create: { tenancyId, id: deterministicUuid(`deployment-volume:${tenancyId}:${service.volume.id}`), sourceRowId, volumeId: service.volume.id, ...volumeColumns },
        update: volumeColumns,
      });
    }
  }

  for (const [index, deployment] of DUMMY_DEPLOYMENTS.entries()) {
    const deploymentId = deterministicUuid(`deployment:${tenancyId}:${index}`);
    const createdAt = new Date(now - deployment.minutesAgo * 60_000);
    // A deploy ships one SOURCE's services, in dependency order: within
    // `platform`, the database before the API that connects to it.
    const plannedServiceIds = ['db', 'api', 'web'].filter((serviceId) => serviceId in deployment.services);
    const deploymentColumns = {
      sourceRowId: sourceRowIdOf(deployment.sourceId),
      // Monotonic per TENANCY, not per source — the number counts deploys of
      // the whole project, which is why two sources share one sequence.
      number: index + 1,
      triggeredBy: 'cli',
      status: deployment.status,
      error: deployment.status === 'FAILED' ? 'The build of `api` failed, so nothing was rolled out.' : null,
      marshalBuildId: `bld_${createHash('sha256').update(deploymentId).digest('hex').slice(0, 16)}`,
      plannedServiceIds,
      // Every seeded deploy builds from source, so every one has a manifest —
      // an all-prebuilt deploy would have none, which is a state the fixture
      // does not currently cover.
      sourceManifest: dummySourceManifest(deployment.sourceId),
      services: Object.fromEntries(plannedServiceIds.map((serviceId) => {
        // The per-entry `services` records have different keys, so the union's
        // index type is narrower than the ids being looked up here.
        const status = (deployment.services as Record<string, string>)[serviceId];
        const service = DUMMY_DEPLOYMENT_SERVICES.find((candidate) => candidate.serviceId === serviceId) ?? throwErr(`unknown dummy service ${serviceId}`);
        return [serviceId, {
          status,
          url: status === 'deployed' ? service.url : null,
          revision: createHash('sha256').update(`${deploymentId}:${serviceId}`).digest('hex').slice(0, 12),
          error: status === 'failed' ? 'Build failed: `pnpm build` exited with code 1' : null,
        }];
      })) as unknown as Prisma.InputJsonValue,
      createdAt,
      finishedAt: new Date(createdAt.getTime() + 140_000),
    };
    await prisma.deployment.upsert({
      where: { tenancyId_id: { tenancyId, id: deploymentId } },
      create: { tenancyId, id: deploymentId, ...deploymentColumns },
      update: deploymentColumns,
    });
  }

}
