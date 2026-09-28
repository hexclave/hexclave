'use client';

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { AppStoreEntry } from "@/components/app-store-entry";
import { useRouter } from "@/components/router";
import { useUpdateConfig } from "@/components/config-update";
import { ALL_APPS_FRONTEND, getAppPath, getDocumentationHref, type AppId } from "@/lib/apps-frontend";
import { getAppEnableConfigUpdate, isAppEnabled } from "@/lib/apps-utils";
import { getParentAppId } from "@hexclave/shared/dist/apps/apps-config";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { PageLayout } from "../../page-layout";

export default function AppDetailsPageClient({ appId }: { appId: AppId }) {
  const router = useRouter();

  const adminApp = useAdminApp()!;
  const project = adminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();

  const isEnabled = isAppEnabled(config.apps.installed, appId);

  const appFrontend = ALL_APPS_FRONTEND[appId];
  if (!(appFrontend as any)) {
    throw new HexclaveAssertionError(`App frontend not found for appId: ${appId}`, { appId });
  }
  const parentAppId = getParentAppId(appId);
  const parentAppFrontend = parentAppId == null ? null : ALL_APPS_FRONTEND[parentAppId];
  const parentAppEnabled = parentAppId == null ? false : isAppEnabled(config.apps.installed, parentAppId);
  const appPath = getAppPath(project.id, appFrontend);
  const documentationHref = getDocumentationHref(appFrontend);
  const appDestination = documentationHref ?? appPath;
  const subAppDestinationPath = parentAppFrontend == null
    ? null
    : parentAppEnabled
      ? appPath
      : `/projects/${project.id}/apps/${parentAppId}`;

  const handleEnable = async () => {
    await updateConfig({
      adminApp,
      configUpdate: getAppEnableConfigUpdate(appId),
      pushable: true,
    });
    if (documentationHref != null) {
      window.location.href = documentationHref;
    } else {
      router.push(appPath);
    }
  };

  const handleOpen = () => {
    if (documentationHref != null) {
      window.location.href = documentationHref;
    } else {
      router.push(subAppDestinationPath ?? appDestination);
    }
  };

  const handleDisable = async () => {
    await updateConfig({
      adminApp,
      configUpdate: { [`apps.installed.${appId}.enabled`]: false },
      pushable: true,
    });
  };

  return (
    <PageLayout fillWidth>
      <AppStoreEntry
        appId={appId}
        isEnabled={isEnabled}
        onEnable={handleEnable}
        onOpen={handleOpen}
        onDisable={handleDisable}
      />
    </PageLayout>
  );
}
