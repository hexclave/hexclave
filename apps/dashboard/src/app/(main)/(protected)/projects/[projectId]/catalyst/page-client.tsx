"use client";

import { AppIcon } from "@/components/app-square";
import { DesignAlert, DesignCard } from "@/components/design-components";
import { Link } from "@/components/link";
import { ALL_APPS_FRONTEND, getAppPath } from "@/lib/apps-frontend";
import { getEnabledNavigableAppIds } from "@/lib/apps-utils";
import { ALL_APPS } from "@hexclave/shared/dist/apps/apps-config";
import { ClipboardTextIcon, CubeIcon, RocketIcon } from "@phosphor-icons/react";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";

export default function PageClient() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const projectId = adminApp.projectId;
  const enabledAppIds = getEnabledNavigableAppIds(config.apps.installed);

  return (
    <AppEnabledGuard appId="catalyst">
      <PageLayout
        title="Catalyst"
        description="The project kit: what is enabled, and the next surfaces to open. Catalyst does not generate an app from a template yet."
        scrollMain
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <DesignCard title="This project" subtitle={project.displayName} icon={CubeIcon}>
            <dl className="grid gap-2 text-sm">
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Project ID</dt>
                <dd className="font-mono text-xs">{project.id}</dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Enabled apps</dt>
                <dd>{enabledAppIds.length}</dd>
              </div>
            </dl>
          </DesignCard>
          <DesignCard title="Next" subtitle="Existing setup surfaces" icon={RocketIcon}>
            <ul className="space-y-2 text-sm">
              <li>
                <Link className="hover:underline" href={`/projects/${encodeURIComponent(projectId)}/launch-checklist`}>
                  Launch Checklist
                </Link>
                <span className="text-muted-foreground"> — go-live tasks</span>
              </li>
              <li>
                <Link className="hover:underline" href={`/projects/${encodeURIComponent(projectId)}/apps`}>
                  Apps
                </Link>
                <span className="text-muted-foreground"> — enable the rest of the kit</span>
              </li>
              <li>
                <Link className="hover:underline" href={`/projects/${encodeURIComponent(projectId)}/project-settings`}>
                  Project settings
                </Link>
                <span className="text-muted-foreground"> — keys, domains, and display name</span>
              </li>
            </ul>
          </DesignCard>
        </div>

        <DesignCard title="Enabled kit" subtitle="Apps with dashboard navigation" icon={ClipboardTextIcon}>
          {enabledAppIds.length === 0 ? (
            <DesignAlert variant="info" title="No navigable apps enabled" description="Open Apps and enable Analytics, Observability, or Auth to start scaffolding the project." />
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {enabledAppIds.map((appId) => {
                const href = getAppPath(projectId, ALL_APPS_FRONTEND[appId]);
                return (
                  <li key={appId}>
                    <Link
                      href={href}
                      className="flex items-center gap-3 rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-foreground/[0.06] transition-colors hover:bg-foreground/[0.05] hover:transition-none"
                    >
                      <AppIcon appId={appId} enabled className="h-8 w-8" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{ALL_APPS[appId].displayName}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">{ALL_APPS[appId].subtitle}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </DesignCard>
      </PageLayout>
    </AppEnabledGuard>
  );
}
