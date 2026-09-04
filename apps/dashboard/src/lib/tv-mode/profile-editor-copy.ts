import type { TvProfileResource } from "@hexclave/shared/dist/interface/admin-tv-mode";

export const TV_EVENT_PREVIEW_GROUPS = [
  {
    title: "Celebration Previews",
    previews: [
      { fixture: "celebration-takeover", label: "Milestone Screen" },
      { fixture: "celebration-highlight", label: "Milestone Highlight" },
      { fixture: "event-long-content", label: "Long Event Content Highlight" },
    ],
  },
  {
    title: "Incident Previews",
    previews: [
      { fixture: "payment-incident-takeover", label: "Incident Screen · Payment Degradation" },
      { fixture: "incident-takeover", label: "Incident Screen · Email Degradation" },
      { fixture: "incident-highlight", label: "Incident Highlight" },
      { fixture: "incident-recovery", label: "Incident Recovery Screen" },
      { fixture: "incident-recovery-highlight", label: "Incident Recovery Highlight" },
    ],
  },
] as const;

export const TV_STATE_PREVIEWS = [
  { fixture: "stale", label: "Stale" },
  { fixture: "offline", label: "Offline" },
  { fixture: "financial-redacted", label: "Financial Redaction" },
  { fixture: "empty", label: "Empty" },
  { fixture: "insufficient-data", label: "Insufficient Data" },
  { fixture: "unavailable", label: "Unavailable Source" },
  { fixture: "partial-failure", label: "Partial Failure" },
  { fixture: "error", label: "Fatal Error" },
] as const;

export function getTvProfileEditorCopy(
  origin: TvProfileResource["origin"],
  createFromTemplate: boolean,
): {
  isTemplateDraft: boolean,
  breadcrumb: string,
  pageDescription: string,
  alertTitle: string,
  alertDescription: string,
  saveLabel: string,
} {
  const isTemplateDraft = origin === "built-in" || createFromTemplate;
  return isTemplateDraft ? {
    isTemplateDraft,
    breadcrumb: "Template Draft",
    pageDescription: "Customize this template without creating a project profile until you choose to save.",
    alertTitle: "Template Draft",
    alertDescription: "This Hexclave template remains unchanged. Save when ready to create a new project-owned profile.",
    saveLabel: "Save as New Profile",
  } : {
    isTemplateDraft,
    breadcrumb: "Saved Profile",
    pageDescription: "Configure this named TV presentation profile.",
    alertTitle: "Persisted Project Profile",
    alertDescription: "Changes are versioned and saved only to this project.",
    saveLabel: "Save Profile",
  };
}

export function getTvProfileOverviewAction(origin: TvProfileResource["origin"]): "Duplicate" | "Configure" {
  return origin === "built-in" ? "Duplicate" : "Configure";
}

export function getTvProfileEventCoverageLabel(
  preferences: TvProfileResource["configuration"]["interruptionPreferences"],
): "Incidents + Milestones" | "Incidents" | "Milestones" | "None" {
  const incidentsEnabled = preferences.incidentTypes.emailDeliveryDegradation
    || preferences.incidentTypes.subscriptionCollectionDegradation;
  const milestonesEnabled = preferences.celebrations.userMilestone
    || preferences.celebrations.revenueMilestone;
  if (incidentsEnabled && milestonesEnabled) return "Incidents + Milestones";
  if (incidentsEnabled) return "Incidents";
  if (milestonesEnabled) return "Milestones";
  return "None";
}
