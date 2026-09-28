import { describe, expect, it } from "vitest";
import { getTvSourceHealthVisual, getTvSourceStatePresentation } from "./screen-registry";

describe("TV source-health visual semantics", () => {
  it.each([
    ["healthy", "check", "text-emerald-300/80"],
    ["ready", "info", "text-cyan-200/70"],
    ["empty", "info", "text-white/40"],
    ["insufficient-data", "info", "text-white/55"],
    ["unavailable", "info", "text-white/35"],
    ["error", "warning", "text-rose-300/80"],
    ["stale", "warning", "text-amber-300/80"],
  ] as const)("uses the expected %s visual", (status, icon, className) => {
    expect(getTvSourceHealthVisual(status)).toEqual({ icon, className });
  });
});

describe("TV source-state presentation policy", () => {
  it("renders data-bearing states through the screen content", () => {
    expect([
      getTvSourceStatePresentation("ready"),
      getTvSourceStatePresentation("insufficient-data"),
      getTvSourceStatePresentation("stale"),
    ]).toEqual([
      { type: "content" },
      { type: "content" },
      { type: "content" },
    ]);
  });

  it("owns the shared terminal-state copy", () => {
    expect([
      getTvSourceStatePresentation("empty"),
      getTvSourceStatePresentation("unavailable"),
      getTvSourceStatePresentation("error"),
    ]).toMatchInlineSnapshot(`
      [
        {
          "detail": "This screen will update automatically when activity arrives.",
          "eyebrow": "Waiting for Activity",
          "message": "No qualifying activity yet.",
          "status": "empty",
          "type": "terminal",
        },
        {
          "detail": "Connect the required app to show this screen.",
          "eyebrow": "Source Unavailable",
          "message": "This data source isn’t connected yet.",
          "status": "unavailable",
          "type": "terminal",
        },
        {
          "detail": "TV Mode will retry automatically while the rest of the presentation continues.",
          "eyebrow": "Data Temporarily Unavailable",
          "message": "We couldn’t refresh this data right now.",
          "status": "error",
          "type": "terminal",
        },
      ]
    `);
  });
});
