"use client";

import {
  DesignAlert,
  DesignButton,
  DesignCard,
  DesignSkeleton,
} from "@/components/design-components";
import { Link } from "@/components/link";
import { Typography, cn } from "@/components/ui";
import { hexclaveAppInternalsSymbol } from "@/lib/hexclave-app-internals";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  NoteIcon,
  PlusIcon,
  ProhibitIcon,
  PulseIcon,
  ShieldCheckIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp, useProjectId } from "../use-admin-app";
import { RecentTriggersCard } from "./page-client";

type TriggersByAction = {
  allow: number,
  reject: number,
  restrict: number,
  log: number,
};

type SignUpRulesStats = {
  analytics_hours: number,
  total_triggers: number,
  triggers_by_action: TriggersByAction,
};

type OutcomesLoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok", data: SignUpRulesStats };

type HexclaveAppInternals = {
  sendRequest: (path: string, requestOptions: RequestInit, requestType?: "client" | "server" | "admin") => Promise<Response>,
};

function getAppInternals(appValue: unknown): HexclaveAppInternals {
  if (appValue == null || typeof appValue !== "object") {
    throw new Error("The Hexclave app instance is unavailable.");
  }
  const internals = Reflect.get(appValue, hexclaveAppInternalsSymbol);
  if (
    internals == null ||
    typeof internals !== "object" ||
    !("sendRequest" in internals) ||
    typeof (internals as HexclaveAppInternals).sendRequest !== "function"
  ) {
    throw new Error("Hexclave app internals are unavailable.");
  }
  return internals as HexclaveAppInternals;
}

function SignUpRulesEmptyIllustration() {
  return (
    <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
      <div className={cn(
        "relative z-10",
        "w-36 h-44 md:w-44 md:h-52",
        "rounded-2xl",
        "bg-gradient-to-br from-foreground/[0.06] via-foreground/[0.03] to-transparent",
        "ring-1 ring-foreground/[0.08]",
        "shadow-[0_0_40px_rgba(0,0,0,0.06)]",
        "flex flex-col gap-3 p-4 md:p-5",
      )}>
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-lg bg-emerald-500/15 ring-1 ring-emerald-500/25 flex items-center justify-center">
            <ShieldCheckIcon className="h-3.5 w-3.5 text-emerald-600/70 dark:text-emerald-400/70" weight="duotone" />
          </div>
          <div className="h-2 flex-1 rounded-full bg-foreground/10" />
        </div>
        <div className="h-2 w-4/5 rounded-full bg-foreground/[0.08]" />
        <div className="h-2 w-3/5 rounded-full bg-foreground/[0.06]" />
        <div className="mt-auto space-y-2">
          <div className="h-8 rounded-xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06]" />
          <div className="h-8 rounded-xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06]" />
        </div>
      </div>

      <div className={cn(
        "absolute z-20",
        "top-[28%] left-[18%] md:left-[22%]",
        "px-3 py-1.5 rounded-xl",
        "bg-emerald-500/10 ring-1 ring-emerald-500/20",
        "rotate-[-8deg]",
      )}>
        <span className="text-emerald-600/80 dark:text-emerald-400/80 text-xs font-semibold">Allow</span>
      </div>
      <div className={cn(
        "absolute z-20",
        "bottom-[32%] right-[16%] md:right-[20%]",
        "px-3 py-1.5 rounded-xl",
        "bg-red-500/10 ring-1 ring-red-500/20",
        "rotate-[10deg]",
      )}>
        <span className="text-red-600/80 dark:text-red-400/80 text-xs font-semibold">Reject</span>
      </div>
      <div className={cn(
        "absolute z-0 hidden md:block",
        "top-[40%] right-[8%]",
        "w-24 h-28 rounded-2xl",
        "bg-foreground/[0.03] ring-1 ring-foreground/[0.05]",
        "rotate-[12deg] opacity-50",
      )} />
    </div>
  );
}

export default function SignUpRulesActivityPageClient() {
  const hexclaveAdminApp = useAdminApp();
  const projectId = useProjectId();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();

  const signUpRules = useMemo(
    () => typedEntries(config.auth.signUpRules)
      .map(([id, rule]) => ({
        id,
        displayName: rule.displayName ?? id,
      }))
      .sort((a, b) => stringCompare(a.displayName, b.displayName)),
    [config.auth.signUpRules],
  );

  const configureHref = urlString`/projects/${projectId}/app-configuration/authentication/sign-up-rules`;
  const hasRules = signUpRules.length > 0;

  if (!hasRules) {
    return (
      <AppEnabledGuard appId="authentication">
        <PageLayout>
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center">
            <div className="relative w-full flex-1 min-h-0 max-h-[280px] md:max-h-[340px]">
              <SignUpRulesEmptyIllustration />
            </div>

            <div className="w-full flex flex-col items-center px-4 pt-4 md:pt-6">
              <h2 className="text-center font-semibold tracking-tight text-2xl md:text-4xl mb-2 md:mb-3">
                No sign-up rules yet
              </h2>
              <p className="text-center text-muted-foreground text-sm md:text-base max-w-xl">
                Configure rules in App Configuration to control who can sign up.
                Rules are evaluated top-to-bottom when users register.
              </p>
            </div>

            <DesignButton asChild size="lg" className="mt-6 mb-4 md:mb-6">
              <Link href={configureHref}>
                <PlusIcon className="h-4 w-4 md:h-5 md:w-5 mr-2" />
                Configure sign-up rules
              </Link>
            </DesignButton>
          </div>
        </PageLayout>
      </AppEnabledGuard>
    );
  }

  return (
    <AppEnabledGuard appId="authentication">
      <PageLayout
        title="Sign-up Rules"
        description="Monitor which sign-up rules are firing. Edit rules in App Configuration."
        actions={
          <DesignButton asChild size="sm">
            <Link href={configureHref}>
              Configure rules
              <ArrowRightIcon className="h-4 w-4 ml-1.5" />
            </Link>
          </DesignButton>
        }
      >
        <div className="space-y-5 max-w-4xl pb-5">
          <RuleOutcomesSection />
          <RecentTriggersCard
            signUpRules={signUpRules}
            hexclaveAdminApp={hexclaveAdminApp}
          />
        </div>
      </PageLayout>
    </AppEnabledGuard>
  );
}

function RuleOutcomesSection() {
  const app = useAdminApp();
  const appInternals = useMemo(() => getAppInternals(app), [app]);
  const [state, setState] = useState<OutcomesLoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    runAsynchronously(async () => {
      setState({ status: "loading" });
      try {
        const response = await appInternals.sendRequest("/internal/sign-up-rules-stats", { method: "GET" }, "admin");
        if (!response.ok) {
          throw new Error(`Failed to load sign-up rule outcomes: ${response.status}`);
        }
        const body = await response.json() as SignUpRulesStats;
        if (!cancelled) {
          setState({ status: "ok", data: body });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setState({ status: "error" });
        captureError("sign-up-rules-outcomes-load", error);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [appInternals]);

  if (state.status === "loading") {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {["a", "b", "c", "d", "e"].map((id) => (
          <DesignSkeleton key={id} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <DesignAlert
        variant="error"
        title="Could not load rule outcomes"
        description="Try refreshing the page. Recent triggers below may still work."
      />
    );
  }

  const { analytics_hours: analyticsHours, total_triggers: totalTriggers, triggers_by_action: byAction } = state.data;

  return (
    <DesignCard
      title="Outcomes"
      subtitle={`Last ${analyticsHours} hours across all sign-up rules`}
      icon={PulseIcon}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <OutcomeKpi label="Total" value={totalTriggers} icon={<PulseIcon className="h-4 w-4" />} />
        <OutcomeKpi label="Allow" value={byAction.allow} icon={<CheckCircleIcon className="h-4 w-4 text-emerald-500" />} />
        <OutcomeKpi label="Reject" value={byAction.reject} icon={<ProhibitIcon className="h-4 w-4 text-red-500" />} />
        <OutcomeKpi label="Restrict" value={byAction.restrict} icon={<WarningCircleIcon className="h-4 w-4 text-amber-500" />} />
        <OutcomeKpi label="Log" value={byAction.log} icon={<NoteIcon className="h-4 w-4 text-blue-500" />} />
      </div>
    </DesignCard>
  );
}

function OutcomeKpi(props: { label: string, value: number, icon: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-foreground/[0.03] ring-1 ring-foreground/[0.06] px-3 py-3">
      <div className="flex items-center gap-1.5 min-w-0">
        {props.icon}
        <Typography variant="secondary" className="truncate text-[11px] uppercase tracking-wide">
          {props.label}
        </Typography>
      </div>
      <span className="text-2xl font-semibold tabular-nums text-foreground">{props.value.toLocaleString()}</span>
    </div>
  );
}
