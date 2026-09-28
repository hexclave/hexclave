'use client';

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { AppStoreEntry } from "@/components/app-store-entry";
import { useRouter } from "@/components/router";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui";
import { ALL_APPS_FRONTEND, getAppPath } from "@/lib/apps-frontend";
import { getAppEnableConfigUpdate, isAppEnabled } from "@/lib/apps-utils";
import { useUpdateConfig } from "@/components/config-update";
import { AppId, getParentAppId } from "@hexclave/shared/dist/apps/apps-config";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export default function AppDetailsModalPageClient({ appId }: { appId: AppId }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(true);

  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();

  const isEnabled = isAppEnabled(config.apps.installed, appId);
  const appFrontend = ALL_APPS_FRONTEND[appId];
  const appPath = getAppPath(project.id, appFrontend);
  const parentAppId = getParentAppId(appId);
  const parentAppEnabled = parentAppId == null ? false : isAppEnabled(config.apps.installed, parentAppId);
  const subAppDestinationPath = parentAppId == null
    ? null
    : parentAppEnabled
      ? appPath
      : `/projects/${project.id}/apps/${parentAppId}`;

  // Control modal visibility based on whether we're on a modal route.
  // This ensures the modal only closes when navigation actually succeeds,
  // preventing issues if router.replace is vetoed by a confirmation dialog.
  useEffect(() => {
    const isModalRoute = /^\/projects\/[^/]+\/apps\/[^/]+$/.test(pathname);
    setIsOpen(isModalRoute);
  }, [pathname]);

  const handleEnable = async () => {
    await updateConfig({
      adminApp,
      configUpdate: getAppEnableConfigUpdate(appId),
      pushable: true,
    });
  };

  const handleDisable = async () => {
    await updateConfig({
      adminApp,
      configUpdate: { [`apps.installed.${appId}.enabled`]: false },
      pushable: true,
    });
  };

  const handleOpen = () => {
    // Navigate to the app page. Modal stays open until pathname changes.
    router.replace(subAppDestinationPath ?? appPath);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Navigate back to apps list. Modal stays open until pathname changes.
      router.replace(`/projects/${project.id}/apps`);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange} modal>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden p-0 flex flex-col" noCloseButton>
        <AppStoreEntry
          appId={appId}
          isEnabled={isEnabled}
          onEnable={handleEnable}
          onDisable={handleDisable}
          onOpen={handleOpen}
          titleComponent={DialogTitle}
        />
      </DialogContent>
    </Dialog>
  );
}
