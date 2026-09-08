"use client";

import { PageLayout } from "../page-layout";
import { GrowthAppFrame, GrowthDemoToolbar } from "./components/frame";
import { GrowthStatusGate } from "./components/frame";
import { GrowthLifecycleTimeline, RestartOnboardingButton } from "./components/lifecycle-panels";
import { GrowthWorkspaceOverview } from "./components/workspace-overview";
import { growthWorkspaceIsUnlocked } from "@/lib/growth/growth-status";

export default function PageClient() {
  return (
    <GrowthAppFrame>
      <PageLayout
        title="GTM"
        description="AI-driven analysis, actionable items, and daily briefs for growing your product"
        actions={<div className="flex justify-end"><RestartOnboardingButton /></div>}
      >
        <GrowthDemoToolbar />
        <GrowthStatusGate>
          {(status) => growthWorkspaceIsUnlocked(status)
            ? <GrowthWorkspaceOverview status={status} />
            : <GrowthLifecycleTimeline status={status} />}
        </GrowthStatusGate>
      </PageLayout>
    </GrowthAppFrame>
  );
}
