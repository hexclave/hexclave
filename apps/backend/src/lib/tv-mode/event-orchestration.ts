import type { TvInterruptionPreferences } from "@hexclave/shared/dist/interface/admin-tv-mode";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

export type TvDurableEventOccurrence = {
  id: string,
  type: "email-delivery-degradation" | "subscription-collection-degradation" | "user-milestone",
  presentationClass: "celebration" | "incident" | "critical-incident",
  lifecycle: "occurred" | "active" | "resolved",
  occurredAt: Date,
  activatedAt: Date,
  resolvedAt: Date | null,
};

export type TvDurablePresentationAssignment = {
  occurrenceId: string,
  takeoverStartedAt: Date | null,
  takeoverEndsAt: Date | null,
  recoveryEndsAt: Date | null,
  highlightExpiresAt: Date | null,
  animationExpiresAt: Date | null,
  supersededAt: Date | null,
};

export type TvDerivedPresentation = {
  takeover: {
    occurrenceId: string,
    variant: "celebration" | "incident" | "critical-incident" | "recovery-confirmation",
    startedAt: Date,
    endsAt: Date,
  } | null,
  highlight: {
    occurrenceId: string,
    variant: "celebration" | "active-incident" | "resolved-incident",
    expiresAt: Date | null,
    animationExpiresAt: Date | null,
  } | null,
};

function addSeconds(timestamp: Date, seconds: number): Date {
  return new Date(timestamp.getTime() + seconds * 1000);
}

export function createTvPresentationAssignment(options: {
  occurrence: TvDurableEventOccurrence,
  preferences: TvInterruptionPreferences,
  takeoverStartedAt: Date | null,
}): TvDurablePresentationAssignment {
  const { occurrence, preferences, takeoverStartedAt } = options;
  if (occurrence.presentationClass === "celebration") {
    return {
      occurrenceId: occurrence.id,
      takeoverStartedAt,
      takeoverEndsAt: takeoverStartedAt == null
        ? null
        : addSeconds(takeoverStartedAt, preferences.timing.celebration.takeoverSeconds),
      // These clocks describe the milestone's relevance, not how long a TV
      // happened to be free to present it. Suspension therefore cannot extend them.
      highlightExpiresAt: addSeconds(occurrence.occurredAt, preferences.timing.celebration.highlightSeconds),
      animationExpiresAt: addSeconds(occurrence.occurredAt, preferences.timing.celebration.animationSeconds),
      supersededAt: null,
      recoveryEndsAt: null,
    };
  }
  const timing = occurrence.presentationClass === "critical-incident"
    ? preferences.timing.criticalIncident
    : preferences.timing.incident;
  return {
    occurrenceId: occurrence.id,
    takeoverStartedAt,
    takeoverEndsAt: takeoverStartedAt == null
      ? null
      : addSeconds(takeoverStartedAt, timing.takeoverSeconds),
    recoveryEndsAt: occurrence.resolvedAt == null
      ? null
      : addSeconds(occurrence.resolvedAt, timing.recoveryTakeoverSeconds),
    highlightExpiresAt: occurrence.resolvedAt == null
      ? null
      : addSeconds(occurrence.resolvedAt, timing.resolvedHighlightSeconds),
    animationExpiresAt: null,
    supersededAt: null,
  };
}

function occurrenceRank(occurrence: TvDurableEventOccurrence): number {
  if (occurrence.presentationClass === "critical-incident") return 3;
  if (occurrence.presentationClass === "incident") return 2;
  return 1;
}

function eventTypeRank(occurrence: TvDurableEventOccurrence): number {
  if (occurrence.type === "email-delivery-degradation") return 2;
  return occurrence.type === "subscription-collection-degradation" ? 1 : 0;
}

function selectOutrankingOccurrence(
  occurrences: TvDurableEventOccurrence[],
): TvDurableEventOccurrence | null {
  return [...occurrences]
    .filter((occurrence) => occurrence.lifecycle === "active" && occurrence.presentationClass !== "celebration")
    .sort((left, right) => (
      occurrenceRank(right) - occurrenceRank(left)
      || eventTypeRank(right) - eventTypeRank(left)
      || left.activatedAt.getTime() - right.activatedAt.getTime()
      || stringCompare(left.id, right.id)
    ))
    .at(0) ?? null;
}

function isBefore(date: Date | null, now: Date): boolean {
  return date != null && now.getTime() < date.getTime();
}

export function deriveTvPresentation(options: {
  now: Date,
  occurrences: TvDurableEventOccurrence[],
  assignments: TvDurablePresentationAssignment[],
}): TvDerivedPresentation {
  // A presentation assignment is the profile-specific authorization to render
  // an occurrence. Superseded and missing assignments must therefore be
  // excluded before any lifecycle branch chooses a presentation.
  const assignments = new Map(
    options.assignments
      .filter((assignment) => assignment.supersededAt == null)
      .map((assignment) => [assignment.occurrenceId, assignment]),
  );
  const presentableOccurrences = options.occurrences.filter((occurrence) => assignments.has(occurrence.id));
  const activeIncident = selectOutrankingOccurrence(presentableOccurrences);
  if (activeIncident != null) {
    const assignment = assignments.get(activeIncident.id);
    if (assignment == null || assignment.takeoverStartedAt == null || assignment.takeoverEndsAt == null) {
      throw new Error(`Active TV incident "${activeIncident.id}" has no presentation assignment`);
    }
    const showTakeover = isBefore(assignment.takeoverEndsAt, options.now);
    return {
      takeover: showTakeover ? {
        occurrenceId: activeIncident.id,
        variant: activeIncident.presentationClass,
        startedAt: assignment.takeoverStartedAt,
        endsAt: assignment.takeoverEndsAt,
      } : null,
      highlight: {
        occurrenceId: activeIncident.id,
        variant: "active-incident",
        expiresAt: null,
        animationExpiresAt: null,
      },
    };
  }

  const recovery = [...presentableOccurrences]
    .filter((occurrence) => occurrence.resolvedAt != null)
    .sort((left, right) => (
      (right.resolvedAt?.getTime() ?? 0) - (left.resolvedAt?.getTime() ?? 0)
    ))
    .find((occurrence) => isBefore(assignments.get(occurrence.id)?.recoveryEndsAt ?? null, options.now));
  if (recovery != null && recovery.resolvedAt != null) {
    const recoveryEndsAt = assignments.get(recovery.id)?.recoveryEndsAt;
    if (recoveryEndsAt == null) throw new Error(`Resolved TV incident "${recovery.id}" has no recovery deadline`);
    return {
      takeover: {
        occurrenceId: recovery.id,
        variant: "recovery-confirmation",
        startedAt: recovery.resolvedAt,
        endsAt: recoveryEndsAt,
      },
      highlight: {
        occurrenceId: recovery.id,
        variant: "resolved-incident",
        expiresAt: assignments.get(recovery.id)?.highlightExpiresAt ?? null,
        animationExpiresAt: null,
      },
    };
  }

  const celebration = [...presentableOccurrences]
    .filter((occurrence) => occurrence.presentationClass === "celebration")
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .find((occurrence) => {
      const assignment = assignments.get(occurrence.id);
      return assignment != null && isBefore(assignment.highlightExpiresAt, options.now);
    });
  if (celebration != null) {
    const assignment = assignments.get(celebration.id);
    if (assignment == null) throw new Error(`Celebration "${celebration.id}" has no presentation assignment`);
    const takeover: TvDerivedPresentation["takeover"] = assignment.takeoverStartedAt != null
      && assignment.takeoverEndsAt != null
      && isBefore(assignment.takeoverEndsAt, options.now)
      ? {
        occurrenceId: celebration.id,
        variant: "celebration",
        startedAt: assignment.takeoverStartedAt,
        endsAt: assignment.takeoverEndsAt,
      }
      : null;
    return {
      takeover,
      highlight: {
        occurrenceId: celebration.id,
        variant: "celebration",
        expiresAt: assignment.highlightExpiresAt,
        animationExpiresAt: assignment.animationExpiresAt,
      },
    };
  }

  const resolvedIncident = [...presentableOccurrences]
    .filter((occurrence) => occurrence.lifecycle === "resolved" && occurrence.presentationClass !== "celebration")
    .sort((left, right) => (
      (right.resolvedAt?.getTime() ?? 0) - (left.resolvedAt?.getTime() ?? 0)
    ))
    .find((occurrence) => isBefore(assignments.get(occurrence.id)?.highlightExpiresAt ?? null, options.now));
  return {
    takeover: null,
    highlight: resolvedIncident == null ? null : {
      occurrenceId: resolvedIncident.id,
      variant: "resolved-incident",
      expiresAt: assignments.get(resolvedIncident.id)?.highlightExpiresAt ?? null,
      animationExpiresAt: null,
    },
  };
}
