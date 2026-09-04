import type { JSX } from "react";
import { Link } from "@/components/link";
import { ChartLineIcon, ChatCircleDotsIcon, ClipboardTextIcon, CodeIcon, CreditCardIcon, CursorClickIcon, EnvelopeSimpleIcon, FingerprintSimpleIcon, GraphIcon, KeyIcon, MailboxIcon, MonitorPlayIcon, RocketIcon, ShieldCheckIcon, ShieldWarningIcon, SparkleIcon, TelevisionSimpleIcon, TerminalWindowIcon, TreeStructureIcon, TriangleIcon, UserGearIcon, UsersIcon, VaultIcon, WebhooksLogoIcon } from "@phosphor-icons/react";
import { StackAdminApp } from "@hexclave/next";
import type { AppId } from "@hexclave/shared/dist/apps/apps-config";
import { getRelativePart, isChildUrl } from "@hexclave/shared/dist/utils/urls";
import Image, { StaticImageData } from "next/image";
import ConvexLogo from "../../public/convex-logo.webp";
import NeonLogo from "../../public/neon-logo.webp";
import TanStackStartLogo from "../../public/tanstack-start-logo.webp";
import VercelLogo from "../../public/vercel-logo.svg";

export type { AppId };

// Helper to generate screenshot paths
const getScreenshots = (appName: string, count: number): string[] => {
  return Array.from({ length: count }, (_, i) => `/storeDesc-${appName}-${i + 1}.webp`);
};

export const DUMMY_ORIGIN = "https://example.com";

type BreadcrumbDefinition = {
  item: string,
  href: string,
}[];

type AppNavigationItem = {
  displayName: string,
  href: string,
  external?: boolean,
  matchPath?: (relativePart: string) => boolean,
  getBreadcrumbItems?: (hexclaveAdminApp: StackAdminApp<false>, relativePart: string) => Promise<BreadcrumbDefinition | null | undefined>,
};

export type AppFrontend = {
  icon: React.FunctionComponent<React.SVGProps<SVGSVGElement>>,
  logo?: React.FunctionComponent<{}>,
  href: string,
  documentationHref?: string,
  screenshots: (string | StaticImageData)[],
  storeDescription: JSX.Element,
} & (
  | {
    navigationItems: AppNavigationItem[],
    matchPath?: (relativePart: string) => boolean,
    getBreadcrumbItems?: (hexclaveAdminApp: StackAdminApp<false>, relativePart: string) => Promise<BreadcrumbDefinition | null | undefined>,
  }
  | {
    navigationItems?: undefined,
  }
)

export type NavigableAppFrontend = Extract<AppFrontend, { navigationItems: AppNavigationItem[] }>;

export function hasNavigationItems(appFrontend: AppFrontend): appFrontend is NavigableAppFrontend {
  return "navigationItems" in appFrontend;
}

export function getDocumentationHref(appFrontend: AppFrontend): string | null {
  return "documentationHref" in appFrontend ? appFrontend.documentationHref ?? null : null;
}

export function getAppPath(projectId: string, appFrontend: AppFrontend) {
  const url = new URL(appFrontend.href, `${DUMMY_ORIGIN}/projects/${projectId}/`);
  return getRelativePart(url);
}

function isExternalHref(href: string) {
  return href.startsWith("http://") || href.startsWith("https://");
}

export function getItemPath(projectId: string, appFrontend: NavigableAppFrontend, item: AppNavigationItem) {
  if (item.external || isExternalHref(item.href)) {
    return item.href;
  }

  const url = new URL(item.href, new URL(appFrontend.href, `${DUMMY_ORIGIN}/projects/${projectId}/`) + "/");
  return getRelativePart(url);
}

export function testAppPath(projectId: string, appFrontend: AppFrontend, fullUrl: URL) {
  if ("matchPath" in appFrontend && appFrontend.matchPath) {
    return appFrontend.matchPath(getRelativePart(fullUrl));
  }

  if (hasNavigationItems(appFrontend)) {
    for (const item of appFrontend.navigationItems) {
      if (testItemPath(projectId, appFrontend, item, fullUrl)) return true;
    }
  }
  const url = new URL(appFrontend.href, `${DUMMY_ORIGIN}/projects/${projectId}/`);
  return isChildUrl(url, fullUrl);
}

/**
 * The pathname a plain (non-external, non-`matchPath`) nav item matches `fullUrl` on, or `null` when it does
 * not match. The pathname doubles as the specificity of the match: a longer one is a deeper prefix.
 */
function matchedItemPathname(projectId: string, appFrontend: NavigableAppFrontend, item: AppNavigationItem, fullUrl: URL): string | null {
  if (item.external || isExternalHref(item.href) || item.matchPath) return null;
  const url = new URL(getItemPath(projectId, appFrontend, item), fullUrl);
  if (!isChildUrl(url, fullUrl)) return null;
  // A `.` href resolves with a trailing slash and a named one without, so normalize before the lengths are
  // compared — otherwise the slash alone would make an item look one character more specific than it is.
  return url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
}

export function testItemPath(projectId: string, appFrontend: NavigableAppFrontend, item: AppNavigationItem, fullUrl: URL) {
  if (item.external || isExternalHref(item.href)) {
    return false;
  }

  if (item.matchPath) return item.matchPath(getRelativePart(fullUrl));

  const matched = matchedItemPathname(projectId, appFrontend, item, fullUrl);
  if (matched == null) return false;

  // Nav items can nest, for example an app's settings under its overview root. A prefix match alone lights up
  // both, so the most specific matching item wins — an item that only matches because
  // it is an ancestor of the sibling the user actually navigated to is not the current page. Siblings with a
  // custom `matchPath` are left out of the comparison, since they answer yes/no without a path to rank.
  return !appFrontend.navigationItems.some((sibling) => {
    if (sibling === item) return false;
    const siblingMatch = matchedItemPathname(projectId, appFrontend, sibling, fullUrl);
    return siblingMatch != null && siblingMatch.length > matched.length;
  });
}

export const ALL_APPS_FRONTEND = {
  authentication: {
    icon: FingerprintSimpleIcon,
    href: "auth-methods",
    navigationItems: [
      { displayName: "Auth Methods", href: "." },
      { displayName: "Sign-up Rules", href: "../sign-up-rules" },
    ],
    screenshots: getScreenshots('auth', 6),
    storeDescription: (
      <>
        <p>Authentication centralizes everything you need to operate your Hexclave user directory.</p>
        <p>Tune sign-up behavior and configure auth methods without leaving the dashboard.</p>
        <p>When it is time to harden production, you can pair these controls with project-level guardrails.</p>
      </>
    ),
  },
  "fraud-protection": {
    icon: ShieldCheckIcon,
    href: "sign-up-rules",
    screenshots: [],
    storeDescription: <>
      <p>Fraud Protection helps you protect your project from fraud and abuse.</p>
      <p>Configure sign-up rules and use our built-in fraud protection features to detect bots, free trial abuse, and other fraudulent activity.</p>
    </>,
  },
  onboarding: {
    icon: ClipboardTextIcon,
    href: "onboarding",
    navigationItems: [
      { displayName: "Onboarding", href: "." },
    ],
    screenshots: [],
    storeDescription: (
      <>
        <p>Onboarding lets you define requirements users must complete before gaining full access.</p>
        <p>Configure email verification and other onboarding steps to ensure users are properly validated.</p>
        <p>Users who haven&apos;t completed onboarding are filtered from normal API responses until they finish the required steps.</p>
      </>
    ),
  },
  teams: {
    icon: UsersIcon,
    href: "teams",
    navigationItems: [
      { displayName: "Teams", href: ".", getBreadcrumbItems: getTeamBreadcrumbItems },
      { displayName: "Team Settings", href: "../team-settings" },
    ],
    screenshots: getScreenshots('teams', 4),
    storeDescription: (
      <>
        <p>Teams gives your project first-class multi-tenancy without extra plumbing.</p>
        <p>Create organizations in seconds, keep their metadata tidy with inline edits, and invite teammates or add existing users while memberships stay in sync.</p>
        <p>Whenever you need deeper context, you can jump straight into team settings, billing, or permissions from the same place.</p>
      </>
    ),
  },
  rbac: {
    icon: UserGearIcon,
    href: "./project-permissions",
    navigationItems: [
      { displayName: "Project Permissions", href: "../project-permissions" },
      { displayName: "Team Permissions", href: "../team-permissions" },
    ],
    screenshots: getScreenshots('rbac', 4),
    storeDescription: (
      <>
        <p>RBAC helps you model the authorization surface of your product in a structured, auditable way.</p>
        <p>Define project and team permissions with IDs that map directly into your code and compose them into higher-level roles.</p>
        <p>The Stack SDK exposes those definitions everywhere so each environment enforces the same checks.</p>
      </>
    ),
  },
  "api-keys": {
    icon: KeyIcon,
    href: "api-keys-app",
    navigationItems: [
      { displayName: "API Keys", href: "." },
    ],
    screenshots: getScreenshots('api-keys', 1),
    storeDescription: (
      <>
        <p>API Keys keeps every environment credentialed without sacrificing control.</p>
        <p>Issue publishable client keys or secret server keys with configurable expirations and copy the values before they disappear.</p>
        <p>When a credential is no longer trusted, revoke or rotate it instantly from the dashboard.</p>
      </>
    ),
  },
  payments: {
    icon: CreditCardIcon,
    href: "payments",
    navigationItems: [
      { displayName: "Product Lines", href: "./product-lines" },
      { displayName: "Products & Items", href: "./products" },
      { displayName: "Customers", href: "./customers" },
      { displayName: "Transactions", href: "./transactions" },
      { displayName: "Payouts", href: "./payouts" },
      { displayName: "Settings", href: "./settings" },
    ],
    screenshots: getScreenshots('payments', 7),
    storeDescription: (
      <>
        <p>Payments brings Stack&apos;s product-first pricing model into the dashboard.</p>
        <p>Design product lines with products, prices, and entitlements, segment user or team customers, and generate checkout URLs with the right guardrails.</p>
        <p>Purchase history and transactions stay visible without leaving the console.</p>
      </>
    ),
  },
  emails: {
    icon: EnvelopeSimpleIcon,
    href: "email-sent",
    navigationItems: [
      { displayName: "Sent", href: "." },
      { displayName: "Drafts", href: "../email-drafts", getBreadcrumbItems: getEmailDraftBreadcrumbItems },
      { displayName: "Templates", href: "../email-templates", getBreadcrumbItems: getEmailTemplatesBreadcrumbItems },
      { displayName: "Email Settings", href: "../email-settings" },
    ],
    screenshots: getScreenshots('emails', 8),
    storeDescription: (
      <>
        <p>Emails gives you a full control room for transactional communication.</p>
        <p>Configure shared delivery, Resend, or custom SMTP without touching code, then send test or operational messages whenever you need.</p>
        <p>Draft, templatize, and theme email content so every notification stays on brand while delivery logs remain close by.</p>
      </>
    ),
  },
  support: {
    icon: ChatCircleDotsIcon,
    href: "conversations",
    navigationItems: [
      { displayName: "Conversations", href: "." },
    ],
    screenshots: getScreenshots('support', 0),
    storeDescription: (
      <>
        <p>The Support app&apos;s Conversations view turns your user detail view into an operational workspace instead of a dead end.</p>
        <p>Open threads from the unified inbox, add internal notes, and reply to users from the same place while keeping the history tied to the underlying Stack user record.</p>
        <p>It is designed for the people who need to troubleshoot identity, onboarding, and account issues without bouncing between five dashboard pages.</p>
      </>
    ),
  },
  "email-api": {
    icon: MailboxIcon,
    href: "email-api",
    navigationItems: [
      { displayName: "Email API", href: "." },
    ],
    screenshots: [],
    storeDescription: (
      <>
        <p>The Email API unlocks programmatic messaging flows directly from the Stack SDK.</p>
        <p>Trigger transactional emails from your server code, reuse the templates and themes you author in the dashboard, and capture delivery results in the same log.</p>
        <p>It is the fastest path from an automation idea to a production-ready notification.</p>
      </>
    ),
  },
  "data-vault": {
    icon: VaultIcon,
    href: "data-vault",
    navigationItems: [
      { displayName: "Data Vault", href: "." },
    ],
    screenshots: getScreenshots('data-vault', 4),
    storeDescription: (
      <>
        <p>Data Vault is an encrypted key-value store for the secrets your app should never expose.</p>
        <p>Create isolated stores for API tokens, recovery codes, or other sensitive values, all protected by your own vault secret.</p>
        <p>Stack only keeps hashed keys and ciphertext, and the SDK ships with examples for reading and writing data safely.</p>
      </>
    ),
  },
  webhooks: {
    icon: WebhooksLogoIcon,
    href: "webhooks",
    navigationItems: [
      { displayName: "Webhooks", href: "." },
    ],
    screenshots: getScreenshots('webhooks', 2),
    storeDescription: (
      <>
        <p>Webhooks keep user and team events in sync between Stack and your own servers.</p>
        <p>Create and manage Svix-powered endpoints without leaving the dashboard, edit descriptions as your integrations evolve, and retire endpoints safely when they are no longer needed.</p>
        <p>Every notification keeps billing, analytics, and downstream services in sync.</p>
      </>
    ),
  },
  "tv-mode": {
    icon: TelevisionSimpleIcon,
    href: "tv-mode",
    navigationItems: [
      { displayName: "TV mode", href: "." },
    ],
    screenshots: [],
    storeDescription: <></>,
  },
  "launch-checklist": {
    icon: RocketIcon,
    href: "launch-checklist",
    navigationItems: [
      { displayName: "Launch Checklist", href: "." },
    ],
    screenshots: [],
    storeDescription: (
      <>
        <p>The Launch Checklist keeps your go-live to-dos inside the product.</p>
        <p>Track implementation progress across the tasks that matter, follow guided instructions for each requirement, and keep teammates aligned as you move from sandbox to production.</p>
        <p>It becomes the shared source of truth when launch day approaches.</p>
      </>
    ),
  },
  catalyst: {
    icon: SparkleIcon,
    href: "catalyst",
    navigationItems: [
      { displayName: "Catalyst", href: "." },
    ],
    screenshots: [],
    storeDescription: <></>,
  },
  neon: {
    icon: createSvgIcon(() => <>
      <path
        d="M 21.9999 3.6667 L 21.9999 16.1666 A 1.6667 1.6667 90 0 1 20.3333 17.8333 A 2.5 2.5 90 0 1 18.6666 16.9999 L 12.8333 10.3333 L 12.8333 20.3333 A 1.6667 1.6667 90 0 1 11.1666 21.9999 L 3.6667 21.9999 A 1.6667 1.6667 90 0 1 2 20.3333 L 2 3.6667 A 1.6667 1.6667 90 0 1 3.6667 2 L 20.3333 2 A 1.6667 1.6667 90 0 1 21.9999 3.6667 Z"
      />
    </>),
    logo: () => <Image src={NeonLogo} alt="Neon logo" />,
    href: "neon",
    navigationItems: [
      { displayName: "Neon Integration", href: "." },
    ],
    screenshots: [],
    storeDescription: <></>,
  },
  convex: {
    icon: createSvgIcon(() => <>
      <path d="M14.099 16.959c2.369 -0.263 4.603 -1.526 5.833 -3.633 -0.583 5.212 -6.282 8.507 -10.934 6.484 -0.429 -0.186 -0.798 -0.495 -1.051 -0.893 -1.046 -1.642 -1.389 -3.731 -0.895 -5.626 1.411 2.435 4.28 3.928 7.047 3.668" />
      <path d="M6.965 11.762c-0.961 2.219 -1.002 4.818 0.175 6.957 -4.144 -3.118 -4.099 -9.789 -0.051 -12.876 0.374 -0.285 0.819 -0.455 1.286 -0.48 1.919 -0.101 3.869 0.64 5.236 2.023 -2.778 0.028 -5.484 1.807 -6.647 4.377" />
      <path d="M14.953 8.068C13.551 6.113 11.357 4.783 8.953 4.742c4.647 -2.109 10.363 1.31 10.985 6.366 0.058 0.469 -0.018 0.948 -0.226 1.371 -0.868 1.763 -2.478 3.131 -4.359 3.637 1.378 -2.556 1.208 -5.68 -0.4 -8.048" />
    </>),
    logo: () => <Image src={ConvexLogo} alt="Convex logo" />,
    href: "convex",
    navigationItems: [
      { displayName: "Convex Integration", href: "." },
    ],
    screenshots: [],
    storeDescription: <></>,
  },
  vercel: {
    icon: TriangleIcon,
    logo: () => <div className="w-full h-full flex items-center justify-center">
      <Image src={VercelLogo} alt="Vercel logo" className="bg-white invert w-full h-full object-contain p-2" />
    </div>,
    href: "vercel",
    navigationItems: [
      { displayName: "Setup", href: "." },
    ],
    screenshots: getScreenshots('vercel', 2),
    storeDescription: <>Deploy your Hexclave project to <Link href="https://vercel.com" target="_blank">Vercel</Link> with the Vercel x Hexclave integration.</>,
  },
  "tanstack-start": {
    icon: CodeIcon,
    logo: () => <Image src={TanStackStartLogo} alt="TanStack Start logo" />,
    href: "tanstack-start",
    documentationHref: "https://docs.hexclave.com/guides/integrations/tanstack-start/overview",
    navigationItems: [
      {
        displayName: "Docs",
        href: "https://docs.hexclave.com/guides/integrations/tanstack-start/overview",
        external: true,
      },
    ],
    screenshots: [],
    storeDescription: (
      <>
        <p>TanStack Start integration adds Hexclave to full-stack React apps built with TanStack Router and Vite.</p>
        <p>Install the alpha `@hexclave/tanstack-start` package, wire the Stack provider into your root route, and mount the built-in auth handler pages under your app origin.</p>
        <p>The dashboard sidebar entry opens the integration docs so your team can jump back to setup instructions from the project.</p>
      </>
    ),
  },
  analytics: {
    icon: ChartLineIcon,
    href: "analytics",
    navigationItems: [
      { displayName: "Tables", href: "./tables" },
      { displayName: "Replays", href: "../session-replays" },
      { displayName: "Clickmaps", href: "./clickmaps" },
      { displayName: "Queries", href: "./queries" },
    ],
    screenshots: [],
    storeDescription: (
      <>
        <p>Analytics provides direct access to your project&apos;s analytics data stored in ClickHouse.</p>
        <p>Browse tables, explore event data, and gain insights into user behavior and system performance.</p>
      </>
    ),
  },
  clickmaps: {
    icon: CursorClickIcon,
    href: "analytics/clickmaps",
    screenshots: [],
    storeDescription: (
      <>
        <p>Clickmaps show where users interact with each page so you can spot attention patterns, missed affordances, and dead clicks.</p>
        <p>They run on the same analytics event pipeline and are launched from trusted domains with a short-lived overlay token.</p>
      </>
    ),
  },
  "session-replays": {
    icon: MonitorPlayIcon,
    href: "session-replays",
    screenshots: [],
    storeDescription: (
      <>
        <p>Session Replays let you watch real user sessions to understand how people use your app.</p>
        <p>Built on the same analytics pipeline, replays are scoped per user and surfaced inline on the user page.</p>
      </>
    ),
  },
  "cli-auth": {
    icon: TerminalWindowIcon,
    href: "cli-auth",
    documentationHref: "https://docs.hexclave.com/guides/others/cli-authentication",
    navigationItems: [
      { displayName: "CLI Auth", href: "." },
    ],
    screenshots: [],
    storeDescription: (
      <>
        <p>CLI Auth shows real-time insight into how CLI authentication is used in your project.</p>
        <p>Monitor recent login attempts, see which users have active CLI refresh tokens, and track session health at a glance.</p>
      </>
    ),
  },
  compliance: {
    icon: ShieldWarningIcon,
    href: "compliance",
    navigationItems: [
      { displayName: "Compliance Center", href: "." },
    ],
    screenshots: [],
    storeDescription: (
      <>
        <p>Compliance Center surfaces authentication, access-denial, and restricted-user activity.</p>
        <p>Review the admin audit trail for impersonation and project settings changes, then export Compliance Center data for further analysis.</p>
      </>
    ),
  },
  "deploy": {
    icon: GraphIcon,
    // The route stays /projects/<id>/deployments — only the app id carries the
    // `-alpha` suffix, so existing links and bookmarks keep working.
    href: "deployments",
    navigationItems: [
      { displayName: "Deploy", href: "." },
    ],
    screenshots: [],
    storeDescription: (
      <>
        <p>Deploy gives your project a visual canvas for the services that run your app.</p>
        <p>Drag static sites, containers, and your Hexclave backend around a grid, then wire outputs from one service straight into another service&apos;s environment variables.</p>
        <p>Every project keeps exactly one Hexclave service at its center, so credentials like the secret server key are one reference away.</p>
      </>
    ),
  },
  "workflows-alpha": {
    icon: TreeStructureIcon,
    // Like Deploy, only the app id carries the `-alpha` suffix — the route
    // stays /projects/<id>/workflows, and the detail route /workflows/<id>
    // matches as a child of it.
    href: "workflows",
    navigationItems: [
      { displayName: "Workflows", href: "." },
    ],
    screenshots: [],
    storeDescription: (
      <>
        <p>Workflows lets you write durable background automations in TypeScript and run them on Hexclave&apos;s infrastructure.</p>
        <p>Trigger them from platform events like <code>user.created</code>, from your own custom events, or on a cron schedule, and let the engine handle retries, sleeps, and versioning for you.</p>
        <p>Every run is inspectable in the dashboard down to the individual step, so you can see exactly where an automation is and replay it when something goes wrong.</p>
      </>
    ),
  },
} as const satisfies Record<AppId, AppFrontend>;

function createSvgIcon(ChildrenComponent: () => React.ReactNode): (props: any) => React.ReactNode {
  const Result = (props: any) => (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      {...props}
    >
      <ChildrenComponent />
    </svg>
  );
  Result.displayName = `SvgIcon(${ChildrenComponent.name})`;
  return Result;
}

async function getEmailTemplatesBreadcrumbItems(hexclaveAdminApp: StackAdminApp<false>, relativePart: string) {
  const normalized = relativePart || "/";
  const baseCrumbs = [{ item: "Templates", href: "." }];
  if (normalized === "/" || normalized === "") {
    return baseCrumbs;
  }

  const match = normalized.match(/^\/([^/]+)(?:\/.*)?$/);
  if (!match) {
    return baseCrumbs;
  }

  const templateId = decodeURIComponent(match[1]);
  const templates = await hexclaveAdminApp.listEmailTemplates();
  const template = templates.find(({ id }) => id === templateId);
  if (!template) {
    return baseCrumbs;
  }

  return [
    ...baseCrumbs,
    {
      item: template.displayName,
      href: `./${encodeURIComponent(template.id)}`,
    },
  ];
}

async function getTeamBreadcrumbItems(hexclaveAdminApp: StackAdminApp<false>, relativePart: string) {
  const baseCrumbs = [{ item: "Teams", href: "." }];
  const match = relativePart.match(/^\/([^/]+)(?:\/.*)?$/);
  if (!match) {
    return baseCrumbs;
  }

  const teamId = decodeURIComponent(match[1]);
  const team = await hexclaveAdminApp.getTeam(teamId);
  if (!team) {
    return baseCrumbs;
  }

  return [
    ...baseCrumbs,
    {
      item: team.displayName,
      href: `./${encodeURIComponent(team.id)}`,
    },
  ];
}


async function getEmailDraftBreadcrumbItems(hexclaveAdminApp: StackAdminApp<false>, relativePart: string) {
  const baseCrumbs = [{ item: "Drafts", href: "." }];
  const match = relativePart.match(/^\/([^/]+)(?:\/.*)?$/);
  if (!match) {
    return baseCrumbs;
  }

  const draftId = decodeURIComponent(match[1]);
  const drafts = await hexclaveAdminApp.listEmailDrafts();
  const draft = drafts.find(({ id }) => id === draftId);
  if (!draft) {
    return baseCrumbs;
  }

  return [
    ...baseCrumbs,
    {
      item: draft.displayName,
      href: `./${encodeURIComponent(draft.id)}`,
    },
  ];
}
