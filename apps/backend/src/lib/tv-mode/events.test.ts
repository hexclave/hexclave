import { globalPrismaClient, sqlQuoteIdent } from "@/prisma-client";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TV_EMAIL_RULE_VERSION } from "./event-evaluators";
import {
  buildTvEmailBaseline,
  getTvEmailEvaluatorBounds,
  readTvEmailState,
  tvEventTablesAreReadyForSchema,
} from "./events";

describe("TV email evaluator integration helpers", () => {
  it("uses mature 15-minute and six-hour windows with the same end boundary", () => {
    expect(getTvEmailEvaluatorBounds(new Date("2026-07-29T12:00:00.000Z"))).toEqual({
      currentStartsAt: new Date("2026-07-29T11:40:00.000Z"),
      currentEndsAt: new Date("2026-07-29T11:55:00.000Z"),
      lowVolumeStartsAt: new Date("2026-07-29T05:55:00.000Z"),
      lowVolumeEndsAt: new Date("2026-07-29T11:55:00.000Z"),
    });
  });

  it("uses the median of qualified daily rates and resists degraded historical days", () => {
    const baseline = buildTvEmailBaseline({
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: new Date("2026-07-29T00:00:00.000Z"),
      computedAt: new Date("2026-07-29T12:00:00.000Z"),
      rows: [
        [99, 1, 100],
        [995, 5, 1000],
        [998, 2, 1000],
        [70, 30, 100],
        [72, 28, 100],
        [999, 1, 1000],
        [100, 0, 100],
      ].map(([delivered, failures, assessable], index) => ({
        day: new Date(Date.UTC(2026, 6, index + 1)),
        delivered,
        failures,
        assessable,
      })),
    });
    expect(baseline).toMatchObject({
      assessableSends: 3400,
      qualifiedDays: 7,
      medianDeliveryRatePercent: 99.5,
    });
  });

  it("does not qualify fewer than seven historical days", () => {
    expect(buildTvEmailBaseline({
      startsAt: new Date("2026-07-01T00:00:00.000Z"),
      endsAt: new Date("2026-07-29T00:00:00.000Z"),
      computedAt: new Date("2026-07-29T12:00:00.000Z"),
      rows: Array.from({ length: 6 }, (_, index) => ({
        day: new Date(Date.UTC(2026, 6, index + 1)),
        delivered: 99,
        failures: 1,
        assessable: 100,
      })),
    }).medianDeliveryRatePercent).toBeNull();
  });

  it("upgrades legacy state without replaying counters and preserves an active occurrence class", () => {
    expect(readTvEmailState({ recoveryCount: 4, incidentBreachCount: 2 }, "critical-incident")).toEqual({
      ruleVersion: TV_EMAIL_RULE_VERSION,
      activeClass: "critical-incident",
      candidate: null,
      recovery: null,
      lastFreshEvaluatedAt: null,
      baseline: null,
    });
  });

  it("rejects malformed V2 typed state rather than silently trusting it", () => {
    expect(readTvEmailState({
      ruleVersion: TV_EMAIL_RULE_VERSION,
      activeClass: null,
      candidate: { rulePath: "invented", presentationClass: "incident", accumulatedMs: 999_999 },
      recovery: { window: "invented", accumulatedMs: 999_999 },
    }, null)).toMatchObject({ candidate: null, recovery: null });
  });

  it("detects TV event tables in a mixed-case tenancy schema", async () => {
    const schema = `TvTest_${randomUUID().replaceAll("-", "")}`;
    await globalPrismaClient.$executeRaw`CREATE SCHEMA ${sqlQuoteIdent(schema)}`;
    try {
      await globalPrismaClient.$executeRaw`CREATE TABLE ${sqlQuoteIdent(schema)}."TvEventOccurrence" ("id" UUID)`;
      await globalPrismaClient.$executeRaw`CREATE TABLE ${sqlQuoteIdent(schema)}."TvEventEvaluatorState" ("id" UUID)`;
      await globalPrismaClient.$executeRaw`CREATE TABLE ${sqlQuoteIdent(schema)}."TvProfileEventPresentation" ("id" UUID)`;

      await expect(tvEventTablesAreReadyForSchema(globalPrismaClient, schema)).resolves.toBe(true);
    } finally {
      await globalPrismaClient.$executeRaw`DROP SCHEMA ${sqlQuoteIdent(schema)} CASCADE`;
    }
  });
});
