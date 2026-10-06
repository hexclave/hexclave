"use client";

import { Link } from "@/components/link";
import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignMenu,
  DesignPillToggle,
} from "@/components/design-components";
import { cn } from "@/lib/utils";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ChartLineIcon,
  LinkIcon,
  ListDashesIcon,
  SpinnerGapIcon,
} from "@phosphor-icons/react";
import { useRouter } from "@/components/router";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { AppEnabledGuard } from "../../../app-enabled-guard";
import { PageLayout } from "../../../page-layout";
import { StickyPageHeader } from "../../../sticky-page-header";
import { useAdminApp } from "../../../use-admin-app";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import { queryObservability } from "../../filters";
import {
  formatAbsoluteTimeFromMillis,
  formatDateFromMillis,
  formatRelativeTimeFromMillis,
  getErrorMessage,
} from "../../format";
import { LogLevelChip } from "../../log-level";
import {
  CORRELATION_ANCHOR_LABELS,
  getLeadingUpToLogsQuery,
  parseLeadingUpToLogRows,
  resolveCorrelationAnchor,
  type LeadingUpToLogLine,
} from "../correlation";
import { formatIssueCount, issueCulprit, issueShortIdLabel, issueSubtitle, issueTitle, parseIssueCulpritData, parseIssueRouteId } from "../issue-format";
import { parseIssueRangeHours } from "../issue-filters";
import { issueDetailHref, issuesListHref, traceDetailHref } from "../issue-links";
import { sessionReplayHref } from "../../observability-links";
import { issueStatusBadge, nextStatusForAction, primaryIssueStatusAction } from "../issue-status";
import {
  fetchIssueDetail,
  addIssueComment,
  ISSUE_SNOOZE_PRESETS,
  regressIssue,
  setIssueAssignee,
  setIssueBookmarkState,
  clearManualIssueOwnerState,
  setIssueOwnerState,
  setIssueSubscriptionState,
  setIssueTeam,
  snoozeIssue,
  unmergeIssue,
  unsnoozeIssue,
  updateIssuePriority,
  updateIssueAssignment,
  updateIssueBookmark,
  updateIssueOwner,
  clearManualIssueOwners,
  updateIssueSubscription,
  updateIssueStatus,
  updateIssueTeam,
  type IssueDetailResponse,
  type IssueOccurrenceDirection,
  type IssuePriority,
  type IssueStatus,
} from "../issues-data";
import { StackFrameList } from "../stack-frame-list";
import { DEFAULT_STACK_FRAME_ORDER, type StackFrameOrder } from "../stack-frames";
import { IssueEventSections, IssueExceptionCauses, IssueProductSection } from "../issue-event-sections";
import { IssueLeadingUpTo } from "../issue-leading-up-to";
import { heroStack } from "../issue-event";

const FRAME_ORDER_OPTIONS = [
  { id: "innermost-first", label: "Newest first" },
  { id: "outermost-first", label: "Oldest first" },
];

function parseFrameOrder(id: string): StackFrameOrder {
  if (id === "innermost-first" || id === "outermost-first") return id;
  throw new Error(`Unknown stack frame order: ${id}`);
}

function StatCell({ label, value, hint }: { label: string, value: string, hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="truncate text-sm tabular-nums text-foreground" title={hint}>{value}</div>
    </div>
  );
}

function RailRow({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-xs">{children}</span>
    </div>
  );
}

function EmptyRailValue() {
  return <span className="text-muted-foreground/50">—</span>;
}

function OccurrenceUserLink({ userId }: { userId: string }) {
  const adminApp = useAdminApp();
  const user = adminApp.useUser(userId);
  if (user === null) {
    return <span title={userId}>Deleted user</span>;
  }

  const label = user.displayName ?? user.primaryEmail ?? "Unnamed user";
  return (
    <Link
      className="block max-w-48 truncate text-xs hover:underline"
      href={`/projects/${encodeURIComponent(adminApp.projectId)}/users/${encodeURIComponent(user.id)}`}
      title={`${label} (${user.id})`}
    >
      {label}
    </Link>
  );
}

function OccurrenceUserFallback({ userId }: { userId: string }) {
  return <span className="font-mono text-xs" title={userId}>{userId.slice(0, 12)}…</span>;
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const router = useRouter();
  const dashboardUser = useDashboardInternalUser();
  const project = adminApp.useProject();
  const userTeams = dashboardUser.useTeams();
  const ownerTeam = useMemo(
    () => userTeams.find((team) => team.id === project.ownerTeamId) ?? throwErr(`Owner team for project "${project.id}" was not found in the current user's teams.`),
    [project.id, project.ownerTeamId, userTeams],
  );
  const teamMembers = ownerTeam.useUsers();
  const assigneeOptions = useMemo(
    () => teamMembers.map((user) => {
      const displayName = user.teamProfile.displayName;
      return {
        id: user.id,
        label: displayName != null && displayName.trim() !== "" ? displayName : user.id,
      };
    }),
    [teamMembers],
  );
  const params = useParams<{ issueId: string }>();
  const projectId = adminApp.projectId;
  const rawIssueId = params.issueId;
  const routeId = useMemo(() => parseIssueRouteId(rawIssueId), [rawIssueId]);
  const searchParams = useSearchParams();
  const rangeHours = parseIssueRangeHours(searchParams);

  const [detail, setDetail] = useState<IssueDetailResponse | null>(null);
  const [occurrenceStepState, setOccurrenceStepState] = useState<{
    routeKey: string,
    cursor: string,
    direction: IssueOccurrenceDirection,
  } | null>(null);
  const occurrenceStep = occurrenceStepState != null && occurrenceStepState.routeKey === rawIssueId
    ? occurrenceStepState
    : null;
  const setOccurrenceStep = useCallback((step: { cursor: string, direction: IssueOccurrenceDirection } | null) => {
    setOccurrenceStepState(step == null ? null : { routeKey: rawIssueId, ...step });
  }, [rawIssueId]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const [productError, setProductError] = useState<string | null>(null);
  const [productSaving, setProductSaving] = useState(false);
  const [frameOrder, setFrameOrder] = useState<StackFrameOrder>(DEFAULT_STACK_FRAME_ORDER);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const [leadingUpTo, setLeadingUpTo] = useState<LeadingUpToLogLine[] | null>(null);
  const [leadingUpToError, setLeadingUpToError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (routeId == null) {
      setLoading(false);
      return () => {};
    }
    let cancelled = false;
    setLoading(true);
    runAsynchronously(async () => {
      try {
        const next = await fetchIssueDetail(
          adminApp,
          routeId.value,
          {
            hours: rangeHours,
            ...occurrenceStep == null ? {} : { occurrence: occurrenceStep.cursor, direction: occurrenceStep.direction },
          },
        );
        if (cancelled) return;
        setDetail(next);
        setError(null);
        setNowMs(Date.now());
        if (next.redirected_from_issue_id != null) {
          router.replace(issueDetailHref(projectId, next.issue.id, { rangeHours }));
        }
      } catch (caught) {
        if (cancelled) return;
        setError(getErrorMessage(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [adminApp, routeId, occurrenceStep, rangeHours, router, projectId]);

  useEffect(() => load(), [load]);

  const issue = detail?.issue ?? null;
  const occurrence = detail?.occurrence ?? null;
  const stack = occurrence == null ? null : heroStack(occurrence);
  const anchor = useMemo(
    () => (occurrence == null ? null : resolveCorrelationAnchor(occurrence)),
    [occurrence],
  );

  useEffect(() => {
    if (anchor == null || occurrence == null) {
      setLeadingUpTo([]);
      setLeadingUpToError(null);
      return;
    }
    let cancelled = false;
    setLeadingUpTo(null);
    runAsynchronously(async () => {
      try {
        const { query, params: queryParams } = getLeadingUpToLogsQuery(anchor, occurrence.event_at_millis);
        const response = await queryObservability(adminApp, { query, params: queryParams });
        if (cancelled) return;
        setLeadingUpTo(parseLeadingUpToLogRows(response.result).reverse());
        setLeadingUpToError(null);
      } catch (caught) {
        if (cancelled) return;
        setLeadingUpToError(getErrorMessage(caught));
        setLeadingUpTo([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [adminApp, anchor, occurrence]);

  // Shared shape for all optimistic issue mutations: snapshot the current
  // detail, apply the optimistic patch, run the API call, roll back + surface
  // the error on failure. `apply` receives the pre-mutation detail so it can
  // reconcile the server response on top of it.
  const runOptimisticIssueUpdate = useCallback(async (opts: {
    blocked: boolean,
    setError: (error: string | null) => void,
    setSaving?: (saving: boolean) => void,
    optimistic?: (detail: IssueDetailResponse) => IssueDetailResponse,
    apply: (detail: IssueDetailResponse) => Promise<unknown>,
  }): Promise<void> => {
    if (detail == null || opts.blocked) return;
    const previous = detail;
    opts.setError(null);
    if (opts.setSaving != null) opts.setSaving(true);
    if (opts.optimistic != null) setDetail(opts.optimistic(detail));
    try {
      await opts.apply(detail);
    } catch (caught) {
      setDetail(previous);
      opts.setError(getErrorMessage(caught));
    } finally {
      if (opts.setSaving != null) opts.setSaving(false);
    }
  }, [detail]);

  const changeStatus = useCallback(async (status: IssueStatus) => {
    await runOptimisticIssueUpdate({
      blocked: statusSaving,
      setError: setStatusError,
      setSaving: setStatusSaving,
      optimistic: (current) => ({ ...current, issue: { ...current.issue, status } }),
      apply: (current) => updateIssueStatus(adminApp, current.issue.id, status),
    });
  }, [adminApp, runOptimisticIssueUpdate, statusSaving]);

  const changeSnooze = useCallback(async (durationMs: number) => {
    await runOptimisticIssueUpdate({
      blocked: statusSaving,
      setError: setStatusError,
      setSaving: setStatusSaving,
      optimistic: (current) => ({ ...current, issue: { ...current.issue, status: "ignored" } }),
      apply: async (current) => {
        const result = await snoozeIssue(adminApp, current.issue.id, Date.now() + durationMs);
        const status = result.status;
        if (status != null) {
          setDetail((current) => current == null ? current : { ...current, issue: { ...current.issue, status } });
        }
      },
    });
  }, [adminApp, runOptimisticIssueUpdate, statusSaving]);

  const changeUnsnooze = useCallback(async () => {
    await runOptimisticIssueUpdate({
      blocked: statusSaving,
      setError: setStatusError,
      setSaving: setStatusSaving,
      optimistic: (current) => ({ ...current, issue: { ...current.issue, status: "unresolved" } }),
      apply: async (current) => {
        const result = await unsnoozeIssue(adminApp, current.issue.id);
        const status = result.status;
        if (status != null) {
          setDetail((current) => current == null ? current : { ...current, issue: { ...current.issue, status } });
        }
      },
    });
  }, [adminApp, runOptimisticIssueUpdate, statusSaving]);

  const changeRegress = useCallback(async () => {
    await runOptimisticIssueUpdate({
      blocked: statusSaving,
      setError: setStatusError,
      setSaving: setStatusSaving,
      optimistic: (current) => ({ ...current, issue: { ...current.issue, status: "unresolved", substatus: "regressed" } }),
      apply: async (current) => {
        const result = await regressIssue(adminApp, current.issue.id);
        const status = result.status;
        if (status != null) {
          setDetail((current) => current == null ? current : {
            ...current,
            issue: {
              ...current.issue,
              status,
              substatus: result.transition_kind === "regressed" ? "regressed" : current.issue.substatus,
            },
          });
        }
      },
    });
  }, [adminApp, runOptimisticIssueUpdate, statusSaving]);

  const changePriority = useCallback(async (priority: IssuePriority | null) => {
    if (detail == null) return;
    const previous = detail.product.priority;
    setProductError(null);
    setDetail({ ...detail, product: { ...detail.product, priority } });
    try {
      await updateIssuePriority(adminApp, detail.issue.id, priority);
    } catch (caught) {
      setDetail({ ...detail, product: { ...detail.product, priority: previous } });
      setProductError(getErrorMessage(caught));
    }
  }, [adminApp, detail]);

  const createComment = useCallback(async (body: string) => {
    if (detail == null) return;
    const result = await addIssueComment(adminApp, detail.issue.id, body, `dashboard-comment-${crypto.randomUUID()}`);
    const createdAt = new Date(result.created_at_millis).toISOString();
    setDetail((current) => current == null ? current : {
      ...current,
      product: {
        ...current.product,
        comments: [{
          id: result.id,
          author_user_id: result.author_user_id,
          body: result.body,
          idempotency_key: result.idempotency_key,
          created_at: createdAt,
          updated_at: createdAt,
        }, ...current.product.comments].slice(0, 100),
      },
    });
  }, [adminApp, detail]);

  const changeAssignment = useCallback(async (assigneeUserId: string | null) => {
    await runOptimisticIssueUpdate({
      blocked: productSaving,
      setError: setProductError,
      setSaving: setProductSaving,
      optimistic: (current) => setIssueAssignee(current, assigneeUserId),
      apply: async (current) => {
        const result = await updateIssueAssignment(adminApp, current.issue.id, assigneeUserId);
        setDetail((current) => current == null ? current : setIssueAssignee(current, result.assignee_user_id));
      },
    });
  }, [adminApp, productSaving, runOptimisticIssueUpdate]);

  const changeOwner = useCallback(async (type: "user" | "team" | "none", id: string | null) => {
    await runOptimisticIssueUpdate({
      blocked: productSaving,
      setError: setProductError,
      setSaving: setProductSaving,
      apply: async (current) => {
        if (type === "none") {
          await clearManualIssueOwners(adminApp, current.issue.id);
          setDetail((current) => current == null ? current : clearManualIssueOwnerState(current));
          return;
        }
        if (id === null) throw new Error("A manual issue owner requires an identity");
        const result = await updateIssueOwner(adminApp, current.issue.id, {
          type,
          userId: type === "user" ? id : null,
          teamId: type === "team" ? id : null,
        });
        const existing = current.product.owners.find((owner) => owner.id === result.id);
        const updatedAt = new Date(result.updated_at_millis).toISOString();
        setDetail((current) => current == null ? current : setIssueOwnerState(current, {
          id: result.id,
          type: result.type,
          user_id: result.user_id,
          team_id: result.team_id,
          source: result.source,
          context: result.context,
          created_at: existing?.created_at ?? updatedAt,
          updated_at: updatedAt,
        }));
      },
    });
  }, [adminApp, productSaving, runOptimisticIssueUpdate]);

  const changeBookmark = useCallback(async (bookmarked: boolean) => {
    await runOptimisticIssueUpdate({
      blocked: productSaving,
      setError: setProductError,
      setSaving: setProductSaving,
      optimistic: (current) => setIssueBookmarkState(current, dashboardUser.id, bookmarked),
      apply: async (current) => {
        const result = await updateIssueBookmark(adminApp, current.issue.id, dashboardUser.id, bookmarked, `dashboard-bookmark-${crypto.randomUUID()}`);
        setDetail((current) => current == null ? current : setIssueBookmarkState(current, result.user_id, result.bookmarked));
      },
    });
  }, [adminApp, dashboardUser.id, productSaving, runOptimisticIssueUpdate]);

  const reconcileSubscription = useCallback((result: Awaited<ReturnType<typeof updateIssueSubscription>>) => {
    const existing = detail?.product.subscriptions.find((subscription) => subscription.type === result.subject_type && subscription.id === result.subject_id);
    const resultTime = new Date(result.updated_at_millis).toISOString();
    setDetail((current) => current == null ? current : setIssueSubscriptionState(current, {
      type: result.subject_type,
      id: result.subject_id,
      is_active: result.subscribed,
      reason: result.reason,
      created_at: existing?.created_at ?? resultTime,
      updated_at: resultTime,
    }, result.subscribed, resultTime));
  }, [detail]);

  const changeSubscription = useCallback(async (subscribed: boolean) => {
    const updatedAt = new Date().toISOString();
    await runOptimisticIssueUpdate({
      blocked: productSaving,
      setError: setProductError,
      setSaving: setProductSaving,
      optimistic: (current) => setIssueSubscriptionState(current, { type: "user", id: dashboardUser.id, is_active: subscribed, reason: "manual", created_at: updatedAt, updated_at: updatedAt }, subscribed, updatedAt),
      apply: async (current) => {
        const result = await updateIssueSubscription(adminApp, current.issue.id, "user", dashboardUser.id, subscribed, "manual", `dashboard-subscription-${crypto.randomUUID()}`);
        reconcileSubscription(result);
      },
    });
  }, [adminApp, dashboardUser.id, productSaving, reconcileSubscription, runOptimisticIssueUpdate]);

  const changeTeam = useCallback(async () => {
    await runOptimisticIssueUpdate({
      blocked: productSaving,
      setError: setProductError,
      setSaving: setProductSaving,
      optimistic: (current) => setIssueTeam(current, ownerTeam.id),
      apply: async (current) => {
        const result = await updateIssueTeam(adminApp, current.issue.id, ownerTeam.id);
        setDetail((current) => current == null ? current : setIssueTeam(current, result.team_id));
      },
    });
  }, [adminApp, ownerTeam.id, productSaving, runOptimisticIssueUpdate]);

  const changeTeamSubscription = useCallback(async (subscribed: boolean) => {
    const updatedAt = new Date().toISOString();
    await runOptimisticIssueUpdate({
      blocked: productSaving,
      setError: setProductError,
      setSaving: setProductSaving,
      optimistic: (current) => setIssueSubscriptionState(current, { type: "team", id: ownerTeam.id, is_active: subscribed, reason: "manual", created_at: updatedAt, updated_at: updatedAt }, subscribed, updatedAt),
      apply: async (current) => {
        const result = await updateIssueSubscription(adminApp, current.issue.id, "team", ownerTeam.id, subscribed, "manual", `dashboard-team-subscription-${crypto.randomUUID()}`);
        reconcileSubscription(result);
      },
    });
  }, [adminApp, ownerTeam.id, productSaving, reconcileSubscription, runOptimisticIssueUpdate]);

  const splitHashes = useCallback(async (hashes: string[]) => {
    if (detail == null || productSaving) return;
    setProductError(null);
    setProductSaving(true);
    try {
      const result = await unmergeIssue(adminApp, detail.issue.id, hashes);
      router.push(issueDetailHref(projectId, result.new_issue_id, { rangeHours }));
    } finally {
      setProductSaving(false);
    }
  }, [adminApp, detail, productSaving, projectId, rangeHours, router]);

  if (routeId == null) {
    return (
      <AppEnabledGuard appId="observability">
        <PageLayout title="Issue" scrollMain>
          <DesignAlert
            variant="error"
            title="Not a valid issue reference"
            description={`"${rawIssueId}" is neither an issue id nor a short id.`}
          >
            <DesignButton variant="secondary" size="sm" className="mt-3" asChild>
              <Link href={issuesListHref(projectId)}>Back to issues</Link>
            </DesignButton>
          </DesignAlert>
        </PageLayout>
      </AppEnabledGuard>
    );
  }

  const title = issue == null ? "Issue" : issueTitle(issue);
  const badge = issue == null ? null : issueStatusBadge(issue);
  const primaryAction = issue == null ? "resolve" : primaryIssueStatusAction(issue.status);

  const headerActions = (
    <div className="flex items-center gap-2">
      {badge != null && <DesignBadge label={badge.label} color={badge.color} size="sm" />}
      {issue != null && (
        <>
          <DesignButton
            variant="secondary"
            size="sm"
            onClick={() => changeStatus(nextStatusForAction(primaryAction))}
          >
            {primaryAction === "resolve" ? "Resolve" : "Unresolve"}
          </DesignButton>
          <DesignMenu
            variant="actions"
            align="end"
            items={[
              ...(issue.status === "ignored"
                ? [{ id: "unsnooze", label: "Unsnooze", onClick: () => changeUnsnooze() }]
                : [
                  { id: "ignore", label: "Ignore forever", onClick: () => changeStatus("ignored") },
                  ...ISSUE_SNOOZE_PRESETS.map((preset) => ({
                    id: `snooze-${preset.id}`,
                    label: `Snooze ${preset.label}`,
                    onClick: () => changeSnooze(preset.durationMs),
                  })),
                ]),
              ...(issue.status === "resolved"
                ? [{ id: "regress", label: "Mark as regressed", onClick: () => changeRegress() }]
                : []),
            ]}
          />
        </>
      )}
    </div>
  );

  return (
    <AppEnabledGuard appId="observability">
      <PageLayout fillWidth scrollMain spacing="compact">
        <StickyPageHeader
          title={title}
          description={
            issue == null
              ? undefined
              : `${issueCulprit({ culprit: issue.culprit, frames: occurrence?.frames, data: parseIssueCulpritData(occurrence?.data) })}${issueSubtitle(issue) === "" ? "" : ` · ${issueSubtitle(issue)}`}`
          }
          actions={headerActions}
          sticky
          layoutGroupId="issue-detail-sticky-header"
          scrollContainer="main"
        />

        {statusError != null && (
          <DesignAlert variant="error" title="Couldn't update this issue" description={statusError} />
        )}

        {productError != null && (
          <DesignAlert variant="error" title="Couldn't update issue triage metadata" description={productError} />
        )}

        {error != null && (
          <DesignAlert variant="error" title="Couldn't load this issue" description={error}>
            <DesignButton variant="secondary" size="sm" className="mt-3" onClick={() => { load(); }}>
              Retry
            </DesignButton>
          </DesignAlert>
        )}

        {loading && detail == null && error == null && (
          <div className="flex items-center justify-center py-24">
            <SpinnerGapIcon className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {detail != null && issue != null && (
          <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-w-0 flex-col gap-3">
              <DesignCard title="Impact" icon={ChartLineIcon}>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <StatCell
                    label="Events"
                    value={formatIssueCount(issue.window_occurrences)}
                    hint="Occurrences inside the selected range (ClickHouse)"
                  />
                  <StatCell
                    label="Users"
                    value={formatIssueCount(issue.window_users)}
                    hint="Distinct users affected inside the range"
                  />
                  <StatCell
                    label="All time"
                    value={
                      issue.counters_truncated_at_millis == null
                        ? formatIssueCount(issue.times_seen)
                        : `${formatIssueCount(issue.times_seen)} since ${formatDateFromMillis(issue.counters_truncated_at_millis)}`
                    }
                    hint="Lifetime count (Postgres)"
                  />
                  <StatCell
                    label="First seen"
                    value={formatRelativeTimeFromMillis(issue.first_seen_at_millis, nowMs)}
                    hint={formatAbsoluteTimeFromMillis(issue.first_seen_at_millis)}
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-foreground/[0.06] pt-3">
                  <LogLevelChip level={issue.level} />
                  <DesignBadge label={issue.handled ? "Handled" : "Unhandled"} color={issue.handled ? "zinc" : "red"} size="sm" />
                  {issue.environment != null && <DesignBadge label={issue.environment} color="zinc" size="sm" />}
                  {issue.service_name != null && <DesignBadge label={issue.service_name} color="zinc" size="sm" />}
                  <span className="font-mono text-[11px] text-muted-foreground/70">
                    {issueShortIdLabel(issue.short_id)}
                  </span>
                </div>
              </DesignCard>

              <DesignCard
                title="Stack trace"
                icon={ListDashesIcon}
                subtitle={
                  occurrence == null
                    ? "No retained occurrence"
                    : `${issue.type || "Unknown exception"} · ${occurrence.message || issue.value || "Exception message unavailable"}`
                }
              >
                {stack == null || occurrence == null ? (
                  <DesignAlert
                    variant="info"
                    title="No retained occurrence"
                    description="Every occurrence of this issue has aged out of the retention window. The issue's counters are still exact."
                  />
                ) : (
                  <>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] text-muted-foreground" title={formatAbsoluteTimeFromMillis(occurrence.event_at_millis)}>
                        Captured {formatRelativeTimeFromMillis(occurrence.event_at_millis, nowMs)}
                      </span>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <DesignPillToggle
                          selected={frameOrder}
                          onSelect={(id) => setFrameOrder(parseFrameOrder(id))}
                          options={FRAME_ORDER_OPTIONS}
                          size="sm"
                          glassmorphic={false}
                        />
                        <DesignButton
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-[11px]"
                          disabled={loading || detail.older_cursor == null}
                          aria-label="Load older occurrence"
                          onClick={() => setOccurrenceStep(
                            detail.older_cursor == null ? null : { cursor: detail.older_cursor, direction: "older" },
                          )}
                        >
                          <ArrowLeftIcon className="h-3.5 w-3.5" />
                          Older
                        </DesignButton>
                        <DesignButton
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-[11px]"
                          disabled={loading || detail.newer_cursor == null}
                          aria-label="Load newer occurrence"
                          onClick={() => setOccurrenceStep(
                            detail.newer_cursor == null ? null : { cursor: detail.newer_cursor, direction: "newer" },
                          )}
                        >
                          Newer
                          <ArrowRightIcon className="h-3.5 w-3.5" />
                        </DesignButton>
                      </div>
                    </div>
                    <StackFrameList
                      frames={stack.frames}
                      rawStack={stack.rawStack}
                      order={frameOrder}
                    />
                    <IssueExceptionCauses occurrence={occurrence} frameOrder={frameOrder} />
                  </>
                )}
              </DesignCard>

              <IssueEventSections
                issue={issue}
                occurrence={occurrence}
                detail={detail}
                nowMs={nowMs}
                actionLoading={productSaving}
                onUnmerge={splitHashes}
              />
            </div>

            <aside className="min-w-0 lg:sticky lg:top-3 lg:self-start">
              <div className="flex flex-col gap-3">
                <DesignCard title="Correlated" icon={LinkIcon}>
                  <div className="divide-y divide-foreground/[0.06]">
                    <RailRow label="Trace">
                      {occurrence?.trace_id == null ? <EmptyRailValue /> : (
                        <Link
                          className="font-mono text-xs transition-colors duration-150 hover:transition-none hover:underline"
                          href={traceDetailHref(projectId, {
                            traceId: occurrence.trace_id,
                            spanId: occurrence.span_id,
                            eventType: "$error",
                            eventAtMs: occurrence.event_at_millis,
                          })}
                        >
                          {occurrence.trace_id.slice(0, 12)}…
                        </Link>
                      )}
                    </RailRow>
                    <RailRow label="Session replay">
                      {occurrence?.session_replay_id == null ? <EmptyRailValue /> : (
                        <Link
                          className="font-mono text-xs transition-colors duration-150 hover:transition-none hover:underline"
                          href={sessionReplayHref(projectId, occurrence.session_replay_id, { atMs: occurrence.event_at_millis })}
                        >
                          Watch replay
                        </Link>
                      )}
                    </RailRow>
                    <RailRow label="Occurrence user">
                      {occurrence?.user_id == null ? <EmptyRailValue /> : (
                        <Suspense fallback={<OccurrenceUserFallback userId={occurrence.user_id} />}>
                          <OccurrenceUserLink userId={occurrence.user_id} />
                        </Suspense>
                      )}
                    </RailRow>
                    <RailRow label="Release">
                      {issue.release == null ? <EmptyRailValue /> : <span className="font-mono text-xs">{issue.release}</span>}
                    </RailRow>
                  </div>
                </DesignCard>

                <IssueProductSection
                  detail={detail}
                  onPriorityChange={changePriority}
                  onAddComment={createComment}
                  currentUserId={dashboardUser.id}
                  ownerTeam={{ id: ownerTeam.id, displayName: ownerTeam.displayName }}
                  assigneeOptions={assigneeOptions}
                  actionLoading={productSaving}
                  onAssignmentChange={changeAssignment}
                  onTeamChange={changeTeam}
                  onOwnerChange={changeOwner}
                  onBookmarkChange={changeBookmark}
                  onSubscriptionChange={changeSubscription}
                  onTeamSubscriptionChange={changeTeamSubscription}
                />

                <IssueLeadingUpTo
                  lines={leadingUpTo}
                  error={leadingUpToError}
                  subtitle={anchor == null ? "No correlation id" : CORRELATION_ANCHOR_LABELS.get(anchor.kind)}
                  hasCorrelation={anchor != null}
                />
              </div>
            </aside>
          </div>
        )}
      </PageLayout>
    </AppEnabledGuard>
  );
}
