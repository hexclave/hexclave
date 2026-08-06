"use client";

import { DesignCard } from "@/components/design-components";
import { useRouter } from "@/components/router";
import { ArrowRightIcon, EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { PageLayout } from "../../page-layout";
import { ThemeSettings } from "../../email-settings/theme-settings";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { useProjectId } from "../../use-admin-app";

export default function PageClient() {
  const projectId = useProjectId();
  const router = useRouter();
  const templatesHref = urlString`/projects/${projectId}/app-configuration/emails/templates`;

  return (
    <AppEnabledGuard appId="emails">
      <PageLayout
        title="Emails"
        description="Branch email themes and template catalog from hexclave.config.ts."
      >
        <div className="space-y-5 max-w-3xl pb-5">
          <ThemeSettings />

          <DesignCard
            title="Templates"
            subtitle="Customize the transactional emails sent to your users."
            icon={EnvelopeSimpleIcon}
            className="cursor-pointer"
            onClick={() => router.push(templatesHref)}
            actions={<ArrowRightIcon className="h-4 w-4 text-muted-foreground" />}
          />
        </div>
      </PageLayout>
    </AppEnabledGuard>
  );
}
