"use client";

import MetricsPage from "../(overview)/metrics-page";
import { AppEnabledGuard } from "../app-enabled-guard";

export default function AnalyticsOverview() {
  return (
    <AppEnabledGuard appId="analytics">
      <MetricsPage />
    </AppEnabledGuard>
  );
}
