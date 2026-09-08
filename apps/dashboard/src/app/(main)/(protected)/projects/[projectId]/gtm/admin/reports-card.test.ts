import { describe, expect, it } from "vitest";
import { getEmptyReportNotice, getGrowthAdminReportActionHref, hasUnsavedReportEdits } from "./reports-card";

describe("hasUnsavedReportEdits", () => {
  const seed = { sourceMdx: "## Reviewed report", dataJson: "[]" };

  it("detects MDX and evidence edits independently", () => {
    expect(hasUnsavedReportEdits(seed, seed)).toBe(false);
    expect(hasUnsavedReportEdits(seed, { ...seed, sourceMdx: `${seed.sourceMdx}\n\nChanged.` })).toBe(true);
    expect(hasUnsavedReportEdits(seed, { ...seed, dataJson: "[{}]" })).toBe(true);
  });
});

describe("getGrowthAdminReportActionHref", () => {
  it("keeps report actions in Growth Admin and scopes them to the selected customer project", () => {
    expect(getGrowthAdminReportActionHref("customer project", "action/id")).toBe(
      "/projects/internal/gtm/admin/actions/action%2Fid?targetProjectId=customer%20project",
    );
  });
});

describe("getEmptyReportNotice", () => {
  it("shows generation progress instead of implying the interview is unfinished", () => {
    expect(getEmptyReportNotice({ state: "running", message: "The report is being generated." })).toMatchInlineSnapshot(`
      {
        "message": "The report is being generated. This page updates automatically when it is ready for review.",
        "variant": "info",
      }
    `);
  });

  it("keeps failed and blocked lifecycle messages visible", () => {
    expect(getEmptyReportNotice({ state: "failed", message: "Report generation failed. Retry this step." })).toEqual({
      variant: "error",
      message: "Report generation failed. Retry this step.",
    });
    expect(getEmptyReportNotice({ state: "blocked", message: "Complete the interview first." })).toEqual({
      variant: "warning",
      message: "Complete the interview first.",
    });
  });
});
