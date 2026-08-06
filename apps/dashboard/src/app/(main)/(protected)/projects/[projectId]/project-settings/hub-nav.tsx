"use client";

import { HubSectionNav, type HubSectionNavItem } from "@/components/hub-section-nav";
import { getPublicEnvVar } from "@/lib/env";
import { isAppEnabled } from "@/lib/apps-utils";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useMemo } from "react";
import { useAdminApp, useProjectId } from "../use-admin-app";
import { isProjectSettingsEnvSectionId } from "./env-sections";

export function ProjectSettingsHubNav() {
  const projectId = useProjectId();
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const deploymentsEnabled = isAppEnabled(config.apps.installed, "deployments-alpha");
  const paymentsEnabled = isAppEnabled(config.apps.installed, "payments");
  const emailsEnabled = isAppEnabled(config.apps.installed, "emails");
  // Development environments sync branch config from hexclave.config.ts; env-level
  // Domains / OAuth / Deployments belong on the production dashboard instead.
  const isDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";

  const items: HubSectionNavItem[] = useMemo(() => {
    const sections = [
      { id: "general", label: "General", path: "" },
      { id: "domains", label: "Domains", path: "domains" },
      { id: "oauth", label: "OAuth", path: "oauth" },
      ...(paymentsEnabled
        ? [{ id: "payments", label: "Payments", path: "payments" }]
        : []),
      ...(emailsEnabled
        ? [{ id: "email", label: "Email", path: "email" }]
        : []),
      ...(deploymentsEnabled
        ? [{ id: "deployments", label: "Deployments", path: "deployments" }]
        : []),
      { id: "usage", label: "Billing & Usage", path: "usage" },
      { id: "keys", label: "Project Keys", path: "keys" },
    ] as const;

    return sections
      .filter((section) => !(isDevelopmentEnvironment && isProjectSettingsEnvSectionId(section.id)))
      .map((section) => ({
        id: section.id,
        label: section.label,
        href: section.path === ""
          ? urlString`/projects/${projectId}/project-settings`
          : urlString`/projects/${projectId}/project-settings/${section.path}`,
      }));
  }, [deploymentsEnabled, emailsEnabled, isDevelopmentEnvironment, paymentsEnabled, projectId]);

  return <HubSectionNav items={items} />;
}
