"use client";

import { useRouter } from "@/components/router";
import { useUpdateConfig } from "@/components/config-update";
import { featureFlagConfigUpdates } from "@/lib/feature-flags/config";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useState } from "react";
import { PageLayout } from "../../../page-layout";
import { useAdminApp } from "../../../use-admin-app";
import { createEmptyFlagDraft, FlagCreateForm } from "../../flag-create-form";
import { useFeatureFlagsSection } from "../../shared";

export default function PageClient() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const router = useRouter();
  const updateConfig = useUpdateConfig();
  const section = useFeatureFlagsSection();
  const [initialFlag] = useState(() => createEmptyFlagDraft(Date.now()));

  return (
    <PageLayout
      title="Create a feature flag"
      description="Name it and create it — it starts off, so nothing changes until you choose a rollout"
    >
      <FlagCreateForm
        initialFlag={initialFlag}
        section={section}
        onCreate={async (flagKey, flag) => {
          const updated = await updateConfig({
            adminApp,
            configUpdate: featureFlagConfigUpdates(flag.internalId, flagKey, flag, section),
            pushable: true,
          });
          if (updated) {
            router.push(urlString`/projects/${project.id}/feature-flags/flags/${flagKey}`);
          }
        }}
      />
    </PageLayout>
  );
}
