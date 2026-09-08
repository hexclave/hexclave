"use client";

import { DesignAlert, DesignButton } from "@/components/design-components";
import { Link } from "@/components/link";
import { useRouter } from "@/components/router";
import { GrowthApiError, getGrowthReport, markGrowthReportRead } from "@/lib/growth/growth-api";
import { type GrowthLoadable, useGrowthStatus } from "@/lib/growth/growth-data";
import { GROWTH_DEMO_NOW_MILLIS, buildGrowthDemoReport } from "@/lib/growth/growth-demo-data";
import type { GrowthReport, GrowthStatus } from "@/lib/growth/growth-types";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageLayout } from "../../page-layout";
import { useAdminApp, useProjectId } from "../../use-admin-app";
import { GrowthActionCard, useGrowthHref } from "../components/action-card";
import { GrowthAppFrame, GrowthStatusGate } from "../components/frame";
import { GrowthReportHoldPanel } from "../components/report-hold";
import { GrowthReportSections } from "../components/report-sections";
import { GrowthDocumentRenderer } from "../components/growth-document";

export default function PageClient() {
  return (
    <GrowthAppFrame>
      <PageLayout title="Growth Report" description="Your full growth report with recommended actions" allowContentOverflow>
        <GrowthStatusGate>
          {(status) => (
            <ReportBody
              latestReport={status.latestReport}
              // "Your report is being prepared" vs "run an analysis first" — the difference matters,
              // because this page is most likely to be opened during exactly the window where the
              // wrong one of those reads as "nothing is happening".
              //
              // This used to be derived here, from an interview/analysis pair chosen to work around
              // the wire collapsing COMPOSING_REPORT into "completed". It now comes from the server,
              // which is also the only thing that knows whether the report has been released —
              // something no combination of the other fields can tell you.
              held={status.release.state === "preparing"}
            />
          )}
        </GrowthStatusGate>
      </PageLayout>
    </GrowthAppFrame>
  );
}

function ReportEmptyState(props: { held: boolean }) {
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const overviewLink = (
    <Link href={withQuery(`/projects/${projectId}/gtm`)}>
      <DesignButton variant="outline" size="sm">Go to the Growth overview</DesignButton>
    </Link>
  );
  if (props.held) {
    return <GrowthReportHoldPanel>{overviewLink}</GrowthReportHoldPanel>;
  }
  return (
    <div className="rounded-2xl border border-dashed border-foreground/[0.1] bg-foreground/[0.02] p-8 text-center">
      <p className="text-sm font-medium text-foreground">No report yet</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Run an analysis first — your report appears here once the analysis and interview are complete.
      </p>
      <div className="mt-4 flex justify-center">{overviewLink}</div>
    </div>
  );
}

// `value: null` means "no report is readable yet" — either none has been written, or one has been
// written and not yet released to this customer. Both are valid loaded states, not errors, and the
// backend deliberately 404s them identically (see getGrowthReportBody's publishedOnly option).
function ReportBody(props: { latestReport: GrowthStatus["latestReport"], held: boolean }) {
  const app = useAdminApp();
  const router = useRouter();
  const projectId = useProjectId();
  const withQuery = useGrowthHref();
  const { demo, refresh: refreshStatus } = useGrowthStatus();
  const [data, setData] = useState<GrowthLoadable<GrowthReport | null>>({ status: "loading" });
  const [readReceiptError, setReadReceiptError] = useState<string | null>(null);
  const markReadPromiseRef = useRef<{ reportId: string, promise: Promise<void> } | null>(null);
  const hasReport = props.latestReport != null;

  const load = useCallback(async () => {
    if (demo) {
      setData({ status: "loaded", value: hasReport ? buildGrowthDemoReport(GROWTH_DEMO_NOW_MILLIS) : null });
      return;
    }
    try {
      setData({ status: "loaded", value: await getGrowthReport(app, "latest") });
    } catch (error) {
      // "latest" 404s until the first report is composed — that's the empty state, not a failure.
      if (error instanceof GrowthApiError && error.statusCode === 404) {
        setData({ status: "loaded", value: null });
        return;
      }
      captureError("growth-report-load", error);
      setData({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [app, demo, hasReport]);

  useEffect(() => {
    setData({ status: "loading" });
    runAsynchronously(load());
  }, [load]);

  const reportId = data.status === "loaded" ? data.value?.id ?? null : null;
  const shouldMarkRead = !demo
    && reportId != null
    && props.latestReport?.id === reportId
    && props.latestReport.readAtMillis == null;
  const ensureReportRead = useCallback(async (targetReportId: string) => {
    if (demo || props.latestReport?.readAtMillis != null) return;
    const existing = markReadPromiseRef.current;
    if (existing?.reportId === targetReportId) {
      await existing.promise;
      return;
    }
    const promise = (async () => {
      await markGrowthReportRead(app, targetReportId);
      await refreshStatus();
    })();
    markReadPromiseRef.current = { reportId: targetReportId, promise };
    try {
      await promise;
    } finally {
      markReadPromiseRef.current = null;
    }
  }, [app, demo, props.latestReport?.readAtMillis, refreshStatus]);
  useEffect(() => {
    if (!shouldMarkRead) return;
    // The receipt only controls a reminder on the overview. Never delay the report itself for this
    // cosmetic write; capture a failure so it is diagnosable, and leave the reminder visible.
    runAsynchronously(async () => {
      try {
        await ensureReportRead(reportId);
      } catch (error) {
        captureError("growth-report-mark-read", error);
      }
    });
  }, [ensureReportRead, reportId, shouldMarkRead]);

  if (data.status === "loading") {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading growth report">
        <div className="h-40 animate-pulse rounded-2xl border border-foreground/[0.06] bg-foreground/[0.03]" />
        <div className="h-32 animate-pulse rounded-2xl border border-foreground/[0.06] bg-foreground/[0.03]" />
        <div className="h-32 animate-pulse rounded-2xl border border-foreground/[0.06] bg-foreground/[0.03]" />
      </div>
    );
  }
  if (data.status === "error") {
    return (
      <DesignAlert variant="error" className="items-center">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>Could not load your growth report: {data.message}</span>
          <DesignButton variant="outline" size="sm" onClick={async () => {
            setData({ status: "loading" });
            await load();
          }}>
            Retry
          </DesignButton>
        </div>
      </DesignAlert>
    );
  }
  if (data.value == null) {
    return <ReportEmptyState held={props.held} />;
  }
  const report = data.value;
  return (
    <ReportContent
      report={report}
      readReceiptError={readReceiptError}
      onViewDashboard={async () => {
        setReadReceiptError(null);
        try {
          await ensureReportRead(report.id);
        } catch (error) {
          captureError("growth-report-mark-read", error);
          setReadReceiptError("We couldn't open your dashboard yet. Please try again.");
          return;
        }
        router.push(withQuery(`/projects/${projectId}/gtm`));
      }}
    />
  );
}

function ReportContent(props: { report: GrowthReport, readReceiptError: string | null, onViewDashboard: () => Promise<void> }) {
  const { report } = props;
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8">
      <header className="border-b border-foreground/[0.08] pb-7">
        <p className="text-xs text-muted-foreground">Created {new Date(report.createdAtMillis).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}</p>
        <h1 className="mt-2 max-w-4xl text-balance text-2xl font-semibold tracking-tight sm:text-3xl">{report.title}</h1>
        <p className="mt-3 max-w-3xl text-pretty text-sm leading-6 text-muted-foreground sm:text-base">{report.summary}</p>
      </header>

      {report.document == null ? <GrowthReportSections report={report} /> : <GrowthDocumentRenderer document={report.document} className="mx-0 max-w-none" />}

      {report.actionItems.length > 0 && (
        <section className="border-t border-foreground/[0.08] pt-8">
          <h2 className="text-xl font-semibold tracking-tight">Recommended actions</h2>
          <p className="mt-1 text-sm text-muted-foreground">Review the evidence and expected measurement window before activating anything.</p>
          <div className="mt-4 flex flex-col gap-3">
            {report.actionItems.map((action) => <GrowthActionCard key={action.id} action={action} />)}
          </div>
        </section>
      )}

      <section className="flex flex-col gap-4 border-t border-foreground/[0.08] pt-8 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Continue to your Growth dashboard</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Explore each growth stage and manage the actions from this report.</p>
          {props.readReceiptError != null && <p className="mt-2 text-sm text-destructive">{props.readReceiptError}</p>}
        </div>
        <DesignButton onClick={props.onViewDashboard}>
          <span className="flex items-center gap-2">View dashboard<ArrowRightIcon className="size-4" /></span>
        </DesignButton>
      </section>
    </div>
  );
}
