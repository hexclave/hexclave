type AppTag = {
  displayName: string,
};

export const ALL_APP_TAGS = {
  "expert": {
    displayName: "Expert",
  },
  "integration": {
    displayName: "Integrations",
  },
  "auth": {
    displayName: "Authentication",
  },
  "developers": {
    displayName: "For Developers",
  },
  "security": {
    displayName: "Security",
  },
  "operations": {
    displayName: "For Operations",
  },
  "gtm": {
    displayName: "Go-to-market",
  },
  "comms": {
    displayName: "Communications",
  },
  "automation": {
    displayName: "Automation",
  },
  "storage": {
    displayName: "Storage & Databases",
  },
  "various": {
    displayName: "Various",
  },
} as const satisfies Record<string, AppTag>;

type ParentAppId = "authentication" | "analytics";

type App = {
  displayName: string,
  subtitle: string,
  tags: (keyof typeof ALL_APP_TAGS)[],
  stage: "alpha" | "beta" | "stable",
  softRequirements: string[],
  parentAppId?: ParentAppId,
};

export type AppId = keyof typeof ALL_APPS;

export const ALL_APPS = {
  "authentication": {
    displayName: "Authentication",
    subtitle: "User sign-in and account management",
    tags: ["auth", "security"],
    stage: "stable",
    softRequirements: ["emails"],
  },
  "fraud-protection": {
    displayName: "Fraud Protection",
    subtitle: "Protect your project from fraud and abuse",
    tags: ["auth", "security"],
    stage: "stable",
    softRequirements: ["authentication"],
    parentAppId: "authentication",
  },
  "onboarding": {
    displayName: "Onboarding",
    subtitle: "Configure user onboarding requirements",
    tags: ["auth"],
    stage: "alpha",
    softRequirements: ["authentication"],
  },
  "teams": {
    displayName: "Teams",
    subtitle: "Team collaboration and management",
    tags: ["auth", "security"],
    stage: "stable",
    softRequirements: ["authentication"],
  },
  "rbac": {
    displayName: "RBAC",
    subtitle: "Role-based access control and permissions",
    tags: ["auth", "security"],
    stage: "stable",
    softRequirements: ["authentication"],
  },
  "api-keys": {
    displayName: "API Keys",
    subtitle: "API key generation and management",
    tags: ["auth", "security", "developers"],
    stage: "stable",
    softRequirements: ["authentication"],
  },
  "payments": {
    displayName: "Payments",
    subtitle: "Payment processing and subscription management",
    tags: ["operations", "gtm"],
    stage: "stable",
    softRequirements: ["authentication"],
  },
  "emails": {
    displayName: "Emails",
    subtitle: "Email template configuration and management",
    tags: ["comms"],
    stage: "stable",
    softRequirements: [],
  },
  "support": {
    displayName: "Support",
    subtitle: "Customer conversations, team replies, and internal notes",
    tags: ["comms", "operations"],
    stage: "alpha",
    softRequirements: ["authentication", "emails"],
  },
  "email-api": {
    displayName: "Email API",
    subtitle: "Programmatic email sending and delivery",
    tags: ["comms", "developers", "expert"],
    stage: "alpha",
    softRequirements: ["emails"],
  },
  "data-vault": {
    displayName: "Data Vault",
    subtitle: "Secure storage for sensitive user data",
    tags: ["security", "storage"],
    stage: "beta",
    softRequirements: ["authentication"],
  },
  "webhooks": {
    displayName: "Webhooks",
    subtitle: "Real-time event notifications and integrations",
    tags: ["developers"],
    stage: "stable",
    softRequirements: [],
  },
  "tv-mode": {
    displayName: "TV mode",
    subtitle: "Dashboard display for large screens",
    tags: ["various"],
    stage: "alpha",
    softRequirements: [],
  },
  "launch-checklist": {
    displayName: "Launch Checklist",
    subtitle: "Pre-launch verification and readiness checks",
    tags: ["various"],
    stage: "stable",
    softRequirements: [],
  },
  "catalyst": {
    displayName: "Catalyst",
    subtitle: "Project scaffolding and rapid development",
    tags: ["various"],
    stage: "alpha",
    softRequirements: [],
  },
  "neon": {
    displayName: "Neon Integration",
    subtitle: "Serverless Postgres database integration",
    tags: ["integration", "storage"],
    stage: "alpha",
    softRequirements: [],
  },
  "convex": {
    displayName: "Convex Integration",
    subtitle: "Real-time backend platform integration",
    tags: ["integration", "storage"],
    stage: "alpha",
    softRequirements: [],
  },
  "vercel": {
    displayName: "Vercel Integration",
    subtitle: "Deploy your Hexclave project to Vercel",
    tags: ["integration", "developers"],
    stage: "stable",
    softRequirements: [],
  },
  "tanstack-start": {
    displayName: "TanStack Start",
    subtitle: "Use Hexclave in TanStack Start apps",
    tags: ["integration", "developers"],
    stage: "alpha",
    softRequirements: [],
  },
  "analytics": {
    displayName: "Analytics",
    subtitle: "View and explore analytics data",
    tags: ["developers", "operations"],
    stage: "stable",
    softRequirements: [],
  },
  "clickmaps": {
    displayName: "Clickmaps",
    subtitle: "Visualize where users click across your app",
    tags: ["developers", "operations"],
    stage: "stable",
    softRequirements: ["analytics"],
    parentAppId: "analytics",
  },
  "session-replays": {
    displayName: "Session Replays",
    subtitle: "Watch real user sessions to understand how people use your app",
    tags: ["developers", "operations"],
    stage: "stable",
    softRequirements: ["analytics"],
    parentAppId: "analytics",
  },
  "cli-auth": {
    displayName: "CLI Auth",
    subtitle: "Monitor CLI authentication sessions and active tokens",
    tags: ["auth", "developers"],
    stage: "alpha",
    softRequirements: ["authentication"],
  },
  "compliance": {
    displayName: "Compliance Center",
    subtitle: "Review access, denials, admin actions, and compliance posture",
    tags: ["auth", "security", "operations"],
    stage: "alpha",
    softRequirements: ["authentication", "analytics"],
  },
  "deploy": {
    displayName: "Deploy",
    subtitle: "Configure and connect the services that run your app",
    tags: ["developers", "operations"],
    stage: "alpha",
    softRequirements: [],
  },
  // The plain `workflows`
  // id is additionally unusable: a 2025-10-29 config migration strips
  // `apps.installed.workflows` from every override (see migrateConfigOverride),
  // so an app under that id could never stay enabled.
  "workflows-alpha": {
    displayName: "Workflows",
    subtitle: "Durable, code-defined automations that react to events in your project",
    tags: ["automation", "developers"],
    stage: "alpha",
    softRequirements: [],
  },
} as const satisfies Record<string, App>;

export function getParentAppId(appId: AppId): AppId | null {
  const app = ALL_APPS[appId];
  return "parentAppId" in app ? app.parentAppId : null;
}

/**
 * Expands strong product recommendations without making them hard config
 * dependencies. Callers may still disable a recommended app independently.
 */
export function expandAppSoftRequirements(appIds: Iterable<AppId>): Set<AppId> {
  const expanded = new Set<AppId>();
  const pending = [...appIds];

  while (pending.length > 0) {
    const appId = pending.pop();
    if (appId === undefined || expanded.has(appId)) {
      continue;
    }

    expanded.add(appId);
    for (const requirementId of ALL_APPS[appId].softRequirements) {
      pending.push(requirementId);
    }
  }

  return expanded;
}
