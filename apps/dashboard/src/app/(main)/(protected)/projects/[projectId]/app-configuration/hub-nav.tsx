"use client";

import { HubSectionNav, type HubSectionNavItem } from "@/components/hub-section-nav";
import { ALL_APPS_FRONTEND } from "@/lib/apps-frontend";
import { isAppEnabled } from "@/lib/apps-utils";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import type { AppId } from "@hexclave/shared/dist/apps/apps-config";
import { SquaresFourIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { useAdminApp, useProjectId } from "../use-admin-app";

type Section = {
  id: string,
  label: string,
  path: string,
  icon: HubSectionNavItem["icon"],
  /** When set, the tab is hidden unless this app is enabled. */
  requiredAppId?: AppId,
};

const SECTIONS: Section[] = [
  { id: "apps", label: "Apps", path: "apps", icon: SquaresFourIcon },
  { id: "authentication", label: "Authentication", path: "authentication", icon: ALL_APPS_FRONTEND.authentication.icon, requiredAppId: "authentication" },
  { id: "onboarding", label: "Onboarding", path: "onboarding", icon: ALL_APPS_FRONTEND.onboarding.icon, requiredAppId: "onboarding" },
  { id: "teams", label: "Teams", path: "teams", icon: ALL_APPS_FRONTEND.teams.icon, requiredAppId: "teams" },
  { id: "payments", label: "Payments", path: "payments", icon: ALL_APPS_FRONTEND.payments.icon, requiredAppId: "payments" },
  { id: "emails", label: "Emails", path: "emails", icon: ALL_APPS_FRONTEND.emails.icon, requiredAppId: "emails" },
  { id: "api-keys", label: "API Keys", path: "api-keys", icon: ALL_APPS_FRONTEND["api-keys"].icon, requiredAppId: "api-keys" },
  { id: "data-vault", label: "Data Vault", path: "data-vault", icon: ALL_APPS_FRONTEND["data-vault"].icon, requiredAppId: "data-vault" },
  { id: "deployments", label: "Deployments", path: "deployments", icon: ALL_APPS_FRONTEND["deployments-alpha"].icon, requiredAppId: "deployments-alpha" },
];

export function AppConfigurationHubNav() {
  const projectId = useProjectId();
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();

  const items: HubSectionNavItem[] = useMemo(
    () => SECTIONS
      .filter((section) => section.requiredAppId == null || isAppEnabled(config.apps.installed, section.requiredAppId))
      .map((section) => ({
        id: section.id,
        label: section.label,
        href: urlString`/projects/${projectId}/app-configuration/${section.path}`,
        icon: section.icon,
      })),
    [config.apps.installed, projectId],
  );

  // Underline + app icons — same pattern as the user detail horizontal nav.
  return <HubSectionNav items={items} glassmorphic={false} />;
}
