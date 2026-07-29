"use client";

import { HubSectionNav, type HubSectionNavItem } from "@/components/hub-section-nav";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useProjectId } from "../use-admin-app";

const SECTIONS = [
  { id: "domains", label: "Domains", path: "domains" },
  { id: "deployments", label: "Deployments", path: "deployments" },
] as const;

export function EnvironmentHubNav() {
  const projectId = useProjectId();
  const items: HubSectionNavItem[] = SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    href: urlString`/projects/${projectId}/project-settings/${section.path}`,
  }));

  return <HubSectionNav items={items} />;
}
