import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BooleanTrue, EmailOutboxCreatedWith, EmailOutboxSkippedReason } from "@/generated/prisma/client";
import { getTenancy, type Tenancy } from "@/lib/tenancies";
import * as emailActivityModule from "@/lib/tv-mode/email-activity";
import { loadTvEmailSendActivity } from "@/lib/tv-mode/email-activity";
import { loadEmailScreen } from "@/lib/tv-mode/snapshot";
import { globalPrismaClient } from "@/prisma-client";
import { TvEmailHealthScreenSchema } from "@hexclave/shared/dist/interface/admin-tv-mode";

describe.sequential("TV email sending activity (real DB)", () => {
  const projectId = `tv-email-activity-${randomUUID()}`;
  const tenancyId = randomUUID();
  const now = new Date("2026-09-22T12:00:00.000Z");
  let tenancy: Tenancy;

  async function createEmail(createdAt: string, finishedAt: string | null, failed = false, forTenancyId = tenancyId) {
    return await globalPrismaClient.emailOutbox.create({
      data: {
        tenancyId: forTenancyId,
        createdAt: new Date(createdAt),
        tsxSource: "/* TV sending activity test */",
        isHighPriority: false,
        to: { type: "custom-emails", emails: ["tv-test@example.com"] },
        extraRenderVariables: {},
        shouldSkipDeliverabilityCheck: true,
        createdWith: EmailOutboxCreatedWith.PROGRAMMATIC_CALL,
        scheduledAt: new Date(createdAt),
        isQueued: true,
        // Prevent the development worker from sending synthetic test rows.
        isPaused: true,
        renderedByWorkerId: randomUUID(),
        startedRenderingAt: new Date(createdAt),
        finishedRenderingAt: new Date(createdAt),
        renderedHtml: "<p>TV activity test</p>",
        renderedText: "TV activity test",
        renderedSubject: "TV activity test",
        renderedIsTransactional: false,
        startedSendingAt: finishedAt == null ? null : new Date(finishedAt),
        finishedSendingAt: finishedAt == null ? null : new Date(finishedAt),
        canHaveDeliveryInfo: finishedAt == null ? null : false,
        ...(failed ? {
          sendServerErrorExternalMessage: "Test send failure",
          sendServerErrorExternalDetails: {},
          sendServerErrorInternalMessage: "Test send failure",
          sendServerErrorInternalDetails: {},
        } : {}),
      },
    });
  }

  beforeAll(async () => {
    await globalPrismaClient.project.create({ data: {
      id: projectId, displayName: "TV Email Activity Test", description: "", isProductionMode: false,
    } });
    await globalPrismaClient.tenancy.create({ data: {
      id: tenancyId, projectId, branchId: "main", hasNoOrganization: BooleanTrue.TRUE,
    } });
    const created = await getTenancy(tenancyId);
    if (created == null) throw new Error("TV email activity test tenancy was not created");
    tenancy = {
      ...created,
      config: { ...created.config, apps: { ...created.config.apps, installed: {
        ...created.config.apps.installed, emails: { enabled: true },
      } } },
    };
  });

  afterAll(async () => {
    await globalPrismaClient.project.deleteMany({ where: { id: projectId } });
  });

  it("returns an empty series for a tenancy with no emails", async () => {
    const activity = await loadTvEmailSendActivity(tenancy, now);
    expect(activity).toMatchObject({ sent: 0, failed: 0 });
    expect(activity.trend).toHaveLength(8);
    expect(activity.trend.every(point => point.primary + point.secondary + point.tertiary === 0)).toBe(true);
  });

  it("counts receipt-free sends by completion time and keeps failures separate", async () => {
    // This scheduled email was created outside the legacy creation-date window.
    await createEmail("2026-09-01T10:00:00Z", "2026-09-22T10:00:00Z");
    const screen = await loadEmailScreen(tenancy, now, true);
    expect(screen.status).toBe("success");
    expect(screen.screen).toMatchObject({
      sourceStatus: "insufficient-data",
      data: { sent: 0, delivered: 0, assessableSends: 0, sendActivity: { sent: 1, failed: 0 } },
    });
    await expect(TvEmailHealthScreenSchema.validate(screen.screen, { strict: true })).resolves.toBeDefined();
    const legacy = await loadEmailScreen(tenancy, now);
    expect(legacy.screen).toMatchObject({ sourceStatus: "empty", data: null });

    await createEmail("2026-09-21T09:00:00Z", "2026-09-21T10:00:00Z", true);
    await createEmail("2026-09-15T11:00:00Z", "2026-09-15T12:00:00Z"); // Inclusive start.
    await createEmail("2026-09-15T11:00:00Z", "2026-09-15T11:59:59Z"); // Too old.
    await createEmail("2026-09-22T10:00:00Z", "2026-09-22T12:00:00Z"); // Exclusive end.
    await createEmail("2026-09-22T10:00:00Z", null);
    const skipped = await createEmail("2026-09-22T10:00:00Z", null);
    await globalPrismaClient.emailOutbox.update({
      where: { tenancyId_id: { tenancyId, id: skipped.id } },
      data: { skippedReason: EmailOutboxSkippedReason.MANUALLY_CANCELLED, skippedDetails: {} },
    });

    const activity = await loadTvEmailSendActivity(tenancy, now);
    expect(activity).toMatchObject({ sent: 2, failed: 1 });
    expect(activity.trend).toEqual([
      { label: "Sep 15", primary: 1, secondary: 0, tertiary: 0 },
      { label: "Sep 16", primary: 0, secondary: 0, tertiary: 0 },
      { label: "Sep 17", primary: 0, secondary: 0, tertiary: 0 },
      { label: "Sep 18", primary: 0, secondary: 0, tertiary: 0 },
      { label: "Sep 19", primary: 0, secondary: 0, tertiary: 0 },
      { label: "Sep 20", primary: 0, secondary: 0, tertiary: 0 },
      { label: "Sep 21", primary: 0, secondary: 1, tertiary: 0 },
      { label: "Sep 22", primary: 1, secondary: 0, tertiary: 1 },
    ]);

    const awaitingReceipt = await createEmail("2026-09-22T10:00:00Z", "2026-09-22T11:00:00Z");
    await globalPrismaClient.emailOutbox.update({
      where: { tenancyId_id: { tenancyId, id: awaitingReceipt.id } },
      data: { canHaveDeliveryInfo: true },
    });
    const withPendingReceipt = await loadTvEmailSendActivity(tenancy, now);
    expect(withPendingReceipt.sent).toBe(3);
    // A completed send awaiting its receipt must not also count as unsent queue.
    expect(withPendingReceipt.trend.reduce((sum, point) => sum + point.tertiary, 0)).toBe(1);

    const otherTenancyId = randomUUID();
    await globalPrismaClient.tenancy.create({ data: {
      id: otherTenancyId, projectId, branchId: "isolated", hasNoOrganization: BooleanTrue.TRUE,
    } });
    expect(await loadTvEmailSendActivity({ ...tenancy, id: otherTenancyId }, now)).toMatchObject({ sent: 0, failed: 0 });
  });

  it("returns the visible error state when the send activity query fails", async () => {
    const activitySpy = vi.spyOn(emailActivityModule, "loadTvEmailSendActivity")
      .mockRejectedValue(new Error("simulated read replica failure"));
    try {
      const screen = await loadEmailScreen(tenancy, now, true);
      expect(activitySpy).toHaveBeenCalled();
      expect(screen.status).toBe("error");
      expect(screen.screen).toMatchObject({
        sourceStatus: "error",
        diagnosticCode: "source-query-failed",
        data: null,
        insight: null,
      });
    } finally {
      activitySpy.mockRestore();
    }
  });

  it("does not report an empty screen when only receipt-free activity exists and its query fails", async () => {
    // Legacy metrics key off createdAt, so a scheduled email created before the
    // window but sent inside it is invisible to them; the sending aggregate is
    // the only source that sees it. If that aggregate fails, an "empty" success
    // would hide a real send behind a healthy-looking screen.
    const isolatedTenancyId = randomUUID();
    await globalPrismaClient.tenancy.create({ data: {
      id: isolatedTenancyId, projectId, branchId: "activity-failure", hasNoOrganization: BooleanTrue.TRUE,
    } });
    const isolatedTenancy = { ...tenancy, id: isolatedTenancyId };
    await createEmail("2026-09-01T10:00:00Z", "2026-09-22T10:00:00Z", false, isolatedTenancyId);
    const healthy = await loadEmailScreen(isolatedTenancy, now, true);
    expect(healthy.status).toBe("success");
    expect(healthy.screen).toMatchObject({ sourceStatus: "insufficient-data", data: { sent: 0, sendActivity: { sent: 1, failed: 0 } } });

    const activitySpy = vi.spyOn(emailActivityModule, "loadTvEmailSendActivity")
      .mockRejectedValue(new Error("simulated read replica failure"));
    try {
      const screen = await loadEmailScreen(isolatedTenancy, now, true);
      expect(screen.status).toBe("error");
      expect(screen.screen).toMatchObject({ sourceStatus: "error", diagnosticCode: "source-query-failed", data: null });
      expect(screen.screen.sourceStatus).not.toBe("empty");
    } finally {
      activitySpy.mockRestore();
    }
  });
});
