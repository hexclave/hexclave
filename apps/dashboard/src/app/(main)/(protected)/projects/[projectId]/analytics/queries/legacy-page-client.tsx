'use client';

import { useRouter } from "@/components/router";
import { isAppEnabled } from "@/lib/apps-utils";
import { useEffect } from "react";
import { useAdminApp } from "../../use-admin-app";
import PageClient from "./page-client";

export default function LegacyPageClient() {
  const router = useRouter();
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const config = project.useConfig();
  const redirectToWarehouse = !isAppEnabled(config.apps.installed, "analytics")
    && isAppEnabled(config.apps.installed, "warehouse");

  useEffect(() => {
    if (redirectToWarehouse) {
      router.replace(`/projects/${project.id}/warehouse/queries`);
    }
  }, [redirectToWarehouse, project.id, router]);

  if (redirectToWarehouse) return null;
  return <PageClient appId="analytics" />;
}
