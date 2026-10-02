/**
 * Hexclave project configuration as code (demo app).
 *
 * Source of truth for RBAC permissions/roles, auth methods, OAuth providers,
 * sign-up rules, API keys, and payment plans. The Hexclave CLI (`hexclave dev`)
 * bundles + executes this file and provisions the project to match.
 *
 * It's wrapped in `defineHexclaveConfig(...)`, so the shared-backend config updater takes
 * its AI-agent path (not the deterministic regenerator): dashboard edits are
 * reconciled back here while preserving the comments and layout. `null` on any
 * value means "reset that key to its default".
 */
import { defineHexclaveConfig } from "@hexclave/next";

export const config = defineHexclaveConfig({
  emails: {
    selectedThemeId: "a0172b5d-cff0-463b-83bb-85124697373a",
  },
  auth: {
    password: {
      allowSignIn: true,
    },
    otp: {
      allowSignIn: true,
    },
    oauth: {
      providers: {
        google: {
          type: "google",
          allowSignIn: true,
          allowConnectedAccounts: true,
        },
        github: {
          type: "github",
          allowSignIn: true,
          allowConnectedAccounts: true,
        },
      },
    },
  },
  apps: {
    installed: {
      authentication: {
        enabled: true,
      },
      payments: {
        enabled: true,
      },
      emails: {
        enabled: true,
      },
      analytics: {
        enabled: true,
      },
      warehouse: {
        enabled: true,
      },
      observability: {
        enabled: true,
      },
    },
  },
});
