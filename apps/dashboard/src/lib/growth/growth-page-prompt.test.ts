import { describe, expect, it } from "vitest";
import { buildGrowthActionPagePrompt, buildGrowthCategoryPagePrompt, buildGrowthFindingPagePrompt, buildGrowthItemPagePrompt } from "./growth-page-prompt";
import type { GrowthActionItem, GrowthOverviewFinding } from "./growth-types";

const finding: GrowthOverviewFinding = {
  id: "finding-1",
  source: "data-analysis",
  kind: "data-insight",
  category: "conversion",
  tags: ["onboarding"],
  title: "New workspaces stall before the second project",
  body: "41% never create a second project.",
  data: null,
  document: null,
  createdAtMillis: Date.UTC(2026, 7, 1),
};

const action: GrowthActionItem = {
  id: "action-1",
  typeId: "publish_blog",
  category: "conversion",
  tags: ["onboarding"],
  title: "Add a first-session checklist",
  description: "Show a four-step checklist until the first useful loop completes.",
  document: null,
  status: "proposed",
  // The two fields a prompt must never carry: a type-specific payload and a workflow's source.
  payload: { secret_api_key: "sk-should-never-be-pasted" },
  watchedMetrics: [{ metricId: "new_signups", windowDays: 14 }],
  reportId: null,
  briefId: null,
  workflow: {
    workflowId: "workflow-1",
    source: "export default async function handler() { /* never-paste-me */ }",
    triggers: [{ type: "event", eventType: "user.created" }],
    explanation: "Emails new users a checklist link on their first day.",
    rollbackNote: "Deleting the automation stops the emails.",
    status: "not_deployed",
    lastRunState: null,
    warnings: [],
  },
  createdAtMillis: Date.UTC(2026, 7, 2),
  activatedAtMillis: null,
  completedAtMillis: null,
};

describe("growth stage page prompts", () => {
  it("teaches the compiler's format and carries the item's material", () => {
    const prompt = buildGrowthItemPagePrompt({ kind: "finding", category: "conversion", finding });
    expect(prompt).toContain("growth-mdx-v1");
    expect(prompt).toContain("Stage: Conversion");
    expect(prompt).toContain(finding.title);
    expect(prompt).toContain(finding.body);
    expect(prompt).toContain("Recorded: 2026-08-01");
    expect(prompt).toContain('Only <Hypothesis> may take confidence="low|medium|high"');
    expect(prompt).not.toContain("<Hypothesis> and <Experiment> may take confidence");
  });

  it("labels a note as a note rather than a finding", () => {
    const prompt = buildGrowthItemPagePrompt({ kind: "note", category: "reach", finding });
    expect(prompt).toContain("Note id: finding-1");
    expect(prompt).not.toContain("Finding id:");
  });

  it("gives the action id in the exact form the page must reference it by", () => {
    const prompt = buildGrowthItemPagePrompt({ kind: "action", category: "conversion", action });
    expect(prompt).toContain(`<ActionButton action="action-1" />`);
    expect(prompt).toContain("Watched metrics: new_signups over 14 days");
    expect(prompt).toContain("Automation: Emails new users a checklist link on their first day.");
  });

  it("does not ask an action-detail page to render a duplicate action button", () => {
    const prompt = buildGrowthActionPagePrompt(action);
    expect(prompt).toContain("Material — the action this page explains:");
    expect(prompt).toContain("<Finding>...</Finding>");
    expect(prompt).toContain('<Evidence data="id">...</Evidence>');
    expect(prompt).toContain("<Recommendation>...</Recommendation>");
    expect(prompt).toContain("<MeasurementPlan />");
    expect(prompt).toContain("Keep each sentence under 18 words");
    expect(prompt).not.toContain(`<ActionButton action="action-1" />`);
  });

  it("builds an individual evidence-page prompt without action controls", () => {
    const prompt = buildGrowthFindingPagePrompt(finding);
    expect(prompt).toContain("Material — the observation this page explains:");
    expect(prompt).toContain(finding.title);
    expect(prompt).toContain("Do not use <ActionButton>");
  });

  it("never leaks an action payload or workflow source", () => {
    for (const prompt of [
      buildGrowthItemPagePrompt({ kind: "action", category: "conversion", action }),
      buildGrowthCategoryPagePrompt({ category: "conversion", score: 46, findings: [finding], notes: [], actions: [action] }),
    ]) {
      expect(prompt).not.toContain("sk-should-never-be-pasted");
      expect(prompt).not.toContain("never-paste-me");
      expect(prompt).not.toContain("secret_api_key");
    }
  });

  it("includes an existing narrative so a page can build on it", () => {
    const prompt = buildGrowthItemPagePrompt({
      kind: "finding",
      category: "conversion",
      finding: { ...finding, document: { format: "growth-mdx-v1", sourceMdx: "## Already written\n\ntext", blocks: [], data: [] } },
    });
    expect(prompt).toContain("## Already written");
    expect(prompt).toContain("Existing evidence data JSON");
  });

  it("composes a stage prompt from every lane and states the score", () => {
    const prompt = buildGrowthCategoryPagePrompt({
      category: "conversion",
      score: 46,
      findings: [finding],
      notes: [{ ...finding, id: "note-1", title: "A note title" }],
      actions: [action],
    });
    expect(prompt).toContain("current stage score: 46/100");
    expect(prompt).toContain("Observations from analysis:");
    expect(prompt).toContain("Notes:");
    expect(prompt).toContain("A note title");
    expect(prompt).toContain("Suggested actions (only these ids may be used in <ActionButton>):");
  });

  it("says so explicitly when a stage has nothing recorded yet", () => {
    const prompt = buildGrowthCategoryPagePrompt({ category: "revenue", score: null, findings: [], notes: [], actions: [] });
    expect(prompt).toContain("No material has been recorded for this stage yet.");
    expect(prompt).not.toContain("current stage score");
  });
});
