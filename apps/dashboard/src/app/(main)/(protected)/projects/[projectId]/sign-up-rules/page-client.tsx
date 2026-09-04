"use client";

import { CountryCodeInput } from "@/components/country-code-select";
import { ConditionBuilder, isConditionTreeValid } from "@/components/rule-builder";
import {
  ActionDialog,
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  cn,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Typography,
} from "@/components/ui";
import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignDialog,
  DesignDialogClose,
  DesignEmptyState,
  DesignInput,
  DesignMenu,
  DesignSelectorDropdown,
  DesignSkeleton,
} from "@/components/design-components";
import {
  createEmptyCondition,
  createEmptyGroup,
  parseCelToVisualTree,
  visualTreeToCel,
  type RuleNode,
} from "@/lib/cel-visual-parser";
import { useUpdateConfig } from "@/components/config-update";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowsDownUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  ClockIcon,
  DotsSixVerticalIcon,
  FlaskIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  PulseIcon,
  ShieldCheckIcon,
  SlidersIcon,
  TrashIcon,
  UserIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { useAsyncCallback } from "@hexclave/shared/dist/hooks/use-async-callback";
import type { SignUpRule, SignUpRuleAction } from "@hexclave/shared/dist/interface/crud/sign-up-rules";
import { isValidCountryCode, normalizeCountryCode } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { standardProviders } from "@hexclave/shared/dist/utils/oauth";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import React, { useMemo, useRef, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp, useServerApp } from "../use-admin-app";
import { validateRiskScore } from "@/lib/risk-score-utils";
import { parseClickHouseDate } from "../analytics/shared";

const ruleCardSurfaceClass =
  "bg-white/90 dark:bg-background/60 backdrop-blur-xl shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.06]";
const ruleCardMutedSurfaceClass =
  "bg-white/90 dark:bg-background/60 shadow-sm ring-1 ring-black/[0.06] dark:ring-white/[0.06]";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type RuleAnalytics = {
  ruleId: string,
  countInTimespan: number,
  allTimeCount: number,
  hourlyCounts: { hour: string, count: number }[],
};

type RuleTriggerListItem = {
  id: string,
  triggeredAt: string,
  email: string | null,
};

type AllRuleTriggerListItem = {
  id: string,
  triggeredAt: string,
  ruleId: string | null,
  action: ActionType | null,
  email: string | null,
  authMethod: string | null,
  oauthProvider: string | null,
};

type SignUpRuleEntry = {
  id: string,
  rule: SignUpRule,
};

type SignUpRulesTestEvaluationStatus =
  | 'matched'
  | 'not_matched'
  | 'disabled'
  | 'missing_condition'
  | 'error';

type SignUpRulesTestEvaluation = {
  rule_id: string,
  display_name: string,
  enabled: boolean,
  condition: string,
  status: SignUpRulesTestEvaluationStatus,
  action: {
    type: 'allow' | 'reject' | 'restrict' | 'log',
    message?: string,
  },
  error?: string,
};

type SignUpRulesTestResult = {
  context: {
    email: string,
    email_domain: string,
    country_code: string,
    auth_method: 'password' | 'otp' | 'oauth' | 'passkey',
    oauth_provider: string,
    turnstile_result: 'ok' | 'invalid' | 'error',
    risk_scores: {
      bot: number,
      free_trial_abuse: number,
    },
  },
  evaluations: SignUpRulesTestEvaluation[],
  outcome: {
    should_allow: boolean,
    decision: 'allow' | 'reject' | 'default-allow' | 'default-reject',
    decision_rule_id: string | null,
    restricted_because_of_rule_id: string | null,
  },
};

type ActionType = SignUpRuleAction['type'];

type ConfigWithSignUpRules = CompleteConfig & {
  auth: {
    signUpRules?: Record<string, SignUpRule>,
    signUpRulesDefaultAction?: 'allow' | 'reject',
  },
};

const OAUTH_PROVIDER_OPTIONS = Array.from(standardProviders);
const RULE_TRIGGER_EVENTS_PAGE_SIZE = 50;
const RULE_TRIGGER_EVENTS_QUERY = `
SELECT
  event_at AS triggered_at,
  CAST(data.email, 'Nullable(String)') AS email
FROM events
WHERE event_type = '$sign-up-rule-trigger'
  AND COALESCE(
    NULLIF(CAST(data.rule_id, 'Nullable(String)'), ''),
    NULLIF(CAST(data.ruleId, 'Nullable(String)'), '')
  ) = {rule_id:String}
ORDER BY event_at DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
`;
// Radix Select forbids empty-string item values, so the "all" option uses a sentinel that maps to an empty query param.
const ALL_FILTER_VALUE = "__all__";
const ALL_RULE_TRIGGER_EVENTS_QUERY = `
SELECT
  event_at AS triggered_at,
  COALESCE(
    NULLIF(CAST(data.rule_id, 'Nullable(String)'), ''),
    NULLIF(CAST(data.ruleId, 'Nullable(String)'), '')
  ) AS rule_id,
  CAST(data.action, 'Nullable(String)') AS action,
  CAST(data.email, 'Nullable(String)') AS email,
  CAST(data.auth_method, 'Nullable(String)') AS auth_method,
  CAST(data.oauth_provider, 'Nullable(String)') AS oauth_provider
FROM events
WHERE event_type = '$sign-up-rule-trigger'
  AND ({rule_id:String} = '' OR COALESCE(
    NULLIF(CAST(data.rule_id, 'Nullable(String)'), ''),
    NULLIF(CAST(data.ruleId, 'Nullable(String)'), '')
  ) = {rule_id:String})
  AND ({action:String} = '' OR CAST(data.action, 'Nullable(String)') = {action:String})
  AND ({email_search:String} = '' OR positionCaseInsensitiveUTF8(COALESCE(CAST(data.email, 'Nullable(String)'), ''), {email_search:String}) > 0)
ORDER BY event_at DESC
LIMIT {limit:UInt32}
OFFSET {offset:UInt32}
`;

const ACTION_LABELS: Record<ActionType, string> = {
  allow: 'Allow',
  reject: 'Reject',
  restrict: 'Restrict',
  log: 'Log',
};

const ACTION_BADGE_COLOR: Record<ActionType, "green" | "red" | "orange" | "blue"> = {
  allow: 'green',
  reject: 'red',
  restrict: 'orange',
  log: 'blue',
};

// ─────────────────────────────────────────────────────────────────────────────
// Small reused atoms
// ─────────────────────────────────────────────────────────────────────────────

function ActionBadge({ type, dim = false, size = "sm" }: { type: ActionType, dim?: boolean, size?: "sm" | "md" }) {
  return (
    <span className={cn("inline-flex items-center", dim && "opacity-50")}>
      <DesignBadge label={ACTION_LABELS[type]} color={ACTION_BADGE_COLOR[type]} size={size} contentMode="text" />
    </span>
  );
}

// Trigger rows contain user PII (email, auth method), so assertion metadata must only expose
// non-sensitive diagnostics (which columns and value types came back), never the raw row.
function triggerRowAssertionExtra(row: Record<string, unknown>, fieldName: string) {
  const value = row[fieldName];
  return {
    fieldName,
    actualType: value == null ? "null" : typeof value,
    rowKeys: Object.keys(row),
  };
}

function parseNullableStringField(row: Record<string, unknown>, fieldName: string, rowLabel: string): string | null {
  const value = row[fieldName];
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }

  throw new HexclaveAssertionError(`Expected ${rowLabel} to include ${fieldName}:null|string`, triggerRowAssertionExtra(row, fieldName));
}

function parseActionTypeField(row: Record<string, unknown>, fieldName: string): ActionType | null {
  const value = row[fieldName];
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new HexclaveAssertionError(`Expected sign-up rule trigger row to include ${fieldName}:null|string`, triggerRowAssertionExtra(row, fieldName));
  }
  return isActionType(value) ? value : null;
}

// Sparkline (kept identical — purely visual + tooltip)
function RuleSparkline({
  data,
  countInTimespan,
  allTimeCount,
  timespanHours,
  isLoading,
}: {
  data: { hour: string, count: number }[],
  countInTimespan: number,
  allTimeCount: number,
  timespanHours: number,
  isLoading: boolean,
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-1">
        <div className="w-10 h-4 bg-muted animate-pulse rounded" />
        <div className="w-4 h-3 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  const chartData = data.length >= 2 ? data : [{ hour: '0', count: 0 }, { hour: '1', count: 0 }];
  const maxCount = Math.max(1, ...chartData.map(d => d.count));
  const timespanLabel = `Last ${timespanHours}h`;

  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1 cursor-help">
          <ResponsiveContainer width={40} height={16}>
            <AreaChart data={chartData} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
              <YAxis hide domain={[0, maxCount]} />
              <Area
                type="monotone"
                dataKey="count"
                stroke="currentColor"
                strokeWidth={1}
                fill="currentColor"
                fillOpacity={0.15}
                className="text-muted-foreground"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
          <span className="text-[10px] text-muted-foreground tabular-nums">{countInTimespan}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-[11px]">
        <div className="space-y-0.5">
          <div>{timespanLabel}: {countInTimespan.toLocaleString()}</div>
          <div>All-time: {allTimeCount.toLocaleString()}</div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function parseRuleTriggerRows(resultRows: Record<string, unknown>[]): RuleTriggerListItem[] {
  return resultRows.map((row) => {
    const triggeredAt = row.triggered_at;
    if (typeof triggeredAt !== "string") {
      throw new HexclaveAssertionError("Expected sign-up rule trigger row to include triggered_at:string", triggerRowAssertionExtra(row, "triggered_at"));
    }

    const emailRaw = row.email;
    if (emailRaw == null) {
      return { id: generateUuid(), triggeredAt, email: null };
    }
    if (typeof emailRaw === "string") {
      return { id: generateUuid(), triggeredAt, email: emailRaw };
    }

    throw new HexclaveAssertionError("Expected sign-up rule trigger row to include email:null|string", triggerRowAssertionExtra(row, "email"));
  });
}

function parseAllRuleTriggerRows(resultRows: Record<string, unknown>[]): AllRuleTriggerListItem[] {
  return resultRows.map((row) => {
    const triggeredAt = row.triggered_at;
    if (typeof triggeredAt !== "string") {
      throw new HexclaveAssertionError("Expected sign-up rule trigger row to include triggered_at:string", triggerRowAssertionExtra(row, "triggered_at"));
    }

    return {
      id: generateUuid(),
      triggeredAt,
      ruleId: parseNullableStringField(row, "rule_id", "sign-up rule trigger row"),
      action: parseActionTypeField(row, "action"),
      email: parseNullableStringField(row, "email", "sign-up rule trigger row"),
      authMethod: parseNullableStringField(row, "auth_method", "sign-up rule trigger row"),
      oauthProvider: parseNullableStringField(row, "oauth_provider", "sign-up rule trigger row"),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger history dialog
// ─────────────────────────────────────────────────────────────────────────────

function TriggerStatTile({ label, value, hint }: { label: string, value: React.ReactNode, hint?: string }) {
  return (
    <div className={cn("rounded-xl px-3 py-2.5 min-w-0", ruleCardMutedSurfaceClass)}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
        {label}
      </div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground leading-none">
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[10px] text-muted-foreground/80 truncate">{hint}</div>
      )}
    </div>
  );
}

function TriggerHistoryChart({ data }: { data: { hour: string, count: number }[] }) {
  const chartData = data.length >= 2 ? data : [{ hour: '0', count: 0 }, { hour: '1', count: 0 }];
  const maxCount = Math.max(1, ...chartData.map(d => d.count));
  return (
    <div className={cn("rounded-xl px-3 py-2 h-full flex flex-col justify-between min-w-0", ruleCardMutedSurfaceClass)}>
      <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Activity</span>
        <PulseIcon className="h-3 w-3 text-muted-foreground/70" />
      </div>
      <div className="h-9 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 2, right: 2, bottom: 0, left: 2 }}>
            <YAxis hide domain={[0, maxCount]} />
            <Area
              type="monotone"
              dataKey="count"
              stroke="currentColor"
              strokeWidth={1.5}
              fill="currentColor"
              fillOpacity={0.18}
              className="text-primary"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function formatTriggerTime(triggeredAt: string): { date: string, time: string, relative: string } {
  const dt = parseClickHouseDate(triggeredAt);
  const now = new Date();
  const diffMs = now.getTime() - dt.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  let relative: string;
  if (diffMin < 1) relative = "just now";
  else if (diffMin < 60) relative = `${diffMin}m ago`;
  else if (diffHr < 24) relative = `${diffHr}h ago`;
  else if (diffDay < 7) relative = `${diffDay}d ago`;
  else relative = dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return {
    date: dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
    time: dt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    relative,
  };
}

function TriggerRow({ trigger }: { trigger: RuleTriggerListItem }) {
  const { date, time, relative } = formatTriggerTime(trigger.triggeredAt);
  const email = trigger.email;
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 transition-colors duration-150 hover:bg-foreground/[0.03] hover:transition-none">
      <div className="h-8 w-8 rounded-lg bg-foreground/[0.04] ring-1 ring-foreground/[0.06] flex items-center justify-center shrink-0">
        <ClockIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <UserIcon className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
        {email ? (
          <Typography className="text-xs font-mono truncate">{email}</Typography>
        ) : (
          <Typography variant="secondary" className="text-xs italic">no email captured</Typography>
        )}
      </div>
      <div className="hidden sm:flex flex-col items-end shrink-0 leading-tight">
        <Typography className="text-xs font-medium tabular-nums">{time}</Typography>
        <Typography variant="secondary" className="text-[10px] tabular-nums">{date}</Typography>
      </div>
      <DesignBadge label={relative} color="blue" size="sm" />
    </div>
  );
}

function RecentTriggerRow({
  trigger,
  ruleDisplayNameById,
}: {
  trigger: AllRuleTriggerListItem,
  ruleDisplayNameById: Map<string, string>,
}) {
  const { date, time, relative } = formatTriggerTime(trigger.triggeredAt);
  const ruleDisplayName = trigger.ruleId == null ? null : ruleDisplayNameById.get(trigger.ruleId) ?? null;
  const isDeletedRule = trigger.ruleId != null && ruleDisplayName == null;

  return (
    <div className="group flex items-start gap-3 px-3 py-2.5 transition-colors duration-150 hover:bg-foreground/[0.03] hover:transition-none">
      <div className="h-8 w-8 rounded-lg bg-foreground/[0.04] ring-1 ring-foreground/[0.06] flex items-center justify-center shrink-0 mt-0.5">
        <ClockIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {ruleDisplayName != null ? (
            <Typography className="text-xs font-medium truncate" title={ruleDisplayName}>
              {ruleDisplayName}
            </Typography>
          ) : isDeletedRule ? (
            <Typography
              variant="secondary"
              className="text-xs italic truncate"
              title={trigger.ruleId == null ? undefined : trigger.ruleId}
            >
              deleted rule · {trigger.ruleId}
            </Typography>
          ) : (
            <Typography variant="secondary" className="text-xs italic truncate">
              unknown rule
            </Typography>
          )}
          {trigger.action == null ? null : <ActionBadge type={trigger.action} dim />}
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <UserIcon className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
          {trigger.email != null ? (
            <Typography className="text-xs font-mono truncate">{trigger.email}</Typography>
          ) : (
            <Typography variant="secondary" className="text-xs italic">no email captured</Typography>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          {trigger.authMethod != null ? <span className="truncate">auth: {trigger.authMethod}</span> : null}
          {trigger.oauthProvider != null ? <span className="truncate">oauth: {trigger.oauthProvider}</span> : null}
        </div>
      </div>
      <div className="hidden sm:flex flex-col items-end shrink-0 leading-tight mt-0.5">
        <Typography className="text-xs font-medium tabular-nums">{time}</Typography>
        <Typography variant="secondary" className="text-[10px] tabular-nums">{date}</Typography>
      </div>
      <DesignBadge label={relative} color="blue" size="sm" />
    </div>
  );
}

function RecentTriggersCard({
  signUpRules,
  hexclaveAdminApp,
}: {
  signUpRules: SignUpRuleEntry[],
  hexclaveAdminApp: ReturnType<typeof useAdminApp>,
}) {
  const [emailSearchInput, setEmailSearchInput] = useState("");
  const [debouncedEmailSearch, setDebouncedEmailSearch] = useState("");
  const [ruleFilter, setRuleFilter] = useState(ALL_FILTER_VALUE);
  const [actionFilter, setActionFilter] = useState(ALL_FILTER_VALUE);
  const [triggers, setTriggers] = useState<AllRuleTriggerListItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const latestRequestIdRef = useRef(0);
  const hasMoreRef = useRef(true);
  const isInitialLoadingRef = useRef(false);
  const isLoadingMoreRef = useRef(false);

  const ruleDisplayNameById = useMemo(
    () => new Map(signUpRules.map((entry) => [entry.id, entry.rule.displayName ?? entry.id] as const)),
    [signUpRules],
  );
  const ruleFilterOptions = useMemo(() => [
    { value: ALL_FILTER_VALUE, label: "All rules" },
    ...signUpRules.map((entry) => ({
      value: entry.id,
      label: entry.rule.displayName || entry.id,
    })),
  ], [signUpRules]);

  React.useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedEmailSearch(emailSearchInput.trim());
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [emailSearchInput]);

  const fetchTriggerPage = React.useCallback(async ({ offset, reset }: { offset: number, reset: boolean }) => {
    if (!reset && (!hasMoreRef.current || isLoadingMoreRef.current || isInitialLoadingRef.current)) {
      return;
    }

    const nextRequestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = nextRequestId;
    if (reset) {
      setIsInitialLoading(true);
      isInitialLoadingRef.current = true;
      setIsLoadingMore(false);
      isLoadingMoreRef.current = false;
      setLoadingError(null);
      setHasMore(true);
      hasMoreRef.current = true;
      setTriggers([]);
    } else {
      setIsLoadingMore(true);
      isLoadingMoreRef.current = true;
    }

    try {
      const response = await hexclaveAdminApp.queryAnalytics({
        query: ALL_RULE_TRIGGER_EVENTS_QUERY,
        params: {
          rule_id: ruleFilter === ALL_FILTER_VALUE ? "" : ruleFilter,
          action: actionFilter === ALL_FILTER_VALUE ? "" : actionFilter,
          email_search: debouncedEmailSearch,
          limit: RULE_TRIGGER_EVENTS_PAGE_SIZE,
          offset,
        },
        timeout_ms: 30_000,
        include_all_branches: false,
      });

      if (nextRequestId !== latestRequestIdRef.current) return;

      const parsedRows = parseAllRuleTriggerRows(response.result);
      setTriggers((current) => reset ? parsedRows : [...current, ...parsedRows]);
      setHasMore(parsedRows.length === RULE_TRIGGER_EVENTS_PAGE_SIZE);
      hasMoreRef.current = parsedRows.length === RULE_TRIGGER_EVENTS_PAGE_SIZE;
    } catch (error) {
      if (nextRequestId !== latestRequestIdRef.current) return;
      setLoadingError(error instanceof Error ? error.message : "Failed to load triggers");
    } finally {
      if (nextRequestId === latestRequestIdRef.current) {
        if (reset) {
          setIsInitialLoading(false);
          isInitialLoadingRef.current = false;
        } else {
          setIsLoadingMore(false);
          isLoadingMoreRef.current = false;
        }
      }
    }
  }, [actionFilter, debouncedEmailSearch, hexclaveAdminApp, ruleFilter]);

  React.useEffect(() => {
    runAsynchronouslyWithAlert(() => fetchTriggerPage({ offset: 0, reset: true }));
  }, [fetchTriggerPage]);

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (event) => {
    if (!hasMoreRef.current || isInitialLoadingRef.current || isLoadingMoreRef.current) return;
    const target = event.currentTarget;
    const remainingScrollPx = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (remainingScrollPx > 120) return;
    runAsynchronouslyWithAlert(() => fetchTriggerPage({ offset: triggers.length, reset: false }));
  };

  const hasActiveFilters = ruleFilter !== ALL_FILTER_VALUE || actionFilter !== ALL_FILTER_VALUE || emailSearchInput !== "" || debouncedEmailSearch !== "";

  return (
    <DesignCard
      title="Recent triggers"
      subtitle="Across all sign-up rules"
      icon={PulseIcon}
      gradient="default"
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <DesignInput
            value={emailSearchInput}
            onChange={(event) => setEmailSearchInput(event.target.value)}
            placeholder="Search by email…"
            leadingIcon={<MagnifyingGlassIcon className="h-3.5 w-3.5" />}
            size="sm"
            className="min-w-0 flex-1 sm:min-w-72"
          />
          <DesignSelectorDropdown
            value={ruleFilter}
            onValueChange={setRuleFilter}
            options={ruleFilterOptions}
            size="sm"
            className="w-full sm:w-48"
            placeholder="All rules"
          />
          <DesignSelectorDropdown
            value={actionFilter}
            onValueChange={setActionFilter}
            options={[
              { value: ALL_FILTER_VALUE, label: "All actions" },
              { value: "allow", label: "Allow" },
              { value: "reject", label: "Reject" },
              { value: "restrict", label: "Restrict" },
              { value: "log", label: "Log" },
            ]}
            size="sm"
            className="w-full sm:w-44"
            placeholder="All actions"
          />
        </div>
        {!isInitialLoading && triggers.length > 0 && (
          <div className="flex justify-end">
            <Typography variant="secondary" className="text-[11px] tabular-nums">
              showing {triggers.length}{hasMore ? "+" : ""}
            </Typography>
          </div>
        )}

        {loadingError == null ? null : (
          <DesignAlert variant="error" description={loadingError} />
        )}

        <div
          className={cn("max-h-[360px] overflow-auto rounded-xl", ruleCardMutedSurfaceClass)}
          onScroll={handleScroll}
        >
          {isInitialLoading ? (
            <div className="space-y-2 p-3">
              {["one", "two", "three", "four", "five"].map((skeletonId) => (
                <DesignSkeleton key={skeletonId} className="h-12 rounded-lg" />
              ))}
            </div>
          ) : triggers.length === 0 ? (
            <DesignEmptyState
              icon={ClockIcon}
              title="No triggers found"
              description={
                hasActiveFilters
                  ? "Try broadening your search or clearing the filters."
                  : "No sign-up rule triggers have been recorded yet."
              }
            />
          ) : (
            <div className="divide-y divide-foreground/[0.06]">
              {triggers.map((trigger) => (
                <RecentTriggerRow
                  key={trigger.id}
                  trigger={trigger}
                  ruleDisplayNameById={ruleDisplayNameById}
                />
              ))}
            </div>
          )}
          {isLoadingMore ? (
            <div className="p-3">
              <DesignSkeleton className="h-10 rounded-lg" />
            </div>
          ) : null}
        </div>
      </div>
    </DesignCard>
  );
}

function RuleTriggerHistoryDialog({
  ruleId,
  ruleDisplayName,
  ruleActionType,
  ruleEnabled,
  sparklineData,
  countInTimespan,
  allTimeCount,
  timespanHours,
  isSparklineLoading,
}: {
  ruleId: string,
  ruleDisplayName: string,
  ruleActionType: ActionType,
  ruleEnabled: boolean,
  sparklineData: { hour: string, count: number }[],
  countInTimespan: number,
  allTimeCount: number,
  timespanHours: number,
  isSparklineLoading: boolean,
}) {
  const serverApp = useServerApp();
  const [open, setOpen] = useState(false);
  const [triggers, setTriggers] = useState<RuleTriggerListItem[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [isInitialLoading, setIsInitialLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const latestRequestIdRef = useRef(0);

  const fetchTriggerPage = async ({ offset, reset }: { offset: number, reset: boolean }) => {
    if (!reset && (!hasMore || isLoadingMore || isInitialLoading)) {
      return;
    }

    const nextRequestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = nextRequestId;
    if (reset) {
      setIsInitialLoading(true);
      setIsLoadingMore(false);
      setLoadingError(null);
      setHasMore(true);
      setTriggers([]);
    } else {
      setIsLoadingMore(true);
    }

    try {
      const response = await serverApp.queryAnalytics({
        query: RULE_TRIGGER_EVENTS_QUERY,
        params: {
          rule_id: ruleId,
          limit: RULE_TRIGGER_EVENTS_PAGE_SIZE,
          offset,
        },
        timeout_ms: 30_000,
        include_all_branches: false,
      });

      if (nextRequestId !== latestRequestIdRef.current) return;

      const parsedRows = parseRuleTriggerRows(response.result);
      setTriggers((current) => reset ? parsedRows : [...current, ...parsedRows]);
      setHasMore(parsedRows.length === RULE_TRIGGER_EVENTS_PAGE_SIZE);
    } catch (error) {
      if (nextRequestId !== latestRequestIdRef.current) return;
      setLoadingError(error instanceof Error ? error.message : "Failed to load triggers");
    } finally {
      if (nextRequestId === latestRequestIdRef.current) {
        if (reset) setIsInitialLoading(false);
        else setIsLoadingMore(false);
      }
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      latestRequestIdRef.current += 1;
      setIsInitialLoading(false);
      setIsLoadingMore(false);
      return;
    }
    runAsynchronouslyWithAlert(() => fetchTriggerPage({ offset: 0, reset: true }));
  };

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (event) => {
    if (!hasMore || isInitialLoading || isLoadingMore) return;
    const target = event.currentTarget;
    const remainingScrollPx = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (remainingScrollPx > 120) return;
    runAsynchronouslyWithAlert(() => fetchTriggerPage({ offset: triggers.length, reset: false }));
  };

  const totalLabel = `${allTimeCount.toLocaleString()} total trigger${allTimeCount === 1 ? "" : "s"}`;

  return (
    <DesignDialog
      open={open}
      onOpenChange={handleOpenChange}
      size="2xl"
      icon={PulseIcon}
      title="Rule trigger history"
      description={`${totalLabel} for this rule`}
      trigger={(
        <button
          type="button"
          className="rounded-sm hover:bg-muted/40 px-1 py-0.5 transition-colors hover:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={`View trigger history for ${ruleDisplayName}`}
          title={`View trigger history for ${ruleDisplayName}`}
        >
          <RuleSparkline
            data={sparklineData}
            countInTimespan={countInTimespan}
            allTimeCount={allTimeCount}
            timespanHours={timespanHours}
            isLoading={isSparklineLoading}
          />
        </button>
      )}
      headerContent={(
        <div className={cn("rounded-xl p-3 space-y-3", ruleCardMutedSurfaceClass)}>
          <div className="flex items-center justify-between gap-3 min-w-0">
            <Typography type="div" className="text-sm font-semibold leading-none truncate min-w-0" title={ruleDisplayName}>
              {ruleDisplayName}
            </Typography>
            <div className="flex items-center gap-2 shrink-0">
              <ActionBadge type={ruleActionType} />
              <DesignBadge
                label={ruleEnabled ? "Enabled" : "Disabled"}
                color={ruleEnabled ? "green" : "orange"}
                size="sm"
                contentMode="text"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <TriggerStatTile
              label={`Last ${timespanHours}h`}
              value={countInTimespan.toLocaleString()}
              hint="recent matches"
            />
            <TriggerStatTile
              label="All-time"
              value={allTimeCount.toLocaleString()}
              hint="since rule created"
            />
            <TriggerHistoryChart data={sparklineData} />
          </div>
        </div>
      )}
      footer={(
        <DesignDialogClose asChild>
          <DesignButton variant="secondary" size="sm">Close</DesignButton>
        </DesignDialogClose>
      )}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent triggers
          </span>
          {!isInitialLoading && triggers.length > 0 && (
            <Typography variant="secondary" className="text-[11px] tabular-nums">
              showing {triggers.length}{hasMore ? "+" : ""}
            </Typography>
          )}
        </div>

        {loadingError ? (
          <DesignAlert variant="error" description={loadingError} />
        ) : null}

        <div
          className={cn("max-h-[360px] overflow-auto rounded-xl", ruleCardMutedSurfaceClass)}
          onScroll={handleScroll}
        >
          {isInitialLoading ? (
            <div className="space-y-2 p-3">
              {["one", "two", "three", "four", "five"].map((skeletonId) => (
                <DesignSkeleton key={skeletonId} className="h-11 rounded-lg" />
              ))}
            </div>
          ) : triggers.length === 0 ? (
            <DesignEmptyState
              icon={ClockIcon}
              title="No triggers yet"
              description={
                isSparklineLoading
                  ? "Loading recent activity…"
                  : "Once a sign-up matches this rule, you'll see it appear here."
              }
            />
          ) : (
            <div className="divide-y divide-foreground/[0.06]">
              {triggers.map((trigger) => (
                <TriggerRow key={trigger.id} trigger={trigger} />
              ))}
            </div>
          )}
          {isLoadingMore ? (
            <div className="p-3">
              <DesignSkeleton className="h-9 rounded-lg" />
            </div>
          ) : null}
        </div>
      </div>
    </DesignDialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline rule editor (visible when adding/editing a rule)
// ─────────────────────────────────────────────────────────────────────────────

const ACTION_DROPDOWN_OPTIONS: { value: ActionType, label: string }[] = [
  { value: "allow", label: "Allow" },
  { value: "reject", label: "Reject" },
  { value: "restrict", label: "Restrict" },
  { value: "log", label: "Log only" },
];

function isActionType(value: string): value is ActionType {
  return ACTION_DROPDOWN_OPTIONS.some((option) => option.value === value);
}

function isDefaultAction(value: string): value is "allow" | "reject" {
  return value === "allow" || value === "reject";
}

function useRuleEditorState({
  rule,
  ruleId,
  isNew,
  onSave,
  onCancel,
}: {
  rule?: SignUpRule,
  ruleId: string,
  isNew: boolean,
  onSave: (ruleId: string, rule: SignUpRule) => Promise<void>,
  onCancel: () => void,
}) {
  const ruleAction = rule?.action;
  const [displayName, setDisplayName] = useState(rule?.displayName ?? '');
  const [actionType, setActionType] = useState<ActionType>(ruleAction?.type ?? 'allow');
  const [actionMessage, setActionMessage] = useState(ruleAction?.message ?? '');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [isSaving, setIsSaving] = useState(false);

  const initialConditionTree = useMemo((): RuleNode => {
    if (rule?.condition) {
      const parsed = parseCelToVisualTree(rule.condition);
      if (parsed) return parsed;
    }
    const group = createEmptyGroup('and');
    group.children = [createEmptyCondition()];
    return group;
  }, [rule?.condition]);

  const [conditionTree, setConditionTree] = useState<RuleNode>(initialConditionTree);
  const isTreeValid = isConditionTreeValid(conditionTree);

  const handleSave = async () => {
    if (!displayName.trim() || !isTreeValid) return;
    setIsSaving(true);
    try {
      const normalizedConditionTree = conditionTree.type === 'group' && conditionTree.children.length === 0
        ? { ...conditionTree, children: [createEmptyCondition()] }
        : conditionTree;
      const celCondition = visualTreeToCel(normalizedConditionTree);

      const newRule: SignUpRule = {
        displayName: displayName.trim(),
        condition: celCondition,
        priority: rule?.priority ?? 0,
        enabled,
        action: {
          type: actionType,
          message: actionType === 'reject' ? actionMessage || undefined : undefined,
        },
      };
      await onSave(ruleId, newRule);
    } finally {
      setIsSaving(false);
    }
  };

  return {
    displayName, setDisplayName,
    actionType, setActionType,
    actionMessage, setActionMessage,
    enabled, setEnabled,
    isSaving,
    conditionTree, setConditionTree,
    isTreeValid,
    isNew,
    ruleId,
    handleSave,
    onCancel,
  };
}

type RuleEditorState = ReturnType<typeof useRuleEditorState>;

function ActionDropdown({ state, size = "sm", className }: { state: RuleEditorState, size?: "sm" | "md" | "lg", className?: string }) {
  return (
    <DesignSelectorDropdown
      value={state.actionType}
      onValueChange={(v) => {
        if (!isActionType(v)) {
          throw new HexclaveAssertionError(`Unexpected sign-up rule action type: ${v}`);
        }
        state.setActionType(v);
      }}
      size={size}
      className={className ?? "w-40"}
      options={ACTION_DROPDOWN_OPTIONS}
    />
  );
}

function RejectMessageField({ state, size = "sm", className }: { state: RuleEditorState, size?: "sm" | "md" | "lg", className?: string }) {
  if (state.actionType !== 'reject') return null;
  return (
    <DesignInput
      value={state.actionMessage}
      onChange={(e) => state.setActionMessage(e.target.value)}
      placeholder="Internal rejection reason (not shown to user)"
      className={cn("flex-1 min-w-[200px]", className)}
      size={size}
    />
  );
}

function RejectActionNote({ state }: { state: RuleEditorState }) {
  if (state.actionType !== 'reject') return null;
  return (
    <p className="text-[11px] leading-snug text-muted-foreground/70">
      Reject will prevent users from signing up completely. Consider using Restrict instead — it still creates the user account but blocks app access, and you can unrestrict users later from the dashboard.
    </p>
  );
}

function SaveCancelButtons({ state, size = "sm" }: { state: RuleEditorState, size?: "sm" | "lg" }) {
  return (
    <>
      <DesignButton
        onClick={state.handleSave}
        disabled={!state.displayName.trim() || !state.isTreeValid || state.isSaving}
        size={size}
        loading={state.isSaving}
      >
        {state.isNew ? 'Create rule' : 'Save changes'}
      </DesignButton>
      <DesignButton
        variant="ghost"
        onClick={state.onCancel}
        disabled={state.isSaving}
        size={size}
      >
        Cancel
      </DesignButton>
    </>
  );
}

function ConditionsPanel({ state }: { state: RuleEditorState }) {
  return (
    <div className={cn("p-3 rounded-xl", ruleCardMutedSurfaceClass)}>
      <ConditionBuilder value={state.conditionTree} onChange={state.setConditionTree} />
    </div>
  );
}

function NumberedStep({ n, title, children }: { n: number, title: string, children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="h-6 w-6 rounded-full bg-primary/10 ring-1 ring-primary/20 text-primary text-[11px] font-semibold flex items-center justify-center tabular-nums shrink-0 mt-0.5">
        {n}
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        {children}
      </div>
    </div>
  );
}

function RuleEditor(props: {
  rule?: SignUpRule,
  ruleId: string,
  isNew: boolean,
  onSave: (ruleId: string, rule: SignUpRule) => Promise<void>,
  onCancel: () => void,
}) {
  const state = useRuleEditorState(props);

  return (
    <div className={cn("rounded-2xl ring-2 ring-primary/40 transition-all duration-150 hover:transition-none p-4 space-y-4", ruleCardSurfaceClass)}>
      <NumberedStep n={1} title="Name this rule">
        <div className="flex items-center gap-3">
          <DesignInput
            value={state.displayName}
            onChange={(e) => state.setDisplayName(e.target.value)}
            placeholder="Rule name (e.g., Block disposable emails)"
            size="md"
            className="flex-1"
            autoFocus
          />
          <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
            <Switch checked={state.enabled} onCheckedChange={state.setEnabled} />
            <span>{state.enabled ? "Enabled" : "Disabled"}</span>
          </div>
        </div>
      </NumberedStep>
      <NumberedStep n={2} title="When these conditions match">
        <ConditionsPanel state={state} />
      </NumberedStep>
      <NumberedStep n={3} title="Then take this action">
        <div className="flex flex-wrap items-center gap-3">
          <ActionDropdown state={state} />
          <RejectMessageField state={state} />
        </div>
        <RejectActionNote state={state} />
      </NumberedStep>
      <div className="flex items-center justify-end gap-2 pt-2 border-t border-foreground/[0.06]">
        <SaveCancelButtons state={state} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SortableRuleRow — card row with kebab menu (final layout)
// ─────────────────────────────────────────────────────────────────────────────

type RuleRowProps = {
  entry: SignUpRuleEntry,
  index: number,
  analytics?: RuleAnalytics,
  analyticsTimespanHours: number,
  isAnalyticsLoading: boolean,
  isEditing: boolean,
  onEdit: () => void,
  onDelete: () => void,
  onToggleEnabled: (enabled: boolean) => void,
  onSave: (ruleId: string, rule: SignUpRule) => Promise<void>,
  onCancelEdit: () => void,
};

function SortableRuleRow(props: RuleRowProps) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: props.entry.id, disabled: props.isEditing });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isDragging ? undefined : transition,
  };

  const actionType = props.entry.rule.action.type;
  const conditionSummary = props.entry.rule.condition || '(no condition)';
  const isEnabled = props.entry.rule.enabled !== false;
  const ruleName = props.entry.rule.displayName || 'Unnamed rule';

  if (props.isEditing) {
    return (
      <div ref={setNodeRef} style={style} className="p-3">
        <RuleEditor
          rule={props.entry.rule}
          ruleId={props.entry.id}
          isNew={false}
          onSave={props.onSave}
          onCancel={props.onCancelEdit}
        />
      </div>
    );
  }

  const switchControl = (
    <div
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Switch
        checked={isEnabled}
        onCheckedChange={props.onToggleEnabled}
        aria-label={`${isEnabled ? "Disable" : "Enable"} rule ${ruleName}`}
      />
    </div>
  );

  const dragBindings = {
    ref: setNodeRef,
    style,
    ...attributes,
    ...listeners,
  } as const;

  return (
    <div
      {...dragBindings}
      className={cn(
        "rounded-2xl",
        ruleCardSurfaceClass,
        "flex items-center gap-3 p-4 cursor-grab active:cursor-grabbing",
        !isDragging && "transition-all duration-150 hover:transition-none",
        isDragging && "opacity-50 shadow-lg z-10",
      )}
    >
      <DotsSixVerticalIcon className="h-4 w-4 text-muted-foreground/60 shrink-0" />
      {switchControl}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Typography className={cn("font-medium text-sm truncate", !isEnabled && "text-muted-foreground line-through")}>
            {ruleName}
          </Typography>
          <ActionBadge type={actionType} dim={!isEnabled} />
        </div>
        <Typography variant="secondary" className={cn("text-xs truncate mt-0.5 font-mono", !isEnabled && "line-through")}>
          {conditionSummary}
        </Typography>
      </div>
      <div
        className="flex items-center gap-2"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="hidden sm:flex items-center mr-1">
          <RuleTriggerHistoryDialog
            ruleId={props.entry.id}
            ruleDisplayName={ruleName}
            ruleActionType={actionType}
            ruleEnabled={isEnabled}
            sparklineData={props.analytics?.hourlyCounts ?? []}
            countInTimespan={props.analytics?.countInTimespan ?? 0}
            allTimeCount={props.analytics?.allTimeCount ?? 0}
            timespanHours={props.analyticsTimespanHours}
            isSparklineLoading={props.isAnalyticsLoading}
          />
        </div>
        <DesignMenu
          variant="actions"
          trigger="icon"
          triggerLabel={`Actions for rule ${ruleName}`}
          align="end"
          items={[
            {
              id: "edit",
              label: "Edit rule",
              icon: <PencilSimpleIcon className="h-4 w-4" />,
              onClick: props.onEdit,
            },
            {
              id: "delete",
              label: "Delete rule",
              icon: <TrashIcon className="h-4 w-4" />,
              itemVariant: "destructive",
              onClick: props.onDelete,
            },
          ]}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Default action row
// ─────────────────────────────────────────────────────────────────────────────

function DefaultActionRow({
  value,
  onChange,
}: {
  value: 'allow' | 'reject',
  onChange: (value: 'allow' | 'reject') => void,
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3 rounded-xl px-4 py-3", ruleCardMutedSurfaceClass)}>
      <div className="flex items-center gap-2">
        <ShieldCheckIcon className="h-4 w-4 text-muted-foreground" />
        <Typography className="text-sm">
          <span className="text-muted-foreground">If no rules match → </span>
          <span className="font-medium">{value === 'allow' ? 'Allow sign-up' : 'Reject sign-up'}</span>
        </Typography>
      </div>
      <DesignMenu
        variant="selector"
        trigger="button"
        triggerLabel={value === 'allow' ? 'Allow' : 'Reject'}
        value={value}
        onValueChange={(v) => {
          if (!isDefaultAction(v)) {
            throw new HexclaveAssertionError(`Unexpected default sign-up rule action: ${v}`);
          }
          onChange(v);
        }}
        options={[
          { id: "allow", label: "Allow" },
          { id: "reject", label: "Reject" },
        ]}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty state
// ─────────────────────────────────────────────────────────────────────────────

function EmptyState({ onAddRule, disabled }: { onAddRule: () => void, disabled: boolean }) {
  return (
    <DesignCard title="No rules yet" subtitle="Define rules to gate who can sign up" icon={ShieldCheckIcon} gradient="default">
      <div className="flex items-center justify-between gap-3">
        <Typography variant="secondary" className="text-xs">
          Rules are evaluated top-to-bottom. The first matching rule decides the outcome.
        </Typography>
        <DesignButton size="sm" onClick={onAddRule} disabled={disabled}>
          <PlusIcon className="h-4 w-4 mr-1.5" />
          Add your first rule
        </DesignButton>
      </div>
    </DesignCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Test rules section + dialog
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TURNSTILE_OVERRIDE = "__default__";

// Shared hook used by every TestRulesCard variant - encapsulates all the state
// and the API call so the variants can focus purely on the UI.
function useTestRulesState(hexclaveAdminApp: ReturnType<typeof useAdminApp>) {
  const [email, setEmail] = useState('');
  const [authMethod, setAuthMethod] = useState<SignUpRulesTestResult['context']['auth_method']>('password');
  const [oauthProvider, setOauthProvider] = useState('');
  const [countryCodeOverride, setCountryCodeOverride] = useState('');
  const [turnstileResultOverride, setTurnstileResultOverride] = useState<'ok' | 'invalid' | 'error' | typeof DEFAULT_TURNSTILE_OVERRIDE>(DEFAULT_TURNSTILE_OVERRIDE);
  const [botRiskScoreOverride, setBotRiskScoreOverride] = useState('');
  const [freeTrialAbuseRiskScoreOverride, setFreeTrialAbuseRiskScoreOverride] = useState('');
  const [result, setResult] = useState<SignUpRulesTestResult | null>(null);

  const [runTest, isRunning] = useAsyncCallback(async () => {
    setResult(null);
    const normalizedCountryCodeOverride = normalizeCountryCode(countryCodeOverride);
    const normalizedBotRiskScoreOverride = botRiskScoreOverride.trim();
    const normalizedFreeTrialAbuseRiskScoreOverride = freeTrialAbuseRiskScoreOverride.trim();
    if (normalizedCountryCodeOverride !== '' && !isValidCountryCode(normalizedCountryCodeOverride)) {
      throw new Error("Country code override must be a 2-letter code.");
    }
    if (!validateRiskScore(normalizedBotRiskScoreOverride)) {
      throw new Error("Bot risk score override must be an integer between 0 and 100.");
    }
    if (!validateRiskScore(normalizedFreeTrialAbuseRiskScoreOverride)) {
      throw new Error("Free trial abuse risk score override must be an integer between 0 and 100.");
    }
    if ((normalizedBotRiskScoreOverride === '') !== (normalizedFreeTrialAbuseRiskScoreOverride === '')) {
      throw new Error("Bot risk score and free trial abuse risk score overrides must both be provided or both be left blank.");
    }

    const response = await (hexclaveAdminApp as any)[hexclaveAppInternalsSymbol].sendRequest(
      '/internal/sign-up-rules-test',
      {
        method: 'POST',
        body: JSON.stringify({
          email: email === '' ? null : email,
          auth_method: authMethod,
          oauth_provider: authMethod === 'oauth'
            ? (oauthProvider === '' ? null : oauthProvider)
            : null,
          country_code: normalizedCountryCodeOverride === '' ? null : normalizedCountryCodeOverride,
          ...(turnstileResultOverride === DEFAULT_TURNSTILE_OVERRIDE
            ? {}
            : { turnstile_result: turnstileResultOverride }),
          ...(normalizedBotRiskScoreOverride === ''
            ? {}
            : {
              risk_scores: {
                bot: Number(normalizedBotRiskScoreOverride),
                free_trial_abuse: Number(normalizedFreeTrialAbuseRiskScoreOverride),
              },
            }),
        }),
        headers: { 'Content-Type': 'application/json' },
      },
      'admin'
    );

    if (!response.ok) {
      throw new HexclaveAssertionError(`Failed to test sign-up rules: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    setResult(data);
  }, [authMethod, botRiskScoreOverride, countryCodeOverride, email, freeTrialAbuseRiskScoreOverride, oauthProvider, hexclaveAdminApp, turnstileResultOverride]);

  return {
    email, setEmail,
    authMethod, setAuthMethod,
    oauthProvider, setOauthProvider,
    countryCodeOverride, setCountryCodeOverride,
    turnstileResultOverride, setTurnstileResultOverride,
    botRiskScoreOverride, setBotRiskScoreOverride,
    freeTrialAbuseRiskScoreOverride, setFreeTrialAbuseRiskScoreOverride,
    result,
    runTest,
    isRunning,
  };
}

type TestRulesState = ReturnType<typeof useTestRulesState>;

const DECISION_LABEL: Record<SignUpRulesTestResult['outcome']['decision'], string> = {
  allow: 'Allowed by rule',
  reject: 'Rejected by rule',
  'default-allow': 'Allowed by default',
  'default-reject': 'Rejected by default',
};

const STATUS_LABEL: Record<SignUpRulesTestEvaluationStatus, string> = {
  matched: 'Matched',
  not_matched: 'No match',
  disabled: 'Disabled',
  missing_condition: 'No condition',
  error: 'Error',
};

const statusBadgeColor = (status: SignUpRulesTestEvaluationStatus): "green" | "red" | "orange" | "blue" | undefined => {
  if (status === 'matched') return 'green';
  if (status === 'missing_condition') return 'orange';
  if (status === 'error') return 'red';
  return undefined;
};

function TestRulesCard({ state }: { state: TestRulesState }) {
  const {
    email, setEmail,
    authMethod, setAuthMethod,
    oauthProvider, setOauthProvider,
    countryCodeOverride, setCountryCodeOverride,
    turnstileResultOverride, setTurnstileResultOverride,
    botRiskScoreOverride, setBotRiskScoreOverride,
    freeTrialAbuseRiskScoreOverride, setFreeTrialAbuseRiskScoreOverride,
    result,
    runTest,
    isRunning,
  } = state;

  const evaluations = result?.evaluations ?? [];
  const matchedEvaluations = evaluations.filter((evaluation) => evaluation.status === 'matched');
  const decisionRule = result?.outcome.decision_rule_id
    ? evaluations.find((evaluation) => evaluation.rule_id === result.outcome.decision_rule_id)
    : undefined;
  const restrictedRule = result?.outcome.restricted_because_of_rule_id
    && result.outcome.restricted_because_of_rule_id !== result.outcome.decision_rule_id
    ? evaluations.find((evaluation) => evaluation.rule_id === result.outcome.restricted_because_of_rule_id)
    : undefined;
  const outcomeLabel = result?.outcome.should_allow ? 'Allow' : 'Reject';
  const outcomeBadgeColor = result?.outcome.should_allow ? 'green' : 'red';

  const fieldLabel = (text: string) => (
    <Typography variant="secondary" className="text-[10px] font-semibold uppercase tracking-wider">
      {text}
    </Typography>
  );

  const sectionHeader = (icon: React.ReactNode, title: string, hint?: string) => (
    <div className="flex items-center gap-2">
      <div className="h-6 w-6 rounded-lg bg-foreground/[0.04] ring-1 ring-foreground/[0.06] flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</span>
        {hint && <span className="text-[10px] text-muted-foreground/80 ml-2">{hint}</span>}
      </div>
    </div>
  );

  const subCard = (children: React.ReactNode, className?: string) => (
    <div className={cn("rounded-xl p-3 space-y-2", ruleCardMutedSurfaceClass, className)}>
      {children}
    </div>
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <div className={cn("rounded-xl p-4 space-y-4", ruleCardMutedSurfaceClass)}>
        <div className="space-y-3">
          {sectionHeader(
            <UserIcon className="h-3.5 w-3.5 text-muted-foreground" />,
            "Identity",
            "What the user submits"
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              {fieldLabel("Email")}
              <DesignInput
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@company.com"
                size="sm"
              />
            </div>
            <div className="space-y-1.5">
              {fieldLabel("Auth method")}
              <DesignSelectorDropdown
                value={authMethod}
                onValueChange={(v) => {
                  if (v === 'password' || v === 'otp' || v === 'oauth' || v === 'passkey') {
                    setAuthMethod(v);
                    if (v !== 'oauth') setOauthProvider('');
                  }
                }}
                size="sm"
                options={[
                  { value: "password", label: "Password" },
                  { value: "otp", label: "OTP" },
                  { value: "oauth", label: "OAuth" },
                  { value: "passkey", label: "Passkey" },
                ]}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            {fieldLabel("OAuth provider")}
            <DesignInput
              value={oauthProvider}
              onChange={(e) => setOauthProvider(e.target.value)}
              placeholder={authMethod === 'oauth' ? "google" : "Only used for OAuth"}
              disabled={authMethod !== 'oauth'}
              list="sign-up-rule-test-oauth-providers"
              size="sm"
            />
            <datalist id="sign-up-rule-test-oauth-providers">
              {OAUTH_PROVIDER_OPTIONS.map((provider) => (
                <option key={provider} value={provider} />
              ))}
            </datalist>
          </div>
        </div>

        <div className="h-px bg-foreground/[0.06]" />

        <div className="space-y-3">
          {sectionHeader(
            <ShieldCheckIcon className="h-3.5 w-3.5 text-muted-foreground" />,
            "Risk overrides",
            "Optional"
          )}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              {fieldLabel("Country")}
              <CountryCodeInput
                value={countryCodeOverride || null}
                onChange={(val) => setCountryCodeOverride(val ?? "")}
              />
            </div>
            <div className="space-y-1.5">
              {fieldLabel("Bot score")}
              <DesignInput
                value={botRiskScoreOverride}
                onChange={(e) => setBotRiskScoreOverride(e.target.value)}
                placeholder="0-100"
                inputMode="numeric"
                size="sm"
              />
            </div>
            <div className="space-y-1.5">
              {fieldLabel("Free-trial abuse")}
              <DesignInput
                value={freeTrialAbuseRiskScoreOverride}
                onChange={(e) => setFreeTrialAbuseRiskScoreOverride(e.target.value)}
                placeholder="0-100"
                inputMode="numeric"
                size="sm"
              />
            </div>
            <div className="space-y-1.5">
              {fieldLabel("Turnstile")}
              <DesignSelectorDropdown
                value={turnstileResultOverride}
                onValueChange={(value) => {
                  if (value === DEFAULT_TURNSTILE_OVERRIDE || value === "ok" || value === "invalid" || value === "error") {
                    setTurnstileResultOverride(value);
                  }
                }}
                size="sm"
                options={[
                  { value: DEFAULT_TURNSTILE_OVERRIDE, label: "Default (real result)" },
                  { value: "ok", label: "OK" },
                  { value: "invalid", label: "Invalid" },
                  { value: "error", label: "Error" },
                ]}
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 pt-1 border-t border-foreground/[0.06] -mx-1 px-1">
          <Typography variant="secondary" className="text-xs">
            Simulate a sign-up to preview which rules trigger.
          </Typography>
          <DesignButton
            size="sm"
            onClick={() => runAsynchronouslyWithAlert(runTest)}
            loading={isRunning}
          >
            <span className="inline-flex items-center gap-1.5">
              <FlaskIcon className="h-4 w-4" />
              Run test
            </span>
          </DesignButton>
        </div>
      </div>

      <div className="space-y-3">
        {!result ? (
          <div className={cn("rounded-xl h-full min-h-[260px] flex items-center justify-center", ruleCardMutedSurfaceClass)}>
            <DesignEmptyState
              icon={FlaskIcon}
              title="No simulation yet"
              description="Fill in the context on the left, then run a test to see how each rule evaluates."
            />
          </div>
        ) : (
          <>
            {subCard(
              <>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={cn(
                      "h-7 w-7 rounded-lg flex items-center justify-center shrink-0 ring-1",
                      result.outcome.should_allow
                        ? "bg-emerald-500/10 ring-emerald-400/30 text-emerald-500"
                        : "bg-red-500/10 ring-red-400/30 text-red-500",
                    )}>
                      {result.outcome.should_allow
                        ? <CheckIcon className="h-4 w-4" />
                        : <XIcon className="h-4 w-4" />}
                    </div>
                    <Typography className="text-sm font-semibold">Outcome</Typography>
                  </div>
                  <DesignBadge label={outcomeLabel} color={outcomeBadgeColor} size="sm" />
                </div>
                <Typography variant="secondary" className="text-xs">
                  {DECISION_LABEL[result.outcome.decision]}
                </Typography>
                {decisionRule && (
                  <Typography variant="secondary" className="text-xs">
                    Decision rule: <span className="font-medium text-foreground">{decisionRule.display_name || decisionRule.rule_id}</span>
                  </Typography>
                )}
                {decisionRule?.action.message && (
                  <Typography variant="secondary" className="text-xs">
                    Rejection reason: {decisionRule.action.message}
                  </Typography>
                )}
                {restrictedRule && (
                  <Typography variant="secondary" className="text-xs">
                    Restricted by: <span className="font-medium text-foreground">{restrictedRule.display_name || restrictedRule.rule_id}</span>
                  </Typography>
                )}
              </>,
              "space-y-1.5"
            )}

            {subCard(
              <>
                <div className="flex items-center justify-between">
                  <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Triggered rules
                  </Typography>
                  <Typography variant="secondary" className="text-[11px] tabular-nums">
                    {matchedEvaluations.length} matched
                  </Typography>
                </div>
                {matchedEvaluations.length === 0 ? (
                  <Typography variant="secondary" className="text-xs">
                    No rules matched. Default action applies.
                  </Typography>
                ) : (
                  <div className="space-y-2">
                    {matchedEvaluations.map((evaluation) => (
                      <div
                        key={evaluation.rule_id}
                        className={cn("flex items-center justify-between gap-2 rounded-lg px-2.5 py-2", ruleCardMutedSurfaceClass)}
                      >
                        <div className="min-w-0">
                          <Typography className="text-xs font-medium truncate">
                            {evaluation.display_name || evaluation.rule_id}
                          </Typography>
                          <Typography variant="secondary" className="text-[10px] truncate font-mono">
                            {evaluation.condition || "No condition"}
                          </Typography>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <ActionBadge type={evaluation.action.type} />
                          {evaluation.rule_id === result.outcome.decision_rule_id && (
                            <DesignBadge label="Decision" color="purple" size="sm" />
                          )}
                          {evaluation.rule_id === result.outcome.restricted_because_of_rule_id && (
                            <DesignBadge label="Restrict" color="orange" size="sm" />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {subCard(
              <>
                <div className="flex items-center justify-between">
                  <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Evaluation trace
                  </Typography>
                  <Typography variant="secondary" className="text-[11px] tabular-nums">
                    {evaluations.length} evaluated
                  </Typography>
                </div>
                {evaluations.length === 0 ? (
                  <Typography variant="secondary" className="text-xs">
                    No rules configured yet.
                  </Typography>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-auto pr-1">
                    {evaluations.map((evaluation) => {
                      const statusColor = statusBadgeColor(evaluation.status);
                      return (
                        <div
                          key={evaluation.rule_id}
                          className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-foreground/[0.03] transition-colors hover:transition-none"
                          title={evaluation.error ?? undefined}
                        >
                          <div className="min-w-0">
                            <Typography className="text-xs font-medium truncate">
                              {evaluation.display_name || evaluation.rule_id}
                            </Typography>
                            <Typography variant="secondary" className="text-[10px] truncate font-mono">
                              {evaluation.condition || "No condition"}
                            </Typography>
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <ActionBadge type={evaluation.action.type} />
                            {statusColor ? (
                              <DesignBadge label={STATUS_LABEL[evaluation.status]} color={statusColor} size="sm" />
                            ) : (
                              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                {STATUS_LABEL[evaluation.status]}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {subCard(
              <>
                <Typography className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Normalized context
                </Typography>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {[
                    ["Email", result.context.email || "(empty)"],
                    ["Domain", result.context.email_domain || "(empty)"],
                    ["Country", result.context.country_code || "(empty)"],
                    ["OAuth", result.context.oauth_provider || "(empty)"],
                    ["Turnstile", result.context.turnstile_result],
                    ["Bot risk", String(result.context.risk_scores.bot)],
                    ["Free-trial risk", String(result.context.risk_scores.free_trial_abuse)],
                  ].map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between gap-2 min-w-0">
                      <Typography variant="secondary" className="text-[10px] uppercase tracking-wider shrink-0">
                        {label}
                      </Typography>
                      <Typography className="text-xs font-mono truncate">{value}</Typography>
                    </div>
                  ))}
                </div>
              </>,
              "space-y-1.5"
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TestRulesDialog({
  hexclaveAdminApp,
  trigger,
}: {
  hexclaveAdminApp: ReturnType<typeof useAdminApp>,
  trigger: React.ReactElement,
}) {
  const state = useTestRulesState(hexclaveAdminApp);

  return (
    <DesignDialog
      size="5xl"
      icon={FlaskIcon}
      title="Test sign-up rules"
      description="Simulate a sign-up request to preview which rules trigger and how the final decision is made."
      trigger={trigger}
      footer={(
        <DesignDialogClose asChild>
          <DesignButton variant="secondary" size="sm">Close</DesignButton>
        </DesignDialogClose>
      )}
    >
      <TestRulesCard state={state} />
    </DesignDialog>
  );
}

function TestRulesPanel({ hexclaveAdminApp }: { hexclaveAdminApp: ReturnType<typeof useAdminApp> }) {
  const triggerButton = (
    <DesignButton size="sm" variant="secondary">
      <FlaskIcon className="h-4 w-4 mr-1.5" />
      Open tester
    </DesignButton>
  );

  return (
    <DesignCard title="Test rules" subtitle="Try sample sign-ups without touching the live flow" icon={FlaskIcon} gradient="default">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Typography variant="secondary" className="text-xs">
          Run a simulated sign-up against your current ruleset and see the outcome.
        </Typography>
        <TestRulesDialog hexclaveAdminApp={hexclaveAdminApp} trigger={triggerButton} />
      </div>
    </DesignCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Delete confirmation
// ─────────────────────────────────────────────────────────────────────────────

function DeleteRuleDialog({
  open,
  onOpenChange,
  ruleName,
  onConfirm,
}: {
  open: boolean,
  onOpenChange: (open: boolean) => void,
  ruleName: string,
  onConfirm: () => Promise<void>,
}) {
  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete rule"
      danger
      okButton={{
        label: "Delete",
        onClick: onConfirm,
      }}
      cancelButton
    >
      <Typography>
        Are you sure you want to delete the rule <b>{ruleName}</b>? This action cannot be undone.
      </Typography>
    </ActionDialog>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics hook
// ─────────────────────────────────────────────────────────────────────────────

function useSignUpRulesAnalytics() {
  const hexclaveAdminApp = useAdminApp();
  const [analytics, setAnalytics] = useState<Map<string, RuleAnalytics>>(new Map());
  const [timespanHours, setTimespanHours] = useState(48);
  const [isLoading, setIsLoading] = useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    const fetchAnalytics = async () => {
      try {
        const response = await (hexclaveAdminApp as any)[hexclaveAppInternalsSymbol].sendRequest(
          '/internal/sign-up-rules-stats',
          { method: 'GET' },
          'admin'
        );
        if (cancelled) return;

        if (!response.ok) {
          throw new HexclaveAssertionError(`Failed to fetch sign-up rules stats: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        setTimespanHours(data.analytics_hours);

        const analyticsMap = new Map<string, RuleAnalytics>();
        for (const trigger of data.rule_triggers ?? []) {
          analyticsMap.set(trigger.rule_id, {
            ruleId: trigger.rule_id,
            countInTimespan: trigger.total_count,
            allTimeCount: trigger.all_time_count,
            hourlyCounts: trigger.hourly_counts ?? [],
          });
        }

        setAnalytics(analyticsMap);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    runAsynchronouslyWithAlert(fetchAnalytics);
    return () => {
      cancelled = true;
    };
  }, [hexclaveAdminApp]);

  return { analytics, timespanHours, isLoading };
}

// ─────────────────────────────────────────────────────────────────────────────
// Page body
// ─────────────────────────────────────────────────────────────────────────────

type PageBodyProps = {
  signUpRules: SignUpRuleEntry[],
  ruleAnalytics: Map<string, RuleAnalytics>,
  analyticsTimespanHours: number,
  isAnalyticsLoading: boolean,
  isCreatingNew: boolean,
  newRuleId: string | null,
  editingRuleId: string | null,
  hasOrderChanges: boolean,
  defaultAction: 'allow' | 'reject',
  isSavingOrder: boolean,
  onAddRule: () => void,
  onSaveRule: (ruleId: string, rule: SignUpRule) => Promise<void>,
  onCancelEdit: () => void,
  onEditRule: (id: string) => void,
  onRequestDelete: (entry: SignUpRuleEntry) => void,
  onToggleEnabled: (id: string, enabled: boolean) => void,
  onDefaultActionChange: (value: 'allow' | 'reject') => void,
  onDragEnd: (event: DragEndEvent) => void,
  onSaveOrder: () => Promise<void>,
  onDiscardOrder: () => void,
  hexclaveAdminApp: ReturnType<typeof useAdminApp>,
};

function PageBody(props: PageBodyProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const renderRules = () => (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={props.onDragEnd}>
      <SortableContext items={props.signUpRules.map((r) => r.id)} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-2">
          {props.signUpRules.map((entry, index) => (
            <SortableRuleRow
              key={entry.id}
              entry={entry}
              index={index}
              analytics={props.ruleAnalytics.get(entry.id)}
              analyticsTimespanHours={props.analyticsTimespanHours}
              isAnalyticsLoading={props.isAnalyticsLoading}
              isEditing={props.editingRuleId === entry.id}
              onEdit={() => props.onEditRule(entry.id)}
              onDelete={() => props.onRequestDelete(entry)}
              onToggleEnabled={(enabled) => props.onToggleEnabled(entry.id, enabled)}
              onSave={props.onSaveRule}
              onCancelEdit={props.onCancelEdit}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );

  return (
    <div className="relative">
      <div className="flex flex-col gap-2">
        {props.isCreatingNew && props.newRuleId && (
          <RuleEditor
            ruleId={props.newRuleId}
            isNew
            onSave={props.onSaveRule}
            onCancel={props.onCancelEdit}
          />
        )}

        {props.hasOrderChanges && (
          <DesignAlert
            variant="info"
            title="Rule order has been changed"
            description={
              <span className="flex items-center gap-2">
                <ArrowsDownUpIcon className="h-4 w-4" />
                Save to commit, or discard to revert.
              </span>
            }
          />
        )}

        {props.hasOrderChanges && (
          <div className="flex justify-end mb-1">
            <OrderChangeActions
              isSavingOrder={props.isSavingOrder}
              onSaveOrder={props.onSaveOrder}
              onDiscardOrder={props.onDiscardOrder}
            />
          </div>
        )}

        {props.signUpRules.length > 0 && renderRules()}

        {props.signUpRules.length === 0 && !props.isCreatingNew && (
          <EmptyState
            onAddRule={props.onAddRule}
            disabled={props.editingRuleId !== null || props.hasOrderChanges}
          />
        )}

        <DefaultActionRow
          value={props.defaultAction}
          onChange={props.onDefaultActionChange}
        />

        <div className="pt-10">
          <RecentTriggersCard signUpRules={props.signUpRules} hexclaveAdminApp={props.hexclaveAdminApp} />
        </div>

        <div className="pt-10">
          <TestRulesPanel hexclaveAdminApp={props.hexclaveAdminApp} />
        </div>

        <div className="pt-5" aria-hidden />
      </div>
    </div>
  );
}

function OrderChangeActions({
  isSavingOrder,
  onSaveOrder,
  onDiscardOrder,
}: {
  isSavingOrder: boolean,
  onSaveOrder: () => Promise<void>,
  onDiscardOrder: () => void,
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-50 px-2 py-1.5 dark:bg-amber-950/20">
      <span className="hidden items-center gap-1.5 px-1 text-xs text-amber-800 dark:text-amber-200 sm:flex">
        <ArrowsDownUpIcon className="h-3.5 w-3.5" />
        Unsaved order
      </span>
      <DesignButton
        variant="ghost"
        size="sm"
        onClick={onDiscardOrder}
        disabled={isSavingOrder}
      >
        <XIcon className="h-4 w-4 mr-1.5" />
        Discard
      </DesignButton>
      <DesignButton
        size="sm"
        onClick={onSaveOrder}
        loading={isSavingOrder}
      >
        <CheckIcon className="h-4 w-4 mr-1.5" />
        Save order
      </DesignButton>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page client — owns all state; passes handlers to PageBody
// ─────────────────────────────────────────────────────────────────────────────

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();

  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [newRuleId, setNewRuleId] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [ruleToDelete, setRuleToDelete] = useState<SignUpRuleEntry | null>(null);

  const {
    analytics: ruleAnalytics,
    timespanHours: analyticsTimespanHours,
    isLoading: isAnalyticsLoading,
  } = useSignUpRulesAnalytics();

  // SAFETY: CompleteConfig is normalized with the sign-up-rules defaults before
  // it reaches the dashboard, so these fields are present at runtime.
  const configWithRules = config as ConfigWithSignUpRules;

  const serverRules = useMemo(() =>
    typedEntries(configWithRules.auth.signUpRules)
      .map(([id, rule]) => ({ id, rule }))
      .sort((a, b) => b.rule.priority - a.rule.priority),
    [configWithRules.auth.signUpRules]
  );
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const defaultAction = configWithRules.auth.signUpRulesDefaultAction ?? 'allow';

  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);

  const signUpRules: SignUpRuleEntry[] = useMemo(() => {
    if (pendingOrder === null) return serverRules;
    const ruleMap = new Map(serverRules.map(r => [r.id, r]));
    const result: SignUpRuleEntry[] = [];
    for (const id of pendingOrder) {
      const rule = ruleMap.get(id);
      if (rule) result.push(rule);
    }
    return result;
  }, [serverRules, pendingOrder]);

  const hasOrderChanges = pendingOrder !== null;

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const currentOrder = pendingOrder ?? serverRules.map(r => r.id);
      const oldIndex = currentOrder.indexOf(active.id as string);
      const newIndex = currentOrder.indexOf(over.id as string);
      const newOrder = arrayMove(currentOrder, oldIndex, newIndex);
      setPendingOrder(newOrder);
    }
  };

  const handleAddRule = () => {
    const id = generateUuid();
    setNewRuleId(id);
    setIsCreatingNew(true);
    setEditingRuleId(null);
  };

  const handleSaveRule = async (ruleId: string, rule: SignUpRule) => {
    const ruleToSave: SignUpRule = isCreatingNew
      ? { ...rule, priority: serverRules.length + 1 }
      : rule;

    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: {
        [`auth.signUpRules.${ruleId}`]: ruleToSave,
      },
      pushable: true,
    });
    setEditingRuleId(null);
    setIsCreatingNew(false);
    setNewRuleId(null);
  };

  const handleCancelEdit = () => {
    setEditingRuleId(null);
    setIsCreatingNew(false);
    setNewRuleId(null);
  };

  const handleDeleteRule = async () => {
    if (!ruleToDelete) return;
    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: {
        [`auth.signUpRules.${ruleToDelete.id}`]: null,
      },
      pushable: true,
    });
    if (pendingOrder) {
      setPendingOrder(pendingOrder.filter(id => id !== ruleToDelete.id));
    }
    setDeleteDialogOpen(false);
    setRuleToDelete(null);
  };

  const handleToggleEnabled = async (ruleId: string, enabled: boolean) => {
    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: {
        [`auth.signUpRules.${ruleId}.enabled`]: enabled,
      },
      pushable: true,
    });
  };

  const handleDefaultActionChange = async (value: 'allow' | 'reject') => {
    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: {
        'auth.signUpRulesDefaultAction': value,
      },
      pushable: true,
    });
  };

  const handleSaveOrder = async () => {
    if (!pendingOrder) return;

    const configUpdate: Record<string, number> = {};
    pendingOrder.forEach((ruleId, index) => {
      configUpdate[`auth.signUpRules.${ruleId}.priority`] = pendingOrder.length - index;
    });

    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate,
      pushable: true,
    });

    setPendingOrder(null);
  };

  const handleDiscardOrder = () => setPendingOrder(null);

  const [handleSaveOrderAsync, isSavingOrder] = useAsyncCallback(handleSaveOrder, [handleSaveOrder]);

  const isAnyEditing = editingRuleId !== null || isCreatingNew;

  return (
    <AppEnabledGuard appId="authentication">
      <PageLayout
        title="Sign-up Rules"
        description="Create rules to control who can sign up. Rules are evaluated in order from top to bottom."
        actions={
          <DesignButton
            onClick={handleAddRule}
            disabled={isAnyEditing || hasOrderChanges}
          >
            <PlusIcon className="h-4 w-4 mr-2" />
            Add rule
          </DesignButton>
        }
      >
        <PageBody
          signUpRules={signUpRules}
          ruleAnalytics={ruleAnalytics}
          analyticsTimespanHours={analyticsTimespanHours}
          isAnalyticsLoading={isAnalyticsLoading}
          isCreatingNew={isCreatingNew}
          newRuleId={newRuleId}
          editingRuleId={editingRuleId}
          hasOrderChanges={hasOrderChanges}
          defaultAction={defaultAction}
          isSavingOrder={isSavingOrder}
          onAddRule={handleAddRule}
          onSaveRule={handleSaveRule}
          onCancelEdit={handleCancelEdit}
          onEditRule={(id) => {
            setEditingRuleId(id);
            setIsCreatingNew(false);
          }}
          onRequestDelete={(entry) => {
            setRuleToDelete(entry);
            setDeleteDialogOpen(true);
          }}
          onToggleEnabled={(id, enabled) => runAsynchronouslyWithAlert(handleToggleEnabled(id, enabled))}
          onDefaultActionChange={(v) => runAsynchronouslyWithAlert(handleDefaultActionChange(v))}
          onDragEnd={handleDragEnd}
          onSaveOrder={handleSaveOrderAsync}
          onDiscardOrder={handleDiscardOrder}
          hexclaveAdminApp={hexclaveAdminApp}
        />

        <DeleteRuleDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          ruleName={ruleToDelete?.rule.displayName ?? 'this rule'}
          onConfirm={handleDeleteRule}
        />
      </PageLayout>
    </AppEnabledGuard>
  );
}
