"use client";

import { HubSectionNav, type HubSectionNavItem } from "@/components/hub-section-nav";
import { isAppEnabled } from "@/lib/apps-utils";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useMemo } from "react";
import { useAdminApp, useProjectId } from "../use-admin-app";

export function ProjectSettingsHubNav() {
  const projectId = useProjectId();
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const deploymentsEnabled = isAppEnabled(config.apps.installed, "deployments-alpha");

  const items: HubSectionNavItem[] = useMemo(() => {
    const sections = [
      { id: "general", label: "General", path: "" },
      { id: "domains", label: "Domains", path: "domains" },
      { id: "oauth", label: "OAuth", path: "oauth" },
      ...(deploymentsEnabled
        ? [{ id: "deployments", label: "Deployments", path: "deployments" }]
        : []),
      { id: "usage", label: "Billing & Usage", path: "usage" },
      { id: "keys", label: "Project Keys", path: "keys" },
    ] as const;

    return sections.map((section) => ({
      id: section.id,
      label: section.label,
      href: section.path === ""
        ? urlString`/projects/${projectId}/project-settings`
        : urlString`/projects/${projectId}/project-settings/${section.path}`,
    }));
  }, [deploymentsEnabled, projectId]);

  return <HubSectionNav items={items} />;
}
