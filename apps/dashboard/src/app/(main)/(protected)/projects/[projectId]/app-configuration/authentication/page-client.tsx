"use client";

import { AppEnabledGuard } from "../../app-enabled-guard";
import AuthMethodsPageClient from "../../auth-methods/page-client";

export default function PageClient() {
  return (
    <AppEnabledGuard appId="authentication">
      <AuthMethodsPageClient variant="branch" embedded />
    </AppEnabledGuard>
  );
}
