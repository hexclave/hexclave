# Hexclave Changelog

---

## 9/4/26

- Microsoft sign-in no longer asks for admin consent on every login.
- Fixed impersonation links and console snippets landing on the wrong page.

## 8/28/26

- The CLI can now access and analyze session replays with AI.
- Fixed `getUser({ or: "redirect" })` crashing in React server components.

## 8/21/26

![AI answering a natural language query in Cmd+K](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-cmdk-ai-search.gif)

- Cmd+K now answers natural language questions with AI, so you can just ask instead of searching.

## 8/14/26

![Onboarding welcome step](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-onboarding-welcome.webp)

- Revamped onboarding with a welcome step to set up a new project, deploy an existing config, or just look around.
- The CLI docs page is now an install guide plus a full command reference.
- Fixed self-hosted deployments breaking after a container restart because the internal project keys were rotated.
- Unrecoverable dashboard render errors now show a retryable error screen instead of reloading forever.

## 8/7/26

- Apple sign-in now supports key-based credentials (Team ID, Key ID, and private key), with short-lived client secrets generated automatically.
- The Next.js SDK now supports Next.js 16.3.
- Impersonating a user from the dashboard now works with a single click — no more copy-pasting a script into the browser console.
- New `automaticSideEffects` constructor option in the JS SDK that makes app construction fully inert — no prefetching, query-parameter processing, storage access, or other automatic side effects until you explicitly call a method.
- Emails for low-volume tenancies are now sent immediately via a bounded burst allowance, instead of waiting in the send queue.
- Session replays now show a user overview in the header.
- Adding a trusted domain now offers a scope dropdown instead of an "add www." switch, making it clearer which subdomains are covered.
- Fixed a bug where hosted components would sometimes redirect already signed-in users to the "Welcome back" screen instead of the page they requested.
- Fixed a bug where free trials configured in Payments were not correctly synchronized to the payments layer.
- Fixed a bug where signing out would sometimes take a long time.

## 7/31/26

![Sign-in is not available message](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-no-auth-methods.png)

- Sign-in and sign-up pages now show a helpful message instead of an empty form when a project has no authentication methods enabled, pointing developers to the config snippet or dashboard setting that fixes it.
- Users restricted by an administrator now see the public reason they were given on the onboarding screen, instead of a generic message.
- New `hexclave team` CLI commands to list, create, update, invite to, and leave teams, plus team selection when creating a project.
- Signing up with an email that another account already uses for authentication now shows an inline error on the form.
- Auth pages no longer flash a loading placeholder over already-visible content when a session is swapped in.

## 7/24/26

![Analytics table search bar](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-analytics-search.webp)

- Analytics tables now have an inline search bar that filters rows instantly, with AI-powered natural-language filters shown as removable chips.
- Fixed a bug where the devtool indicator would sometimes not show during development.

## 7/17/26

- Added "Continue in your own agent" links to AI chats.
- Improved onboarding walkthrough visuals and setup guidance.

## 7/10/26

- New CLI Auth dashboard app and a browser `<script>` setup path that works without a bundler.
- The project overview globe now centers on the viewer, and the onboarding auth preview is interactive.
- Payments customers now support manual item quantity adjustments directly from the dashboard.
- Fixes for user-page syncing, session replay playback freezes, and runaway infinite scrolling.
- Improved docs discoverability and dashboard resilience when internal billing data is temporarily unavailable.

## 7/3/26

- New navigation funnel graph, recent sign-up rule activity, and project IDs in platform analytics.
- Payments checkout now surfaces errors clearly, with a more polished onboarding flow.
- Expanded email delivery to arbitrary recipients on managed domains, plus filtered user exports and safer user dialogs.
- Leaner dashboard downloads and local-dashboard support for `hexclave exec`, with one unified development environment workflow.
- Large session replays are compressed to avoid dropped recordings, alongside faster analytics and Payments data processing.

## 6/26/26

- Unified payments customers table with "Create checkout" available everywhere and idempotent webhook handling.
- Faster project onboarding with a preview project pool for instant creation and prefetched email themes.
- New Usage settings page with performance improvements and a "View usage" shortcut from limit banners.
- TypeScript 6.0 upgrade, STACK_* → HEXCLAVE_* env-var rename, and devtool indicator auto-visibility.
- Stability fixes for session recording flush limits, duplicate-email sign-up errors, and recurring production errors.

## 6/19/26

- New clickmap heatmaps for route analytics — visualize where users click on any page.
- Custom OIDC provider support (team plan+) with improved OAuth sign-up errors and Apple OAuth fixes.
- Redesigned hosted components, new Emails tab on the User Detail page, and purchase page loading state.
- CLI auth no longer requires a publishable key, plus stability fixes for ENOTEMPTY races and RDE source maps.
- AI-aware config editing and new skill context for Ask Hexclave.

## 6/12/26

![Payments checkout page redesign](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-payments-checkout.webp)
- Redesigned Payments checkout page with navigation and UI polish.
- Dashboard light-mode consistency pass and hosted-components account navigation fix.
- Improved PKCE support and fixed nested cross-domain auth redirect chain.
- New analytics overview filters on the dashboard.
- RDE stability fixes, higher SMTP password limit, and smarter local email-server options.

## 6/5/26

- CLI improvements: local dashboard in remote SSH and Codespaces, auto-update via npx re-exec, and ~154 MB bundle reduction.
- Fixes for sign-out handling, nested cross-domain auth, subscription switching, and email preview theme blanking.
- New Python & REST API setup docs, product prices clarified as decimal strings, and pnpm v11 upgrade.

## 5/29/26
 
- Per-provider OAuth callback URLs with host-derived JWT issuer and redirect URIs.
- New LLM metadata endpoints for documentation discovery.
- Fixes for SSO dialog tab switching, client retry handling, and legacy cookie mixing.

## 5/22/26

- Faster ClickHouse analytics for project metrics and previews.
- Smoother cross-domain auth handoffs and hosted-domain trust.
- Sharper Auth Methods and Users dashboard tables.
![Auth method and user table polish](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-auth-methods.webp)

## 5/15/26

- Redesigned Team Management tables with cleaner action states.
- New project transfer, session replay, and team payments screens.
- Unified AI chat experience on assistant-ui threads.
![Team management table](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-teams.webp)

## 5/8/26

- New TanStack Start SDK integration with refreshed OpenAPI schemas.
- Weekly active users now appear on Project Overview.
- Cleaner Project Permissions with upgraded data grids.
![Project permissions dashboard](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-rbac.webp)

## 5/1/26

- Shareable Session Replay IDs across dashboard, backend, and SDKs.
- Sleeker Data Vault and overview data-grid layouts.
- Emulator updates can now auto-install dependencies.
![Data Vault dashboard](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-data-vault.webp)

## 4/24/26

- Redesigned Email Server settings and managed-domain setup.
- Faster local emulator startup with RAM snapshots.
- Live secret rotation plus a simpler sign-up rules tester.
![Email server settings and logs](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-email-server.webp)

## 4/17/26

- Redesigned Overview and onboarding experience.
- Crisper dashboard sidebar styling and category navigation.
- New Payments product setup flow.
![Payments product setup](https://raw.githubusercontent.com/hexclave/hexclave/dev/apps/dashboard/public/assets/changelog-payments-products.webp)

---

> **Note:** All older changelogs are deprecated and have been removed. The source of truth is this single changelog file.
>
> Going forward, all changes should be documented in this file only.

---
