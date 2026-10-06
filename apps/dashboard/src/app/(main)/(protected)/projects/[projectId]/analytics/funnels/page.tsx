"use client";

import { useRouter } from "@/components/router";
import { useEffect } from "react";
import { useAdminApp } from "../../use-admin-app";

export default function Page() {
  const adminApp = useAdminApp();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/projects/${encodeURIComponent(adminApp.projectId)}/analytics/paths?mode=compare`);
  }, [adminApp.projectId, router]);

  return null;
}
