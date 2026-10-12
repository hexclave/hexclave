import { describe, expect, it } from "vitest";
import { isIndependentTvDisplayPath, isTvPresentationPath } from "./routes";

describe("independent TV display route matching", () => {
  it("matches only the exact independent display route", () => {
    expect(isIndependentTvDisplayPath("/tv")).toBe(true);
    expect(isIndependentTvDisplayPath("/tv/")).toBe(true);
    expect(isIndependentTvDisplayPath("/tv/pairing")).toBe(false);
    expect(isIndependentTvDisplayPath("/projects/project-a/tv-mode")).toBe(false);
  });
});

describe("TV presentation route matching", () => {
  it("matches only a project presentation route", () => {
    expect(isTvPresentationPath("/projects/project-a/tv-mode/present/company-pulse")).toBe(true);
    expect(isTvPresentationPath("/projects/project-a/tv-mode/present/company-pulse/")).toBe(true);
    expect(isTvPresentationPath("/projects/project-a/tv-mode")).toBe(false);
    expect(isTvPresentationPath("/tv")).toBe(false);
  });
});
