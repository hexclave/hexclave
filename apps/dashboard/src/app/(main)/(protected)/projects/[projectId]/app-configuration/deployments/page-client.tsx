"use client";

import { DesignAlert, DesignButton } from "@/components/design-components";
import { Link } from "@/components/link";
import { Typography } from "@/components/ui";
import { PageLayout } from "../../page-layout";
import { useAdminApp, useProjectId } from "../../use-admin-app";

export default function PageClient() {
  const projectId = useProjectId();
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const services = config["deployments-alpha"]?.services ?? {};
  const serviceCount = Object.keys(services).length;

  return (
    <PageLayout
      title="Deployments"
      description="Service definitions and env var names from hexclave.config.ts."
    >
      <div className="space-y-4 max-w-3xl">
        <DesignAlert
          variant="info"
          title="Service definitions are versioned config"
          description={
            serviceCount === 0
              ? "No deployment services are defined yet. Add them in the Deployments board or your config file."
              : `${serviceCount} service(s) defined. Edit service definitions on the Deployments board when the config source allows dashboard edits.`
          }
        />
        <div className="space-y-2">
          <Typography type="p" variant="secondary" className="text-sm">
            Manage service definitions, builds, and runs on the Deployments board. Secret values live under Project Settings → Deployments.
          </Typography>
          <div className="flex flex-wrap gap-2">
            <DesignButton asChild variant="secondary" size="sm">
              <Link href={`/projects/${projectId}/deployments`}>Open Deployments</Link>
            </DesignButton>
            <DesignButton asChild variant="secondary" size="sm">
              <Link href={`/projects/${projectId}/project-settings/deployments`}>Deployment secrets</Link>
            </DesignButton>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
