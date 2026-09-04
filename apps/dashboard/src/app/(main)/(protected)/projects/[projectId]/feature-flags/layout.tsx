"use client";

import type { ReactNode } from "react";
import { AppEnabledGuard } from "../app-enabled-guard";

export default function FeatureFlagsLayout({ children }: { children: ReactNode }) {
  return (
    <AppEnabledGuard appId="feature-flags">
      {children}
    </AppEnabledGuard>
  );
}
