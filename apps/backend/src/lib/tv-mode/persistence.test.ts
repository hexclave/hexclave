import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BooleanTrue,
  CustomerType,
  PurchaseCreationSource,
  SubscriptionStatus,
  TvEventOccurrenceLifecycle,
  TvEventPresentationClass,
  TvEventType,
} from "@/generated/prisma/client";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import {
  claimEvaluator,
  loadTvSubscriptionCollectionOutcomes,
  persistEmailEvaluation,
  readTvEmailState,
  synchronizeTvProfileAssignments,
  type TvEventOccurrenceRow,
} from "@/lib/tv-mode/events";
import {
  calculateTvEmailEvidenceRate,
  type TvEmailBaseline,
  type TvEmailEvaluationSample,
  type TvEmailEvaluatorState,
  type TvEmailEvidenceWindow,
} from "@/lib/tv-mode/event-evaluators";
import {
  createTvProfile,
  deleteTvProfile,
  duplicateSavedTvProfile,
  TvBuiltInProfileMutationError,
  TvProfileNameConflictError,
  TvProfileVersionConflictError,
  updateTvProfile,
} from "@/lib/tv-mode/profiles";
import { globalPrismaClient } from "@/prisma-client";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import {
  getTvBuiltInProfile,
  type TvInterruptionPreferences,
  type TvProfileResource,
} from "@hexclave/shared/dist/interface/admin-tv-mode";

describe.sequential("TV presentation persistence (real DB)", () => {
  let firstTenancy: Tenancy;
  let secondTenancy: Tenancy;
  const projectIds: string[] = [];
  const tenancyIds: string[] = [];

  async function createTestTenancy(): Promise<Tenancy> {
    const projectId = `tv-persistence-${randomUUID()}`;
    const tenancyId = randomUUID();
    projectIds.push(projectId);
    tenancyIds.push(tenancyId);
    await globalPrismaClient.project.create({
      data: {
        id: projectId,
        displayName: "TV Persistence Test",
        description: "",
        isProductionMode: false,
      },
    });
    await globalPrismaClient.tenancy.create({
      data: {
        id: tenancyId,
        projectId,
        branchId: "main",
        hasNoOrganization: BooleanTrue.TRUE,
      },
    });
    const tenancy = await getTenancy(tenancyId);
    if (tenancy == null) throw new Error("TV persistence test tenancy was not created");
    return tenancy;
  }

  async function createOccurrence(
    tenancyId: string,
    options?: { lifecycle?: "ACTIVE" | "RESOLVED", presentationClass?: "INCIDENT" | "CRITICAL_INCIDENT" },
  ): Promise<TvEventOccurrenceRow> {
    const id = randomUUID();
    const occurredAt = new Date("2026-07-31T10:00:00.000Z");
    const activatedAt = new Date("2026-07-31T10:01:00.000Z");
    const escalatedAt = options?.presentationClass === "CRITICAL_INCIDENT"
      ? new Date("2026-07-31T10:02:00.000Z")
      : null;
    const resolvedAt = options?.lifecycle === "RESOLVED"
      ? new Date("2026-07-31T10:03:00.000Z")
      : null;
    const presentationClass = options?.presentationClass ?? "INCIDENT";
    const lifecycle = options?.lifecycle ?? "ACTIVE";
    const created = await globalPrismaClient.tvEventOccurrence.create({
      data: {
        id,
        tenancyId,
        eventType: TvEventType.EMAIL_DELIVERY_DEGRADATION,
        presentationClass: presentationClass === "CRITICAL_INCIDENT"
          ? TvEventPresentationClass.CRITICAL_INCIDENT
          : TvEventPresentationClass.INCIDENT,
        lifecycle: lifecycle === "RESOLVED"
          ? TvEventOccurrenceLifecycle.RESOLVED
          : TvEventOccurrenceLifecycle.ACTIVE,
        deduplicationKey: `tv-persistence:${id}`,
        title: "Email Delivery Degraded",
        summary: "Test incident",
        metricLabel: "Delivery rate",
        metricValue: "90%",
        sourceLabel: "Hexclave email",
        aggregateEvidence: {},
        occurredAt,
        detectedAt: occurredAt,
        activatedAt,
        escalatedAt,
        resolvedAt,
      },
    });
    return {
      id: created.id,
      eventType: created.eventType,
      presentationClass: created.presentationClass,
      lifecycle: created.lifecycle,
      title: created.title,
      summary: created.summary,
      metricLabel: created.metricLabel,
      metricValue: created.metricValue,
      expectedRange: created.expectedRange,
      sourceLabel: created.sourceLabel,
      occurredAt: created.occurredAt,
      activatedAt: created.activatedAt,
      escalatedAt: created.escalatedAt,
      resolvedAt: created.resolvedAt,
      updatedAt: created.updatedAt,
    };
  }

  function profileWithTiming(id: string, timing: TvInterruptionPreferences["timing"]): TvProfileResource {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse TV template is missing");
    return {
      ...template,
      id,
      configuration: {
        ...template.configuration,
        interruptionPreferences: {
          ...template.configuration.interruptionPreferences,
          timing,
        },
      },
    };
  }

  const emailBaseline: TvEmailBaseline = {
    startsAt: "2026-07-01T00:00:00.000Z",
    endsAt: "2026-07-29T00:00:00.000Z",
    computedAt: "2026-07-29T12:00:00.000Z",
    assessableSends: 10_000,
    qualifiedDays: 28,
    days: [],
    medianDeliveryRatePercent: 99.9,
  };

  function emailWindow(assessable: number, failures: number): TvEmailEvidenceWindow {
    const delivered = assessable - failures;
    return {
      startsAt: "2026-07-29T11:40:00.000Z",
      endsAt: "2026-07-29T11:55:00.000Z",
      finishedSends: assessable,
      deliveredSends: delivered,
      bouncedSends: failures,
      serverErrorSends: 0,
      neutralOrUnknownSends: 0,
      explicitFailures: failures,
      ...calculateTvEmailEvidenceRate(delivered, failures),
    };
  }

  function emailSample(at: Date, assessable: number, failures: number): TvEmailEvaluationSample {
    return {
      status: "fresh",
      evaluatedAt: at.toISOString(),
      observedAt: at.toISOString(),
      current: emailWindow(assessable, failures),
      lowVolume: emailWindow(assessable * 4, failures * 4),
      baseline: emailBaseline,
    };
  }

  beforeEach(async () => {
    firstTenancy = await createTestTenancy();
    secondTenancy = await createTestTenancy();
  });

  it("allows only one concurrent evaluator claimant for a tenancy and interval", async () => {
    const now = new Date("2026-07-29T12:00:00.000Z");
    const claims = await Promise.all([
      claimEvaluator(firstTenancy, "email-delivery", now),
      claimEvaluator(firstTenancy, "email-delivery", now),
    ]);
    expect(claims.filter((claim) => claim != null)).toHaveLength(1);
  });

  it("prevents an expired evaluator claim from overwriting a newer claim", async () => {
    const firstAt = new Date("2026-07-29T12:00:00.000Z");
    const staleClaim = await claimEvaluator(firstTenancy, "email-delivery", firstAt);
    if (staleClaim == null) throw new Error("The first evaluator claim was not acquired");
    const secondAt = new Date(firstAt.getTime() + 60_001);
    const currentClaim = await claimEvaluator(firstTenancy, "email-delivery", secondAt);
    if (currentClaim == null) throw new Error("The replacement evaluator claim was not acquired");
    const activationState = {
      ruleVersion: 2,
      activeClass: null,
      candidate: {
        rulePath: "standard",
        presentationClass: "incident",
        accumulatedMs: 2 * 60_000,
        borderlineEvaluations: 0,
      },
      recovery: null,
      lastFreshEvaluatedAt: new Date(firstAt.getTime() - 60_000).toISOString(),
      baseline: emailBaseline,
    } satisfies TvEmailEvaluatorState;

    await persistEmailEvaluation({
      tenancy: firstTenancy,
      claim: staleClaim,
      previousState: activationState,
      sample: emailSample(firstAt, 100, 10),
      now: firstAt,
    });

    await expect(globalPrismaClient.tvEventOccurrence.count({
      where: { tenancyId: firstTenancy.id },
    })).resolves.toBe(0);
    await expect(globalPrismaClient.tvEventEvaluatorState.findUniqueOrThrow({
      where: { tenancyId_evaluatorKey: { tenancyId: firstTenancy.id, evaluatorKey: "email-delivery" } },
      select: { nextEvaluationAt: true },
    })).resolves.toEqual({ nextEvaluationAt: currentClaim.claimExpiresAt });
  });

  it("persists versioned activation and escalation evidence without overwriting activation", async () => {
    const activatedAt = new Date("2026-07-29T12:03:00.000Z");
    const activationClaim = await claimEvaluator(firstTenancy, "email-delivery", activatedAt);
    if (activationClaim == null) throw new Error("The evaluator claim was not acquired");
    const activationState = {
      ruleVersion: 2,
      activeClass: null,
      candidate: {
        rulePath: "standard",
        presentationClass: "incident",
        accumulatedMs: 2 * 60_000,
        borderlineEvaluations: 0,
      },
      recovery: null,
      lastFreshEvaluatedAt: new Date(activatedAt.getTime() - 60_000).toISOString(),
      baseline: emailBaseline,
    } satisfies TvEmailEvaluatorState;
    await persistEmailEvaluation({
      tenancy: firstTenancy,
      claim: activationClaim,
      previousState: activationState,
      sample: emailSample(activatedAt, 100, 10),
      now: activatedAt,
    });

    const afterActivation = await globalPrismaClient.tvEventOccurrence.findFirstOrThrow({
      where: { tenancyId: firstTenancy.id, lifecycle: TvEventOccurrenceLifecycle.ACTIVE },
    });
    expect(afterActivation.aggregateEvidence).toMatchObject({
      ruleVersion: 2,
      activation: {
        qualification: "standard",
        accumulatedMs: 3 * 60_000,
        qualificationEvidence: {
          requiredPersistenceMs: 3 * 60_000,
          thresholds: {
            minimumAssessableSends: 50,
            minimumExplicitFailures: 5,
            deliveryRateBelowPercent: 95,
            minimumBaselineDropPoints: 5,
          },
        },
      },
      latestActiveObservation: { qualification: "standard" },
    });

    const criticalAt = new Date("2026-07-29T12:05:00.000Z");
    const firstCriticalClaim = await claimEvaluator(firstTenancy, "email-delivery", criticalAt);
    if (firstCriticalClaim == null) throw new Error("The first Critical claim was not acquired");
    await persistEmailEvaluation({
      tenancy: firstTenancy,
      claim: firstCriticalClaim,
      previousState: readTvEmailState(firstCriticalClaim.typedState, "incident"),
      sample: emailSample(criticalAt, 50, 11),
      now: criticalAt,
    });

    const escalatedAt = new Date("2026-07-29T12:06:00.000Z");
    const secondCriticalClaim = await claimEvaluator(firstTenancy, "email-delivery", escalatedAt);
    if (secondCriticalClaim == null) throw new Error("The second Critical claim was not acquired");
    await persistEmailEvaluation({
      tenancy: firstTenancy,
      claim: secondCriticalClaim,
      previousState: readTvEmailState(secondCriticalClaim.typedState, "incident"),
      sample: emailSample(escalatedAt, 50, 11),
      now: escalatedAt,
    });

    const afterEscalation = await globalPrismaClient.tvEventOccurrence.findUniqueOrThrow({
      where: { tenancyId_id: { tenancyId: firstTenancy.id, id: afterActivation.id } },
    });
    expect(afterEscalation).toMatchObject({ presentationClass: TvEventPresentationClass.CRITICAL_INCIDENT });
    expect(afterEscalation.aggregateEvidence).toMatchObject({
      ruleVersion: 2,
      activation: { qualification: "standard" },
      escalation: { qualification: "critical" },
    });
  });

  it("fails loudly when escalation has no active occurrence", async () => {
    const now = new Date("2026-07-29T12:03:00.000Z");
    const claim = await claimEvaluator(firstTenancy, "email-delivery", now);
    if (claim == null) throw new Error("The evaluator claim was not acquired");
    const previousState = {
      ruleVersion: 2,
      activeClass: "incident",
      candidate: {
        rulePath: "critical",
        presentationClass: "critical-incident",
        accumulatedMs: 5 * 60_000,
        borderlineEvaluations: 0,
      },
      recovery: null,
      lastFreshEvaluatedAt: new Date(now.getTime() - 60_000).toISOString(),
      baseline: emailBaseline,
    } satisfies TvEmailEvaluatorState;
    await expect(persistEmailEvaluation({
      tenancy: firstTenancy,
      claim,
      previousState,
      sample: emailSample(now, 50, 11),
      now,
    })).rejects.toBeInstanceOf(HexclaveAssertionError);
  });

  it("fails loudly when resolution has no active occurrence", async () => {
    const now = new Date("2026-07-29T12:03:00.000Z");
    const claim = await claimEvaluator(firstTenancy, "email-delivery", now);
    if (claim == null) throw new Error("The evaluator claim was not acquired");
    const previousState = {
      ruleVersion: 2,
      activeClass: "incident",
      candidate: null,
      recovery: { window: "current", accumulatedMs: 4 * 60_000 },
      lastFreshEvaluatedAt: new Date(now.getTime() - 60_000).toISOString(),
      baseline: emailBaseline,
    } satisfies TvEmailEvaluatorState;
    await expect(persistEmailEvaluation({
      tenancy: firstTenancy,
      claim,
      previousState,
      sample: emailSample(now, 100, 0),
      now,
    })).rejects.toBeInstanceOf(HexclaveAssertionError);
  });

  it("excludes zero-value invoices from subscription collection outcomes", async () => {
    const stripeSubscriptionId = `sub_${randomUUID()}`;
    const startsAt = new Date("2026-08-20T12:00:00.000Z");
    const endsAt = new Date("2026-08-20T13:00:00.000Z");
    await globalPrismaClient.subscription.create({
      data: {
        tenancyId: firstTenancy.id,
        customerId: `customer-${randomUUID()}`,
        customerType: CustomerType.USER,
        product: {},
        stripeSubscriptionId,
        status: SubscriptionStatus.active,
        currentPeriodStart: startsAt,
        currentPeriodEnd: endsAt,
        cancelAtPeriodEnd: false,
        creationSource: PurchaseCreationSource.PURCHASE_PAGE,
      },
    });
    await globalPrismaClient.subscriptionInvoice.createMany({
      data: [
        {
          tenancyId: firstTenancy.id,
          stripeSubscriptionId,
          stripeInvoiceId: `in_zero_paid_${randomUUID()}`,
          isSubscriptionCreationInvoice: true,
          status: "paid",
          amountTotal: 0,
          amountPaid: 0,
          paidAt: new Date("2026-08-20T12:10:00.000Z"),
        },
        {
          tenancyId: firstTenancy.id,
          stripeSubscriptionId,
          stripeInvoiceId: `in_positive_paid_${randomUUID()}`,
          isSubscriptionCreationInvoice: false,
          status: "paid",
          amountTotal: 1_000,
          amountPaid: 1_000,
          paidAt: new Date("2026-08-20T12:20:00.000Z"),
        },
        {
          tenancyId: firstTenancy.id,
          stripeSubscriptionId,
          stripeInvoiceId: `in_positive_failed_${randomUUID()}`,
          isSubscriptionCreationInvoice: false,
          status: "uncollectible",
          amountTotal: 1_000,
          amountPaid: 0,
          markedUncollectibleAt: new Date("2026-08-20T12:30:00.000Z"),
        },
        {
          tenancyId: firstTenancy.id,
          stripeSubscriptionId,
          stripeInvoiceId: `in_positive_paid_tie_${randomUUID()}`,
          isSubscriptionCreationInvoice: false,
          status: "paid",
          amountTotal: 1_000,
          amountPaid: 1_000,
          paidAt: new Date("2026-08-20T12:35:00.000Z"),
          markedUncollectibleAt: new Date("2026-08-20T12:35:00.000Z"),
        },
        {
          tenancyId: firstTenancy.id,
          stripeSubscriptionId,
          stripeInvoiceId: `in_zero_paid_tie_${randomUUID()}`,
          isSubscriptionCreationInvoice: false,
          status: "uncollectible",
          amountTotal: 1_000,
          amountPaid: 0,
          paidAt: new Date("2026-08-20T12:36:00.000Z"),
          markedUncollectibleAt: new Date("2026-08-20T12:36:00.000Z"),
        },
        {
          tenancyId: firstTenancy.id,
          stripeSubscriptionId,
          stripeInvoiceId: `in_zero_failed_${randomUUID()}`,
          isSubscriptionCreationInvoice: false,
          status: "uncollectible",
          amountTotal: 0,
          amountPaid: 0,
          markedUncollectibleAt: new Date("2026-08-20T12:40:00.000Z"),
        },
      ],
    });

    const outcomes = await loadTvSubscriptionCollectionOutcomes(firstTenancy, startsAt, endsAt);
    expect(outcomes.sort((left, right) => left.outcomeAt.getTime() - right.outcomeAt.getTime())).toEqual([
      { outcomeAt: new Date("2026-08-20T12:20:00.000Z"), success: true },
      { outcomeAt: new Date("2026-08-20T12:30:00.000Z"), success: false },
      { outcomeAt: new Date("2026-08-20T12:35:00.000Z"), success: true },
    ]);
  });

  afterEach(async () => {
    try {
      await globalPrismaClient.subscriptionInvoice.deleteMany({ where: { tenancyId: { in: tenancyIds } } });
      await globalPrismaClient.subscription.deleteMany({ where: { tenancyId: { in: tenancyIds } } });
      await globalPrismaClient.project.deleteMany({ where: { id: { in: projectIds } } });
    } finally {
      projectIds.splice(0);
      tenancyIds.splice(0);
    }
  });

  it("freezes one complete takeover, recovery, and Highlight deadline set under concurrent assignment", async () => {
    const occurrence = await createOccurrence(firstTenancy.id, {
      lifecycle: "RESOLVED",
      presentationClass: "CRITICAL_INCIDENT",
    });
    const profileId = randomUUID();
    const firstTiming: TvInterruptionPreferences["timing"] = {
      celebration: { takeoverSeconds: 60, animationSeconds: 3600, highlightSeconds: 21600 },
      incident: { takeoverSeconds: 30, recoveryTakeoverSeconds: 30, resolvedHighlightSeconds: 3600 },
      criticalIncident: { takeoverSeconds: 60, recoveryTakeoverSeconds: 60, resolvedHighlightSeconds: 21600 },
    };
    const secondTiming: TvInterruptionPreferences["timing"] = {
      celebration: { takeoverSeconds: 60, animationSeconds: 3600, highlightSeconds: 21600 },
      incident: { takeoverSeconds: 30, recoveryTakeoverSeconds: 30, resolvedHighlightSeconds: 3600 },
      criticalIncident: { takeoverSeconds: 120, recoveryTakeoverSeconds: 120, resolvedHighlightSeconds: 43200 },
    };
    const now = new Date("2026-07-31T10:03:05.000Z");

    await Promise.all([
      synchronizeTvProfileAssignments({
        tenancy: firstTenancy,
        profile: profileWithTiming(profileId, firstTiming),
        occurrences: [occurrence],
        now,
      }),
      synchronizeTvProfileAssignments({
        tenancy: firstTenancy,
        profile: profileWithTiming(profileId, secondTiming),
        occurrences: [occurrence],
        now,
      }),
    ]);

    const assigned = await globalPrismaClient.tvProfileEventPresentation.findUniqueOrThrow({
      where: { tenancyId_profileId_occurrenceId: { tenancyId: firstTenancy.id, profileId, occurrenceId: occurrence.id } },
    });
    const firstWriterSet = {
      takeoverEndsAt: new Date("2026-07-31T10:03:00.000Z"),
      recoveryEndsAt: new Date("2026-07-31T10:04:00.000Z"),
      highlightExpiresAt: new Date("2026-07-31T16:03:00.000Z"),
    };
    const secondWriterSet = {
      takeoverEndsAt: new Date("2026-07-31T10:04:00.000Z"),
      recoveryEndsAt: new Date("2026-07-31T10:05:00.000Z"),
      highlightExpiresAt: new Date("2026-07-31T22:03:00.000Z"),
    };
    expect([
      firstWriterSet,
      secondWriterSet,
    ]).toContainEqual({
      takeoverEndsAt: assigned.takeoverEndsAt,
      recoveryEndsAt: assigned.recoveryEndsAt,
      highlightExpiresAt: assigned.highlightExpiresAt,
    });

    await synchronizeTvProfileAssignments({
      tenancy: firstTenancy,
      profile: profileWithTiming(profileId, {
        ...secondTiming,
        criticalIncident: { takeoverSeconds: 30, recoveryTakeoverSeconds: 30, resolvedHighlightSeconds: 86400 },
      }),
      occurrences: [occurrence],
      now: new Date("2026-07-31T10:03:10.000Z"),
    });
    await expect(globalPrismaClient.tvProfileEventPresentation.findUniqueOrThrow({
      where: { tenancyId_profileId_occurrenceId: { tenancyId: firstTenancy.id, profileId, occurrenceId: occurrence.id } },
    })).resolves.toMatchObject({
      takeoverEndsAt: assigned.takeoverEndsAt,
      recoveryEndsAt: assigned.recoveryEndsAt,
      highlightExpiresAt: assigned.highlightExpiresAt,
      updatedAt: assigned.updatedAt,
    });
  });

  it("does not rewrite an assignment after policy supersession is already persisted", async () => {
    const occurrence = await createOccurrence(firstTenancy.id);
    const secondOccurrence = await createOccurrence(firstTenancy.id);
    const profileId = randomUUID();
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse TV template is missing");
    const profile = profileWithTiming(profileId, template.configuration.interruptionPreferences.timing);
    const disabledProfile: TvProfileResource = {
      ...profile,
      configuration: {
        ...profile.configuration,
        interruptionPreferences: {
          ...profile.configuration.interruptionPreferences,
          incidentTypes: {
            ...profile.configuration.interruptionPreferences.incidentTypes,
            emailDeliveryDegradation: false,
          },
        },
      },
    };

    await synchronizeTvProfileAssignments({
      tenancy: firstTenancy,
      profile,
      occurrences: [occurrence, secondOccurrence],
      now: new Date("2026-07-31T10:01:10.000Z"),
    });
    await synchronizeTvProfileAssignments({
      tenancy: firstTenancy,
      profile: disabledProfile,
      occurrences: [occurrence, secondOccurrence],
      now: new Date("2026-07-31T10:01:20.000Z"),
    });
    const superseded = new Map((await globalPrismaClient.tvProfileEventPresentation.findMany({
      where: { tenancyId: firstTenancy.id, profileId },
    })).map((assignment) => [assignment.occurrenceId, assignment]));
    expect(superseded.size).toBe(2);

    await synchronizeTvProfileAssignments({
      tenancy: firstTenancy,
      profile: disabledProfile,
      occurrences: [occurrence, secondOccurrence],
      now: new Date("2026-07-31T10:01:30.000Z"),
    });
    const afterRepeatedSynchronization = await globalPrismaClient.tvProfileEventPresentation.findMany({
      where: { tenancyId: firstTenancy.id, profileId },
    });
    expect(afterRepeatedSynchronization).toHaveLength(2);
    for (const assignment of afterRepeatedSynchronization) {
      expect(assignment).toMatchObject({
        supersededAt: superseded.get(assignment.occurrenceId)?.supersededAt,
        updatedAt: superseded.get(assignment.occurrenceId)?.updatedAt,
      });
    }
  });

  it("removes only the deleted saved profile's assignments", async () => {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse TV template is missing");
    const profile = await createTvProfile(firstTenancy, {
      ...template.configuration,
      displayName: "Deletion Cleanup",
    });
    if (profile == null) throw new Error("TV profile persistence is unavailable");
    const firstOccurrence = await createOccurrence(firstTenancy.id);
    const secondOccurrence = await createOccurrence(secondTenancy.id);
    await globalPrismaClient.tvProfileEventPresentation.createMany({
      data: [
        { tenancyId: firstTenancy.id, profileId: profile.id, occurrenceId: firstOccurrence.id },
        { tenancyId: secondTenancy.id, profileId: profile.id, occurrenceId: secondOccurrence.id },
      ],
    });

    await expect(deleteTvProfile(firstTenancy, profile.id, profile.version)).resolves.toBe(true);
    await expect(globalPrismaClient.tvProfileEventPresentation.count({
      where: { tenancyId: firstTenancy.id, profileId: profile.id },
    })).resolves.toBe(0);
    await expect(globalPrismaClient.tvProfileEventPresentation.count({
      where: { tenancyId: secondTenancy.id, profileId: profile.id },
    })).resolves.toBe(1);
    await expect(globalPrismaClient.tvEventOccurrence.count({
      where: { id: { in: [firstOccurrence.id, secondOccurrence.id] } },
    })).resolves.toBe(2);
  });

  it("does not mutate built-in profile assignments", async () => {
    const occurrence = await createOccurrence(firstTenancy.id);
    await globalPrismaClient.tvProfileEventPresentation.create({
      data: { tenancyId: firstTenancy.id, profileId: "company-pulse", occurrenceId: occurrence.id },
    });

    await expect(deleteTvProfile(firstTenancy, "company-pulse", 1)).rejects.toBeInstanceOf(TvBuiltInProfileMutationError);
    await expect(globalPrismaClient.tvProfileEventPresentation.count({
      where: { tenancyId: firstTenancy.id, profileId: "company-pulse" },
    })).resolves.toBe(1);
  });

  it("deletes a saved profile that has no assignments", async () => {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse TV template is missing");
    const profile = await createTvProfile(firstTenancy, {
      ...template.configuration,
      displayName: "No Assignment Cleanup",
    });
    if (profile == null) throw new Error("TV profile persistence is unavailable");

    await expect(deleteTvProfile(firstTenancy, profile.id, profile.version)).resolves.toBe(true);
  });

  it("conditions a saved-profile duplicate on the source version in the insert", async () => {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse TV template is missing");
    const source = await createTvProfile(firstTenancy, {
      ...template.configuration,
      displayName: "Atomic Duplicate Source",
    });
    if (source == null) throw new Error("TV profile persistence is unavailable");
    const updated = await updateTvProfile(firstTenancy, source.id, source.version, {
      ...source.configuration,
      description: "Changed after the duplicate form loaded.",
    });
    if (updated == null) throw new Error("TV profile update unexpectedly returned no resource");

    await expect(duplicateSavedTvProfile(firstTenancy, source.id, source.version, {
      ...source.configuration,
      displayName: "Stale Atomic Duplicate",
    })).rejects.toBeInstanceOf(TvProfileVersionConflictError);
    await expect(globalPrismaClient.tvPresentationProfile.count({
      where: { tenancyId: firstTenancy.id, displayName: "Stale Atomic Duplicate" },
    })).resolves.toBe(0);

    await expect(duplicateSavedTvProfile(firstTenancy, source.id, updated.version, {
      ...updated.configuration,
      displayName: "Current Atomic Duplicate",
    })).resolves.toMatchObject({
      configuration: {
        displayName: "Current Atomic Duplicate",
        description: "Changed after the duplicate form loaded.",
      },
    });
  });

  it("returns one stable name conflict when concurrent profile renames target the same name", async () => {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse TV template is missing");
    const [first, second] = await Promise.all([
      createTvProfile(firstTenancy, { ...template.configuration, displayName: "Concurrent Rename A" }),
      createTvProfile(firstTenancy, { ...template.configuration, displayName: "Concurrent Rename B" }),
    ]);
    if (first == null || second == null) throw new Error("TV profile persistence is unavailable");

    const results = await Promise.allSettled([
      updateTvProfile(firstTenancy, first.id, first.version, { ...first.configuration, displayName: "Shared Rename" }),
      updateTvProfile(firstTenancy, second.id, second.version, { ...second.configuration, displayName: "Shared Rename" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(TvProfileNameConflictError);
    await expect(globalPrismaClient.tvPresentationProfile.count({
      where: { tenancyId: firstTenancy.id, normalizedDisplayName: "shared rename" },
    })).resolves.toBe(1);
  });

  it("rejects malformed saved-profile IDs before PostgreSQL UUID casts", async () => {
    const template = getTvBuiltInProfile("company-pulse");
    if (template == null) throw new Error("Company Pulse TV template is missing");

    await expect(updateTvProfile(
      firstTenancy,
      "not-a-uuid",
      1,
      template.configuration,
    )).resolves.toBeNull();
    await expect(deleteTvProfile(firstTenancy, "not-a-uuid", 1)).resolves.toBe(false);
  });
});
