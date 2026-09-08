"use client";

import { DesignAlert, DesignBadge, DesignButton, DesignCard } from "@/components/design-components";
import { cn } from "@/components/ui";
import type { GrowthAdminStageRunState } from "@/lib/growth/growth-api";
import { formatGrowthRelativeTime } from "@/lib/growth/growth-format";
import { parseGrowthPageResponse } from "@/lib/growth/growth-page-response";
import {
  getGrowthAdminReport,
  getGrowthAdminReports,
  publishGrowthAdminReport,
  saveGrowthAdminReportDocument,
  unpublishGrowthAdminReport,
  type GrowthAdminReportDetail,
  type GrowthAdminReportsBody,
  type GrowthAdminReportSummary,
} from "@/lib/growth/reports/growth-reports-admin-api";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { FileTextIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { GrowthActionCard } from "../components/action-card";
import { GrowthDocumentRenderer } from "../components/growth-document";
import { GrowthReportSections } from "../components/report-sections";


type ListState =
  | { status: "loading" }
  | { status: "error", message: string }
  | { status: "loaded", body: GrowthAdminReportsBody };

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error", message: string }
  | { status: "loaded", report: GrowthAdminReportDetail };

type EmptyReportNotice = {
  readonly variant: "info" | "warning" | "error",
  readonly message: string,
};

export function getEmptyReportNotice(operation: Pick<GrowthAdminStageRunState, "state" | "message">): EmptyReportNotice {
  if (operation.state === "running") {
    return { variant: "info", message: "The report is being generated. This page updates automatically when it is ready for review." };
  }
  if (operation.state === "failed") {
    return { variant: "error", message: operation.message };
  }
  if (operation.state === "blocked") {
    return { variant: "warning", message: operation.message };
  }
  if (operation.state === "ready") {
    return { variant: "info", message: "The interview is complete and the report is ready to generate. Use Run this step now above." };
  }
  return { variant: "warning", message: "Report generation finished, but no report is available yet. Refresh this page; if it remains empty, run project recovery from Growth Admin." };
}

function ReportRow(props: {
  report: GrowthAdminReportSummary,
  selected: boolean,
  nowMillis: number,
  onSelect: () => void,
}) {
  const { report } = props;
  const held = report.publishedAtMillis == null;
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "w-full rounded-xl border px-3 py-2 text-left transition-colors hover:transition-none",
        props.selected ? "border-foreground/25 bg-foreground/[0.04]" : "border-foreground/[0.09] hover:bg-foreground/[0.02]",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <DesignBadge label={held ? "awaiting release" : "live"} color={held ? "orange" : "green"} size="sm" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{report.title}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{report.trigger}</span>
      </div>
      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{report.summary}</p>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        written {formatGrowthRelativeTime(report.createdAtMillis, props.nowMillis)}
        {" · "}{report.actionItemCount} {report.actionItemCount === 1 ? "action" : "actions"}
        {report.publishedAtMillis != null && <> · published {formatGrowthRelativeTime(report.publishedAtMillis, props.nowMillis)}</>}
      </p>
    </button>
  );
}

export function getGrowthAdminReportActionHref(projectId: string, actionId: string): string {
  return urlString`/projects/internal/gtm/admin/actions/${actionId}?targetProjectId=${projectId}`;
}

/** The report exactly as the customer would read it, with staff navigation kept inside Growth Admin. */
function ReportPreview(props: { report: GrowthAdminReportDetail, projectId: string }) {
  const { report } = props;
  return (
    <div className="rounded-xl border border-foreground/[0.09] p-4">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <header>
          <h3 className="text-lg font-semibold tracking-tight">{report.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{report.summary}</p>
        </header>
        {report.document == null ? <GrowthReportSections report={report} /> : <GrowthDocumentRenderer document={report.document} className="mx-0 max-w-none" />}
        {report.actionItems.length > 0 && (
          <section className="border-t border-foreground/[0.09] pt-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Recommended actions · {report.actionItems.length}
            </p>
            <div className="mt-3 flex flex-col gap-3">
              {report.actionItems.map((action) => (
                <GrowthActionCard
                  key={action.id}
                  action={action}
                  href={getGrowthAdminReportActionHref(props.projectId, action.id)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

type ReportEditorSeed = { sourceMdx: string, dataJson: string };

export function hasUnsavedReportEdits(seed: ReportEditorSeed, current: ReportEditorSeed): boolean {
  return seed.sourceMdx !== current.sourceMdx || seed.dataJson !== current.dataJson;
}

function reportEditorSeed(report: GrowthAdminReportDetail): ReportEditorSeed {
  return {
    // Legacy reports predate growth-mdx-v1 but their Markdown is valid editor input. Saving one
    // upgrades only its rendered document; the legacy columns remain as historical fallback data.
    sourceMdx: report.document?.sourceMdx ?? report.contentMd,
    dataJson: JSON.stringify(report.document?.data ?? [], null, 2),
  };
}

function ReportEditor(props: {
  app: object,
  projectId: string,
  report: GrowthAdminReportDetail,
  published: boolean,
  onSaved: (report: GrowthAdminReportDetail) => void,
}) {
  const initial = reportEditorSeed(props.report);
  const [seed, setSeed] = useState(initial);
  const [sourceMdx, setSourceMdx] = useState(initial.sourceMdx);
  const [dataJson, setDataJson] = useState(initial.dataJson);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = hasUnsavedReportEdits(seed, { sourceMdx, dataJson });

  const save = async () => {
    setError(null);
    setSaving(true);
    const result = await Result.fromThrowingAsync(async () => {
      const parsed = parseGrowthPageResponse(sourceMdx);
      const savedMdx = parsed?.sourceMdx ?? sourceMdx;
      const savedDataJson = parsed?.evidenceDataJson ?? dataJson;
      const data: unknown = JSON.parse(savedDataJson);
      if (!Array.isArray(data)) throw new Error("Evidence data must be a JSON array.");
      const report = await saveGrowthAdminReportDocument(props.app, props.projectId, props.report.id, { sourceMdx: savedMdx, data });
      return { report, seed: { sourceMdx: savedMdx, dataJson: savedDataJson } };
    });
    setSaving(false);
    if (result.status === "error") {
      captureError("growth-admin-report-save", result.error);
      setError(result.error instanceof Error ? result.error.message : String(result.error));
      return;
    }
    setSourceMdx(result.data.seed.sourceMdx);
    setDataJson(result.data.seed.dataJson);
    setSeed(result.data.seed);
    props.onSaved(result.data.report);
  };

  return (
    <div className="space-y-3 rounded-xl border border-dashed border-foreground/[0.16] bg-foreground/[0.02] p-4">
      <div>
        <h4 className="text-sm font-semibold tracking-tight">Report source</h4>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Edit the customer-facing report as growth-mdx-v1. Paste a complete fenced MDX and JSON response into the source field to separate it automatically when saving.
        </p>
      </div>
      {error != null && <DesignAlert variant="error">{error}</DesignAlert>}
      <label className="block text-xs font-medium">
        Report source (growth-mdx-v1)
        <textarea
          className="mt-1 min-h-64 w-full rounded-xl border bg-background p-3 font-mono text-xs"
          value={sourceMdx}
          disabled={saving}
          onChange={(event) => setSourceMdx(event.target.value)}
        />
      </label>
      <label className="block text-xs font-medium">
        Evidence data JSON
        <textarea
          className="mt-1 min-h-32 w-full rounded-xl border bg-background p-3 font-mono text-xs"
          value={dataJson}
          disabled={saving}
          onChange={(event) => setDataJson(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <DesignButton
          size="sm"
          disabled={saving || !dirty || sourceMdx.trim().length === 0}
          onClick={save}
        >
          {props.published ? "Update report" : "Save report"}
        </DesignButton>
        <span className="text-xs text-muted-foreground">
          {dirty ? "Unsaved changes" : "Saved source matches the preview"}
        </span>
      </div>
    </div>
  );
}

export function GrowthAdminReportsCard(props: { app: object, projectId: string, operation: GrowthAdminStageRunState }) {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Pinned once per mount rather than read during render, so the relative timestamps do not shift.
  const [nowMillis] = useState(() => Date.now());

  const load = useCallback(async () => {
    setList({ status: "loading" });
    try {
      setList({ status: "loaded", body: await getGrowthAdminReports(props.app, props.projectId) });
    } catch (error) {
      captureError("growth-admin-reports-load", error);
      setList({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [props.app, props.projectId]);

  useEffect(() => {
    // Selection is per-project: switching the target project in the page's dropdown must not leave
    // another project's report open underneath the new list.
    setSelectedId(null);
    setDetail({ status: "idle" });
  }, [props.projectId]);

  useEffect(() => {
    // The parent polls the lifecycle operation while generation runs. Reloading when its state
    // changes makes the completed report appear without requiring an admin to refresh manually.
    runAsynchronously(load());
  }, [load, props.operation.state]);

  const openReport = useCallback(async (reportId: string) => {
    setSelectedId(reportId);
    setDetail({ status: "loading" });
    try {
      setDetail({ status: "loaded", report: await getGrowthAdminReport(props.app, props.projectId, reportId) });
    } catch (error) {
      captureError("growth-admin-reports-detail", error);
      setDetail({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [props.app, props.projectId]);

  /**
   * Errors surface inline rather than being thrown: the realistic one here is the 409 for
   * unpublishing something already unpublished (two staff tabs open on the same project), which is
   * information, not a crash.
   */
  const mutate = async (label: string, mutation: () => Promise<GrowthAdminReportsBody>) => {
    setActionError(null);
    setBusy(true);
    try {
      setList({ status: "loaded", body: await mutation() });
    } catch (error) {
      captureError(label, error);
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const subtitle = "Review the generated report, then release it to open the customer's Growth workspace";

  if (list.status === "loading") {
    return (
      <DesignCard title="Reports" subtitle={subtitle} icon={FileTextIcon} gradient="blue">
        <div className="h-20 animate-pulse rounded-xl border border-foreground/[0.06] bg-foreground/[0.03]" aria-busy="true" aria-label="Loading growth reports" />
      </DesignCard>
    );
  }
  if (list.status === "error") {
    return (
      <DesignCard title="Reports" subtitle={subtitle} icon={FileTextIcon} gradient="blue">
        <DesignAlert variant="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Could not load reports: {list.message}</span>
            <DesignButton variant="outline" size="sm" onClick={async () => await load()}>Retry</DesignButton>
          </div>
        </DesignAlert>
      </DesignCard>
    );
  }

  const { reports } = list.body;
  const selected = reports.find((report) => report.id === selectedId) ?? null;
  const emptyNotice = getEmptyReportNotice(props.operation);

  return (
    <DesignCard title="Reports" subtitle={subtitle} icon={FileTextIcon} gradient="blue">
      <div className="space-y-4">
        {actionError != null && <DesignAlert variant="error">{actionError}</DesignAlert>}

        {reports.length === 0 ? <DesignAlert variant={emptyNotice.variant}>{emptyNotice.message}</DesignAlert> : (
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              {reports.length} {reports.length === 1 ? "report" : "reports"} · newest first
            </p>
            {reports.map((report) => (
              <ReportRow
                key={report.id}
                report={report}
                selected={report.id === selectedId}
                nowMillis={nowMillis}
                onSelect={() => runAsynchronously(openReport(report.id))}
              />
            ))}
          </div>
        )}

        {selected != null && (
          <div className="space-y-3 border-t border-foreground/[0.09] pt-4">
            <div className="flex flex-wrap items-center gap-2">
              {selected.publishedAtMillis == null ? (
                <>
                  <DesignButton
                    size="sm"
                    disabled={busy || detail.status !== "loaded"}
                    onClick={async () => await mutate("growth-admin-reports-publish", () => publishGrowthAdminReport(props.app, props.projectId, selected.id))}
                  >
                    Release report to customer
                  </DesignButton>
                  <span className="text-xs text-muted-foreground">
                    The customer continues to see onboarding progress until this report is released.
                  </span>
                </>
              ) : (
                <>
                  {/* Retracting a report the customer may already have read is a real act, not a
                    * toggle — it exists for the analysis that went badly wrong, so it is styled as
                    * the secondary, deliberate choice. */}
                  <DesignButton
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={async () => await mutate("growth-admin-reports-unpublish", () => unpublishGrowthAdminReport(props.app, props.projectId, selected.id))}
                  >
                    Unpublish
                  </DesignButton>
                  <span className="text-xs text-muted-foreground">
                    Live since {formatGrowthRelativeTime(selected.publishedAtMillis, nowMillis)}
                    {selected.publishedByUserId != null && <> · published by {selected.publishedByUserId}</>}
                  </span>
                </>
              )}
            </div>

            {detail.status === "loading" && (
              <div className="h-40 animate-pulse rounded-xl border border-foreground/[0.06] bg-foreground/[0.03]" aria-busy="true" aria-label="Loading the report" />
            )}
            {detail.status === "error" && (
              <DesignAlert variant="error">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>Could not load this report: {detail.message}</span>
                  <DesignButton variant="outline" size="sm" onClick={async () => await openReport(selected.id)}>Retry</DesignButton>
                </div>
              </DesignAlert>
            )}
            {detail.status === "loaded" && (
              <div className="space-y-3">
                <ReportEditor
                  key={detail.report.id}
                  app={props.app}
                  projectId={props.projectId}
                  report={detail.report}
                  published={selected.publishedAtMillis != null}
                  onSaved={(report) => setDetail({ status: "loaded", report })}
                />
                <ReportPreview report={detail.report} projectId={props.projectId} />
              </div>
            )}
          </div>
        )}
      </div>
    </DesignCard>
  );
}
