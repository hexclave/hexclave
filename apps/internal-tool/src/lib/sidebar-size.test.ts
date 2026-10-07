import { describe, expect, it } from "vitest";
import {
  DEFAULT_DETAIL_SIDEBAR_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_DETAIL_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_DETAIL_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  normalizeDetailSidebarWidth,
  normalizeSidebarWidth,
} from "./sidebar-size";

describe("navigation sidebar sizing", () => {
  it("keeps widths inside the usable desktop range", () => {
    expect(normalizeSidebarWidth(MIN_SIDEBAR_WIDTH - 100)).toBe(MIN_SIDEBAR_WIDTH);
    expect(normalizeSidebarWidth(286.6)).toBe(287);
    expect(normalizeSidebarWidth(MAX_SIDEBAR_WIDTH + 100)).toBe(MAX_SIDEBAR_WIDTH);
  });

  it("uses the default for invalid persisted values", () => {
    expect(normalizeSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(normalizeSidebarWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});

describe("detail sidebar sizing", () => {
  it("keeps widths inside the usable desktop range", () => {
    expect(normalizeDetailSidebarWidth(MIN_DETAIL_SIDEBAR_WIDTH - 200)).toBe(MIN_DETAIL_SIDEBAR_WIDTH);
    expect(normalizeDetailSidebarWidth(612.4)).toBe(612);
    expect(normalizeDetailSidebarWidth(MAX_DETAIL_SIDEBAR_WIDTH + 200)).toBe(MAX_DETAIL_SIDEBAR_WIDTH);
  });

  it("uses the default for invalid persisted values", () => {
    expect(normalizeDetailSidebarWidth(Number.NaN)).toBe(DEFAULT_DETAIL_SIDEBAR_WIDTH);
    expect(normalizeDetailSidebarWidth(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_DETAIL_SIDEBAR_WIDTH);
  });

  it("has a default that sits inside its own bounds", () => {
    expect(normalizeDetailSidebarWidth(DEFAULT_DETAIL_SIDEBAR_WIDTH)).toBe(DEFAULT_DETAIL_SIDEBAR_WIDTH);
    expect(normalizeSidebarWidth(DEFAULT_SIDEBAR_WIDTH)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});
