"use client";

import { AppEnabledGuard } from "../../app-enabled-guard";
import { PageLayout } from "../../page-layout";
import { DomainSettings } from "../../email-settings/domain-settings";

export default function PageClient() {
  return (
    <AppEnabledGuard appId="emails">
      <PageLayout
        title="Email"
        description="Configure email delivery for this environment."
      >
        <DomainSettings />
      </PageLayout>
    </AppEnabledGuard>
  );
}
