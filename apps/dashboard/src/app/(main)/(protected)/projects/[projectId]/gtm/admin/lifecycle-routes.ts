import type { GrowthTimelineStepId } from "@/lib/growth/growth-timeline";

export const GROWTH_ADMIN_LIFECYCLE_STEPS: readonly { id: GrowthTimelineStepId, label: string }[] = [
  { id: "set-up", label: "Set up" },
  { id: "compute-metrics", label: "Metrics" },
  { id: "integrations", label: "Integrations" },
  { id: "analysis", label: "Deep research" },
  { id: "interview", label: "Interview" },
  { id: "report", label: "Report" },
];

export function getGrowthAdminLifecycleStep(value: string) {
  return GROWTH_ADMIN_LIFECYCLE_STEPS.find((step) => step.id === value) ?? null;
}
