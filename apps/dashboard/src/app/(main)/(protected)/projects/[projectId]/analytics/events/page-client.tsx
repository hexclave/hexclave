"use client";

import { AppEnabledGuard } from "../../app-enabled-guard";
import { PageLayout } from "../../page-layout";
import { AnalyticsEventLimitBanner } from "../shared";
import { TableContent } from "../tables/page-client";

export default function PageClient() {
  return (
    <AppEnabledGuard appId="analytics">
      <PageLayout
        title="Events"
        description="Product events, interactions, and page views. Logs and errors are intentionally excluded."
        fillWidth
        containedHeight
      >
        <AnalyticsEventLimitBanner />
        <TableContent tableId="events" />
      </PageLayout>
    </AppEnabledGuard>
  );
}
