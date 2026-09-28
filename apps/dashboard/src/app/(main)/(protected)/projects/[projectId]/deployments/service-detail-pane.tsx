"use client";

import { DesignBadge, DesignButton } from "@/components/design-components";
import { Typography, cn } from "@/components/ui";
import type { AdminDeploymentServiceOutcomeJson, AdminProject } from "@hexclave/next";
import { PauseCircleIcon, XIcon } from "@phosphor-icons/react";
import { StyledLink } from "@/components/link";
import { useEffect, useRef, useState } from "react";
import { getServiceTypeMeta, type BoardService } from "./board-model";
import {
  BuildLogsContent,
  DomainsContent,
  OverviewContent,
  RuntimeLogsContent,
  SettingsContent,
  SourceContent,
  VariablesContent,
} from "./panel-content";
import { STATUS_META, getAccentClasses } from "./variants";

/**
 * What to say about a stopped service, or null when it is running.
 *
 * The reason comes from the platform (FREE_PLAN_PARK_REASON in the backend's
 * deployments/parking), and an unrecognised one still renders: this pane is a
 * dashboard the team looks at when their site is down, so it has to say
 * SOMETHING even when it is older than whatever stopped the service.
 */
function parkedNoticeFor(api: BoardService["api"]): { title: string, body: string, showUpgrade: boolean } | null {
  if (api?.parked_at == null) return null;
  if (api.parked_reason === "free_plan_24h") {
    return {
      title: "Stopped by the Free plan's 24-hour limit",
      body: "Services on the Free plan stop 24 hours after each deploy. Visitors see a page explaining the site is unavailable. Deploy again to run it for another 24 hours, or upgrade to the Team plan to remove the limit.",
      showUpgrade: true,
    };
  }
  return {
    title: "Stopped by Hexclave",
    body: "This service has been stopped and is not serving traffic. Contact support if you are not sure why.",
    showUpgrade: false,
  };
}

// Note: service definitions (name, build config, env vars) are read-only here
// — they come from the deploy file's `services` export and are synced by
// `hexclave deploy`. Domains are operational state and stay editable.

type ServiceDetailPaneProps = {
  service: BoardService,
  services: BoardService[],
  project: AdminProject,
  // The run THIS deployment gave this service, or null when it never started one (and for the
  // managed hexclave node, which is not deployed at all). Owns the Build logs tab.
  deploymentId: string | null,
  // Whether that deploy produced a build log at all. An all-prebuilt deploy
  // starts no builder, so there is nothing to fetch.
  hasBuildLogs: boolean,
  outcome: AdminDeploymentServiceOutcomeJson | null,
  // The panel a `hexclave deploy` link named, when this is the service it named.
  // Null for every other case, which is Overview.
  initialTab: string | null,
  onClose: () => void,
  refresh: () => Promise<void>,
};

// No "Deployments" tab listing every past run of this service: the page is already scoped to
// ONE deployment, so the only run that belongs here is that deploy's. It gets a Build logs tab
// instead — the thing you actually open a failed service to read.
type PanelTabId = "overview" | "source" | "build-logs" | "runtime-logs" | "variables" | "domains" | "settings";

// Source sits before Build logs because that is the order the deploy happened
// in: what was packaged, then what the builder made of it — and Runtime logs
// follows both, being what happened after the deploy rather than during it.
const TABS: { id: PanelTabId, label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "source", label: "Source" },
  { id: "build-logs", label: "Build logs" },
  { id: "runtime-logs", label: "Runtime logs" },
  { id: "variables", label: "Variables" },
  { id: "domains", label: "Domains" },
  { id: "settings", label: "Settings" },
];

const PANEL_TAB_IDS = new Set<string>(TABS.map((tab) => tab.id));

/**
 * Whether a string names one of the tabs above.
 *
 * A predicate rather than a `Set.has` plus a cast: `Set<string>.has` does not
 * narrow, so the cast was doing the work and would have kept compiling if the
 * union and the set ever disagreed.
 */
function isPanelTabId(value: string): value is PanelTabId {
  return PANEL_TAB_IDS.has(value);
}

/** The tab a `hexclave deploy` link asked for, or Overview. */
export function linkedTab(panel: string | null | undefined): PanelTabId {
  return panel != null && isPanelTabId(panel) ? panel : "overview";
}

export function ServiceDetailPane(props: ServiceDetailPaneProps) {
  const { service, services, project, refresh } = props;
  const [tab, setTab] = useState<PanelTabId>(() => linkedTab(props.initialTab));

  const isHexclave = service.type === "hexclave";
  const meta = getServiceTypeMeta(service.type);
  const accent = getAccentClasses(meta.accent);
  const Icon = meta.icon;
  const status = STATUS_META.get(service.status);
  // Current state, unlike `status`, which describes how the deployment this board
  // was opened from ended. A service deployed successfully a week ago and stopped
  // last night is "Deployed" and parked at the same time, and a reader needs both.
  const parked = parkedNoticeFor(service.api);

  // When a different service is selected, jump back to Overview. Guarded on the
  // PREVIOUS id rather than firing on mount too: this pane is what a deep link
  // opens on Build logs, and an unguarded effect would reset that before the
  // user ever saw it.
  const previousServiceId = useRef(service.id);
  useEffect(() => {
    if (previousServiceId.current === service.id) return;
    previousServiceId.current = service.id;
    setTab("overview");
  }, [service.id]);

  const selectTab = (id: PanelTabId) => {
    setTab(id);
  };

  const content = (() => {
    switch (tab) {
      case "overview": { return <OverviewContent service={service} project={project} isHexclave={isHexclave} />; }
      case "source": { return <SourceContent deploymentId={props.deploymentId} project={project} service={service} isHexclave={isHexclave} />; }
      case "build-logs": { return <BuildLogsContent deploymentId={props.deploymentId} hasBuildLogs={props.hasBuildLogs} outcome={props.outcome} project={project} isHexclave={isHexclave} />; }
      // Deliberately NOT scoped to props.deploymentId: this is what the service
      // is printing NOW, which is the same output whichever past deployment the
      // board was opened from.
      case "runtime-logs": { return <RuntimeLogsContent service={service} project={project} isHexclave={isHexclave} />; }
      case "variables": { return <VariablesContent service={service} services={services} isHexclave={isHexclave} />; }
      case "domains": { return <DomainsContent service={service} project={project} isHexclave={isHexclave} refresh={refresh} />; }
      case "settings": { return <SettingsContent service={service} isHexclave={isHexclave} />; }
    }
  })();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-start gap-3 border-b border-border/60 p-4">
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", accent.chip)}>
          <Icon className="h-5 w-5" weight="fill" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <DesignBadge label={meta.label} color={meta.accent} size="sm" />
            {status && <DesignBadge label={status.label} color={status.color} size="sm" />}
            {parked && <DesignBadge label="Stopped" color="orange" size="sm" />}
          </div>
          <Typography type="h3" className="mt-1 truncate text-base font-semibold">{service.name}</Typography>
        </div>
        <DesignButton variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={props.onClose} aria-label="Close">
          <XIcon className="h-4 w-4" />
        </DesignButton>
      </div>

      {parked && (
        <div className="border-b border-border/60 bg-amber-500/5 px-4 py-3">
          <div className="flex gap-2.5">
            <PauseCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" weight="fill" />
            <div className="min-w-0">
              <Typography type="label" className="font-medium">{parked.title}</Typography>
              <Typography type="footnote" variant="secondary" className="mt-0.5 block">{parked.body}</Typography>
              {parked.showUpgrade && (
                <StyledLink
                  href={`/projects/${project.id}/project-settings/usage`}
                  className="mt-1.5 inline-block text-xs font-medium"
                >
                  Upgrade plan
                </StyledLink>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-0.5 overflow-x-auto border-b border-border/60 px-1.5">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => selectTab(t.id)}
              className={cn(
                "relative flex shrink-0 whitespace-nowrap px-2.5 py-2 text-xs font-medium transition-colors duration-150 hover:transition-none",
                active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1">{content}</div>
    </div>
  );
}
