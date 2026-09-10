import { describe, expect, it } from "vitest";
import { formatPacificTableTime, formatPacificTimestamp } from "./pacific-time";

describe("Pacific time formatting", () => {
  it("uses PDT during daylight-saving time", () => {
    const date = new Date("2026-09-08T01:29:40.000Z");

    expect(formatPacificTableTime(date)).toBe("Sep 7, 6:29 PM PDT");
    expect(formatPacificTimestamp(date)).toBe("September 7, 2026 at 6:29:40 PM PDT");
  });

  it("uses PST during standard time", () => {
    const date = new Date("2026-01-08T02:29:40.000Z");

    expect(formatPacificTableTime(date)).toBe("Jan 7, 6:29 PM PST");
  });
});
