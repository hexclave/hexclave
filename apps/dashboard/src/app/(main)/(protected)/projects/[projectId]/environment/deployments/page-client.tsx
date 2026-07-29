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

  const secretKeys = [...new Set(
    Object.values(services).flatMap((service) =>
      Object.values(service.env ?? {})
        .filter((envVar) => envVar.type === "secret" && envVar.key != null && envVar.key !== "")
        .map((envVar) => envVar.key as string)
    )
  )].sort();

  return (
    <PageLayout
      title="Deployment secrets"
      description="Secret values are supplied at deploy time, not stored in hexclave.config.ts."
    >
      <div className="space-y-4 max-w-3xl">
        <DesignAlert
          variant="info"
          title="Pass secrets when you deploy"
          description="Declare secret names in App Configuration → Deployments. Provide values via the CLI or CI with --secret name=value."
        />
        <div className="space-y-2">
          <Typography type="p" className="text-sm font-medium text-foreground">
            Declared secret names
          </Typography>
          {secretKeys.length === 0 ? (
            <Typography type="p" variant="secondary" className="text-sm">
              No secret env vars are declared yet. Add them under App Configuration → Deployments.
            </Typography>
          ) : (
            <ul className="list-disc pl-5 space-y-1">
              {secretKeys.map((key) => (
                <li key={key} className="font-mono text-sm">{key}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 pt-2">
            <DesignButton asChild variant="secondary" size="sm">
              <Link href={`/projects/${projectId}/app-configuration/deployments`}>
                Manage declarations
              </Link>
            </DesignButton>
            <DesignButton asChild variant="secondary" size="sm">
              <Link href={`/projects/${projectId}/deployments`}>Open Deployments board</Link>
            </DesignButton>
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
