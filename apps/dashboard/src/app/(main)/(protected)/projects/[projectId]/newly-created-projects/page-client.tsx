'use client';

import {
  DesignAlert,
  DesignButton,
  DesignCard,
  DesignInput,
  DesignSelectorDropdown as BaseDesignSelectorDropdown,
} from "@/components/design-components";
import { Link } from "@/components/link";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Typography,
} from "@/components/ui";
import { ALL_APPS_FRONTEND } from "@/lib/apps-frontend";
import { sendInternalUserRequest } from "@/lib/hexclave-app-internals";
import { cn } from "@/lib/utils";
import { ALL_APPS, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import { useStackApp, useUser, type StackClientApp } from "@hexclave/next";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { use } from "@hexclave/shared/dist/utils/react";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { Suspense, useMemo, useState } from "react";
import { PageLayout } from "../page-layout";
import { useProjectId } from "../use-admin-app";

const FEATURED_APP_IDS = [
  "authentication",
  "emails",
  "payments",
  "analytics",
  "deploy",
] as const satisfies readonly AppId[];

type FeaturedAppId = (typeof FEATURED_APP_IDS)[number];
type AppTickLevel = "off" | "enabled" | "setup" | "used";
type RdeFilter = "both" | "rde" | "not_rde";
type OnboardingFilter = "both" | "incomplete" | "completed";
type NeonFilter = "include" | "exclude";

const NEON_PROJECT_DESCRIPTION = "Created with Neon";

type OwnerMember = {
  id: string,
  display_name: string | null,
  primary_email: string | null,
  profile_image_url: string | null,
  created_at: string | null,
  last_active_at: string | null,
};

type ProjectOwner = {
  kind: "rde" | "team" | "user" | "unknown",
  team_id: string | null,
  team_display_name: string | null,
  members: OwnerMember[],
};

type ProjectRow = {
  id: string,
  display_name: string,
  description: string,
  created_at: string,
  is_development_environment: boolean,
  onboarding_status: string,
  is_onboarding: boolean,
  non_anonymous_users: number,
  anonymous_users: number,
  last_user_activity_at: string | null,
  has_activity_24h_after_creation: boolean,
  owner: ProjectOwner,
  domains: string[],
  stripe_connected: boolean,
  stripe_setup_complete: boolean,
  email_customized: boolean,
  email_customization: {
    has_draft: boolean,
    has_modified_template: boolean,
  },
  email_setup: {
    kind: "shared" | "custom-domain" | "custom-server",
    provider: "resend" | "smtp" | "managed" | null,
    sender_email: string | null,
    managed_subdomain: string | null,
  },
  has_live_payment: boolean,
  featured_apps: Record<FeaturedAppId, AppTickLevel>,
  other_enabled_apps: AppId[],
};

type SessionReplayItem = {
  id: string,
  project_user: {
    id: string,
    display_name: string | null,
    primary_email: string | null,
  },
  started_at_millis: number,
  last_event_at_millis: number,
  chunk_count: number,
  event_count: number,
};

type ProjectDetail = ProjectRow & {
  description: string,
  updated_at: string,
  is_production_mode: boolean,
  onboarding_state: unknown,
  branch_config: unknown,
  rendered_config: unknown,
  session_replays: SessionReplayItem[],
  replay_next_cursor: string | null,
  featured_app_ids: FeaturedAppId[],
};

type LegacyCompatibleProjectDetail = Omit<
  ProjectDetail,
  "rendered_config" | "replay_next_cursor" | "stripe_setup_complete" | "email_setup" | "email_customization" | "owner"
> & {
  rendered_config?: unknown,
  environment_config?: unknown,
  replay_next_cursor?: string | null,
  stripe_setup_complete?: boolean,
  email_setup?: ProjectRow["email_setup"],
  email_customization?: ProjectRow["email_customization"],
  owner: Omit<ProjectOwner, "members"> & {
    members: LegacyCompatibleOwnerMember[],
  },
};

type ListResponse = {
  generated_at: string,
  featured_app_ids: FeaturedAppId[],
  projects: ProjectRow[],
  filters: {
    min_users: number,
    rde: RdeFilter,
    onboarding: OnboardingFilter,
    neon: NeonFilter,
    activity_24h_after_creation: boolean,
  },
};

type LegacyCompatibleOwnerMember = Omit<OwnerMember, "created_at" | "last_active_at"> & {
  created_at?: string | null,
  last_active_at?: string | null,
};

type LegacyCompatibleProjectRow = Omit<ProjectRow, "description" | "email_setup" | "email_customization" | "owner"> & {
  description?: string,
  email_setup?: ProjectRow["email_setup"],
  email_customization?: ProjectRow["email_customization"],
  owner: Omit<ProjectOwner, "members"> & {
    members: LegacyCompatibleOwnerMember[],
  },
};

type LegacyCompatibleListResponse = Omit<ListResponse, "projects" | "filters"> & {
  projects: LegacyCompatibleProjectRow[],
  filters: Omit<ListResponse["filters"], "neon"> & {
    neon?: NeonFilter,
  },
};

type ListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error", message: string }
  | { status: "ok", data: ListResponse };

type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error", message: string }
  | { status: "ok", data: ProjectDetail };

type ListFilters = {
  minUsers: string,
  rde: RdeFilter,
  onboarding: OnboardingFilter,
  neon: NeonFilter,
  activity24h: "yes" | "no",
};

const DEFAULT_FILTERS: ListFilters = {
  minUsers: "0",
  rde: "both",
  onboarding: "both",
  neon: "exclude",
  activity24h: "no",
};

const sessionComponentKeys = new WeakMap<object, number>();
let nextSessionComponentKey = 0;

function getSessionComponentKey<T extends object>(session: T): number {
  const existing = sessionComponentKeys.get(session);
  if (existing != null) return existing;
  const created = nextSessionComponentKey++;
  sessionComponentKeys.set(session, created);
  return created;
}

function isListResponse(value: unknown): value is LegacyCompatibleListResponse {
  return value != null
    && typeof value === "object"
    && typeof value["generated_at"] === "string"
    && Array.isArray(value["projects"])
    && Array.isArray(value["featured_app_ids"]);
}

function normalizeOwner(owner: LegacyCompatibleProjectRow["owner"]): ProjectOwner {
  return {
    ...owner,
    members: owner.members.map((member) => ({
      ...member,
      // Dashboard and backend instances can roll over independently.
      created_at: member.created_at ?? null,
      last_active_at: member.last_active_at ?? null,
    })),
  };
}

function normalizeProjectRow(project: LegacyCompatibleProjectRow): ProjectRow {
  return {
    ...project,
    description: project.description ?? "",
    owner: normalizeOwner(project.owner),
    email_setup: project.email_setup ?? {
      kind: "shared",
      provider: null,
      sender_email: null,
      managed_subdomain: null,
    },
    email_customization: project.email_customization ?? {
      has_draft: false,
      has_modified_template: false,
    },
  };
}

function isProjectDetail(value: unknown): value is LegacyCompatibleProjectDetail {
  return value != null
    && typeof value === "object"
    && typeof value["id"] === "string"
    && Array.isArray(value["session_replays"]);
}

async function fetchListState(app: StackClientApp, filters: ListFilters): Promise<ListState> {
  const minUsersValue = String(Math.max(0, Number.parseInt(filters.minUsers || "0", 10) || 0));
  const activityValue = filters.activity24h === "yes" ? "true" : "false";
  try {
    const response = await sendInternalUserRequest(
      app,
      urlString`/internal/newly-created-projects?min_users=${minUsersValue}&rde=${filters.rde}&onboarding=${filters.onboarding}&neon=${filters.neon}&activity_24h_after_creation=${activityValue}`,
    );
    if (response.status === 403) return { status: "forbidden" };
    if (!response.ok) {
      return { status: "error", message: `Request failed (${response.status})` };
    }
    const body: unknown = await response.json();
    if (!isListResponse(body)) {
      return { status: "error", message: "The project list endpoint returned an invalid response." };
    }
    return {
      status: "ok",
      data: {
        ...body,
        projects: body.projects.map(normalizeProjectRow),
        filters: {
          ...body.filters,
          neon: body.filters.neon ?? "include",
        },
      },
    };
  } catch (error) {
    captureError("newly-created-projects-list", error);
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function fetchInitialListState(app: StackClientApp, _session: object): Promise<ListState> {
  // The session argument deliberately scopes the memoized promise in AuthenticatedPage,
  // even though sendInternalUserRequest reads that session through the app.
  return fetchListState(app, DEFAULT_FILTERS);
}

async function fetchProjectDetailState(
  app: StackClientApp,
  projectId: string,
  replayCursor?: string,
): Promise<DetailState> {
  try {
    const path = replayCursor == null
      ? urlString`/internal/newly-created-projects/${projectId}`
      : urlString`/internal/newly-created-projects/${projectId}?replay_cursor=${replayCursor}`;
    const response = await sendInternalUserRequest(app, path);
    if (!response.ok) {
      return { status: "error", message: `Request failed (${response.status})` };
    }
    const body: unknown = await response.json();
    if (!isProjectDetail(body)) {
      return { status: "error", message: "The project detail endpoint returned an invalid response." };
    }
    const responseReplayCursor = body.replay_next_cursor;
    const renderedConfig = body.rendered_config;
    const legacyEnvironmentConfig = body.environment_config;
    if (
      (responseReplayCursor !== undefined && responseReplayCursor !== null && typeof responseReplayCursor !== "string")
      || (renderedConfig === undefined && legacyEnvironmentConfig === undefined)
    ) {
      return { status: "error", message: "The project detail endpoint returned an invalid response." };
    }
    // Keep the dashboard usable while backend and dashboard instances roll over
    // independently. The old endpoint returned the environment config and one
    // replay page without a cursor; both map losslessly to the new response.
    return {
      status: "ok",
      data: {
        ...body,
        owner: normalizeOwner(body.owner),
        rendered_config: renderedConfig ?? legacyEnvironmentConfig,
        replay_next_cursor: responseReplayCursor ?? null,
        stripe_setup_complete: body.stripe_setup_complete === true,
        email_setup: body.email_setup ?? {
          kind: "shared",
          provider: null,
          sender_email: null,
          managed_subdomain: null,
        },
        email_customization: body.email_customization ?? {
          has_draft: body.email_customized,
          has_modified_template: false,
        },
      },
    };
  } catch (error) {
    captureError("newly-created-projects-detail", error);
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function DesignSelectorDropdown<const Value extends string>(props: {
  value: Value,
  onValueChange: (value: Value) => void,
  options: { value: Value, label: string }[],
}) {
  return (
    <BaseDesignSelectorDropdown
      value={props.value}
      options={props.options}
      onValueChange={(value) => {
        const selected = props.options.find((option) => option.value === value);
        if (selected == null) throw new Error(`Unknown selector value: ${value}`);
        props.onValueChange(selected.value);
      }}
    />
  );
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatDateTime(iso: string | null): string {
  if (iso == null) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function initials(name: string | null | undefined): string {
  if (name == null || name.trim() === "") return "?";
  return name.trim().slice(0, 2).toUpperCase();
}

function appDisplayName(appId: AppId): string {
  return ALL_APPS[appId].displayName;
}

function AppIcon(props: { appId: AppId, className?: string }) {
  const Icon = ALL_APPS_FRONTEND[props.appId].icon;
  return <Icon className={cn("h-4 w-4", props.className)} />;
}

function CellTooltip(props: { label: string, children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex max-w-full cursor-default">{props.children}</span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs break-all">
        {props.label}
      </TooltipContent>
    </Tooltip>
  );
}

function describeEmailSetup(project: LegacyCompatibleProjectRow): string {
  const setup = project.email_setup;
  if (setup == null) return "email server details unavailable";
  if (setup.kind === "shared") return "shared email server";
  if (setup.kind === "custom-domain") {
    return setup.managed_subdomain == null
      ? "managed custom email domain"
      : `managed custom email domain: ${setup.managed_subdomain}`;
  }
  const provider = setup.provider == null ? "custom" : setup.provider.toUpperCase();
  return setup.sender_email == null
    ? `${provider} email server`
    : `${provider} email server · sender: ${setup.sender_email}`;
}

function describeEmailCustomization(project: LegacyCompatibleProjectRow): string {
  const customization = project.email_customization;
  if (customization == null) return "template modified or draft created";
  const reasons = [
    customization.has_draft ? "draft created" : null,
    customization.has_modified_template ? "template modified" : null,
  ].filter((reason): reason is string => reason != null);
  return reasons.length > 0
    ? reasons.join(" + ")
    : "template modified or draft created";
}

function Tick(props: { level: AppTickLevel, appId: FeaturedAppId, project?: ProjectRow }) {
  const emailSetup = props.appId === "emails" && props.project != null
    ? describeEmailSetup(props.project)
    : null;
  if (props.level === "off") {
    return (
      <CellTooltip label={`${appDisplayName(props.appId)}: not enabled`}>
        <span className="text-muted-foreground/70 font-medium">✗</span>
      </CellTooltip>
    );
  }
  if (props.level === "setup") {
    const setupReason = props.appId === "emails"
      ? `enabled + ${emailSetup ?? "non-shared email server"}`
      : "enabled + Stripe setup complete";
    return (
      <CellTooltip label={`${appDisplayName(props.appId)}: ${setupReason}`}>
        <span className="font-semibold text-emerald-500">✓</span>
      </CellTooltip>
    );
  }
  if (props.level === "used") {
    const why = props.appId === "authentication" ? "enabled + has non-anonymous users"
      : props.appId === "emails" && props.project != null
        ? `enabled + ${describeEmailCustomization(props.project)} · ${emailSetup}`
        : props.appId === "payments" ? "enabled + live (non-test) payment"
          : "enabled + in use";
    return (
      <CellTooltip label={`${appDisplayName(props.appId)}: ${why}`}>
        <span className="font-semibold text-amber-500">✓</span>
      </CellTooltip>
    );
  }
  return (
    <CellTooltip label={`${appDisplayName(props.appId)}: enabled`}>
      <span className="font-semibold text-foreground">✓</span>
    </CellTooltip>
  );
}

function OwnerMemberLink(props: {
  member: OwnerMember,
  teamDisplayName: string | null,
  children: React.ReactNode,
}) {
  const label = props.member.display_name ?? props.member.primary_email ?? props.member.id;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={urlString`/projects/internal/users/${props.member.id}`}
          aria-label={`Open user details for ${label}`}
          className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => event.stopPropagation()}
        >
          {props.children}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="top" className="w-80 max-w-[calc(100vw-2rem)] p-3">
        <div className="flex items-center gap-2.5 border-b pb-2">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarImage src={props.member.profile_image_url ?? undefined} alt={props.member.display_name ?? ""} />
            <AvatarFallback className="text-[10px]">{initials(label)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{props.member.display_name ?? "No display name"}</p>
            <p className="truncate text-xs text-muted-foreground">{props.member.primary_email ?? "No primary email"}</p>
          </div>
        </div>
        <dl className="mt-2 grid grid-cols-[5rem_1fr] gap-x-2 gap-y-1 text-xs">
          <dt className="text-muted-foreground">User ID</dt>
          <dd className="break-all font-mono">{props.member.id}</dd>
          <dt className="text-muted-foreground">Team</dt>
          <dd>{props.teamDisplayName ?? "—"}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{formatDateTime(props.member.created_at)}</dd>
          <dt className="text-muted-foreground">Last active</dt>
          <dd>{formatDateTime(props.member.last_active_at)}</dd>
        </dl>
        <p className="mt-2 border-t pt-2 text-[11px] text-muted-foreground">Click to open user details</p>
      </TooltipContent>
    </Tooltip>
  );
}

function OwnerCell(props: { owner: ProjectOwner }) {
  if (props.owner.kind === "rde") {
    return (
      <CellTooltip label={props.owner.team_display_name ?? "Development environment project"}>
        <span className="font-semibold text-red-500">RDE</span>
      </CellTooltip>
    );
  }
  if (props.owner.kind === "user") {
    if (props.owner.members.length !== 1) {
      throwErr("Owner kind=user requires exactly one member");
    }
    const member = props.owner.members[0];
    return (
      <OwnerMemberLink member={member} teamDisplayName={props.owner.team_display_name}>
        <span className="inline-flex items-center gap-1.5 min-w-0">
          <Avatar className="h-5 w-5 shrink-0">
            <AvatarImage src={member.profile_image_url ?? undefined} alt={member.display_name ?? ""} />
            <AvatarFallback className="text-[9px]">{initials(member.display_name ?? member.primary_email)}</AvatarFallback>
          </Avatar>
          <span className="truncate text-xs">{member.primary_email ?? member.display_name ?? "—"}</span>
        </span>
      </OwnerMemberLink>
    );
  }
  if (props.owner.kind === "team") {
    return (
      <span className="inline-flex items-center gap-1.5 min-w-0">
        <span className="flex -space-x-1.5 shrink-0">
          {props.owner.members.slice(0, 4).map((member) => (
            <OwnerMemberLink key={member.id} member={member} teamDisplayName={props.owner.team_display_name}>
              <Avatar key={member.id} className="h-5 w-5 ring-1 ring-background">
                <AvatarImage src={member.profile_image_url ?? undefined} alt={member.display_name ?? ""} />
                <AvatarFallback className="text-[9px]">{initials(member.display_name ?? member.primary_email)}</AvatarFallback>
              </Avatar>
            </OwnerMemberLink>
          ))}
        </span>
        <span className="truncate text-xs">{props.owner.team_display_name ?? "Team"}</span>
      </span>
    );
  }
  return <span className="text-muted-foreground text-xs">—</span>;
}

function UsersCell(props: { nonAnon: number, anon: number }) {
  const label = `${formatNumber(props.nonAnon)} non-anonymous` + (props.anon > 0 ? ` (+${formatNumber(props.anon)} anonymous)` : "");
  return (
    <CellTooltip label={label}>
      <span className="tabular-nums whitespace-nowrap">
        {formatNumber(props.nonAnon)}
        {props.anon > 0 ? (
          <span className="text-muted-foreground">{` (+${formatNumber(props.anon)})`}</span>
        ) : null}
      </span>
    </CellTooltip>
  );
}

function OtherAppsCell(props: { appIds: AppId[] }) {
  if (props.appIds.length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  return (
    <CellTooltip label={props.appIds.map(appDisplayName).join(", ")}>
      <span className="inline-flex items-center gap-1 flex-wrap">
        {props.appIds.map((appId) => (
          <AppIcon key={appId} appId={appId} className="text-muted-foreground" />
        ))}
      </span>
    </CellTooltip>
  );
}

function DomainsCell(props: { domains: string[] }) {
  if (props.domains.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  const visible = props.domains.slice(0, 2).map((domain) => domain.replace(/^https?:\/\//, ""));
  return (
    <CellTooltip label={props.domains.join(", ")}>
      <span className="block max-w-48 truncate">
        {visible.join(", ")}
        {props.domains.length > visible.length ? ` +${props.domains.length - visible.length}` : ""}
      </span>
    </CellTooltip>
  );
}

function JsonBlock(props: { value: unknown }) {
  return (
    <pre className="hexclave-sensitive max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed">
      {JSON.stringify(props.value, null, 2)}
    </pre>
  );
}

export default function PageClient() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <AuthenticatedPage />
    </Suspense>
  );
}

function AuthenticatedPage() {
  const projectId = useProjectId();
  const app = useStackApp();
  const user = useUser({ or: "redirect", projectIdMustMatch: "internal" });
  const initialListStatePromise = useMemo(
    () => fetchInitialListState(app, user._internalSession),
    [app, user._internalSession],
  );

  if (projectId !== "internal") {
    return null;
  }

  return (
    <PageLayout
      title="Newly Created Projects"
      description="Newest customer projects with owners, app adoption, and activity. Internal only."
    >
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <NewlyCreatedProjectsContent
          key={getSessionComponentKey(user._internalSession)}
          app={app}
          initialListStatePromise={initialListStatePromise}
        />
      </Suspense>
    </PageLayout>
  );
}

function NewlyCreatedProjectsContent(props: {
  app: object,
  initialListStatePromise: Promise<ListState>,
}) {
  const initialListState = use(props.initialListStatePromise);
  const [minUsers, setMinUsers] = useState("0");
  const [rde, setRde] = useState<RdeFilter>("both");
  const [onboarding, setOnboarding] = useState<OnboardingFilter>("both");
  const [neon, setNeon] = useState<NeonFilter>("exclude");
  const [activity24h, setActivity24h] = useState<"yes" | "no">("no");
  const [listState, setListState] = useState<ListState>(initialListState);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({ status: "idle" });

  const fetchList = async (filters: ListFilters) => {
    setListState({ status: "loading" });
    setSelectedProjectId(null);
    setDetailState({ status: "idle" });
    setListState(await fetchListState(props.app, filters));
  };

  const loadDetail = (targetProjectId: string) => {
    setSelectedProjectId(targetProjectId);
    setDetailState({ status: "loading" });
    runAsynchronously(async () => {
      setDetailState(await fetchProjectDetailState(props.app, targetProjectId));
    });
  };

  const loadMoreReplays = async (detail: ProjectDetail) => {
    const cursor = detail.replay_next_cursor
      ?? throwErr("Cannot load more session replays without a cursor");
    const nextState = await fetchProjectDetailState(props.app, detail.id, cursor);
    if (nextState.status !== "ok") {
      setDetailState(nextState);
      return;
    }
    setDetailState({
      status: "ok",
      data: {
        ...nextState.data,
        session_replays: [...detail.session_replays, ...nextState.data.session_replays],
      },
    });
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-4">
        <DesignCard className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Min non-anon users</span>
              <DesignInput
                type="number"
                min={0}
                size="sm"
                value={minUsers}
                onChange={(event) => setMinUsers(event.target.value)}
                className="w-28"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs min-w-[9rem]">
              <span className="text-muted-foreground">RDE</span>
              <DesignSelectorDropdown
                value={rde}
                onValueChange={setRde}
                options={[
                  { value: "both", label: "Both" },
                  { value: "rde", label: "RDE only" },
                  { value: "not_rde", label: "Not RDE" },
                ]}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs min-w-[10rem]">
              <span className="text-muted-foreground">Onboarding</span>
              <DesignSelectorDropdown
                value={onboarding}
                onValueChange={setOnboarding}
                options={[
                  { value: "both", label: "Both" },
                  { value: "incomplete", label: "Incomplete" },
                  { value: "completed", label: "Completed" },
                ]}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs min-w-[11rem]">
              <span className="text-muted-foreground">Neon projects</span>
              <DesignSelectorDropdown
                value={neon}
                onValueChange={setNeon}
                options={[
                  { value: "include", label: "Include" },
                  { value: "exclude", label: "Exclude" },
                ]}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs min-w-[14rem]">
              <span className="text-muted-foreground">Activity ≥24h after creation</span>
              <DesignSelectorDropdown
                value={activity24h}
                onValueChange={setActivity24h}
                options={[
                  { value: "no", label: "Either" },
                  { value: "yes", label: "Required" },
                ]}
              />
            </label>
            <DesignButton
              onClick={async () => {
                await fetchList({ minUsers, rde, onboarding, neon, activity24h });
              }}
              variant="secondary"
            >
              Apply filters
            </DesignButton>
          </div>
        </DesignCard>

        {listState.status === "forbidden" ? (
          <DesignAlert variant="error">
            Restricted to the platform team (owner team of the internal project).
          </DesignAlert>
        ) : null}
        {listState.status === "error" ? (
          <DesignAlert variant="error">{listState.message}</DesignAlert>
        ) : null}

        {selectedProjectId != null ? (
          <DetailPanel
            projectId={selectedProjectId}
            state={detailState}
            onLoadMoreReplays={loadMoreReplays}
            onBack={() => {
              setSelectedProjectId(null);
              setDetailState({ status: "idle" });
            }}
          />
        ) : (
          <ProjectsTable
            state={listState}
            onSelectProject={loadDetail}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

function ProjectsTable(props: {
  state: ListState,
  onSelectProject: (projectId: string) => void,
}) {
  if (props.state.status === "idle" || props.state.status === "loading") {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }
  if (props.state.status !== "ok") return null;

  const projects = props.state.data.projects;

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[1250px] text-left text-xs">
        <thead className="bg-muted/40 text-muted-foreground">
          <tr className="border-b">
            <th className="px-2 py-2 font-medium whitespace-nowrap">Users</th>
            <th className="px-2 py-2 font-medium">Project</th>
            <th className="px-2 py-2 font-medium">Owners</th>
            <th className="px-2 py-2 font-medium">Trusted domains</th>
            {FEATURED_APP_IDS.map((appId) => (
              <th key={appId} className="px-1 py-2 text-center font-medium">
                <CellTooltip label={appDisplayName(appId)}>
                  <span className="inline-flex justify-center w-full">
                    <AppIcon appId={appId} />
                  </span>
                </CellTooltip>
              </th>
            ))}
            <th className="px-2 py-2 font-medium">Other apps</th>
            <th className="px-2 py-2 font-medium whitespace-nowrap">Created</th>
            <th className="px-2 py-2 font-medium whitespace-nowrap">Last activity</th>
          </tr>
        </thead>
        <tbody>
          {projects.length === 0 ? (
            <tr>
              <td colSpan={7 + FEATURED_APP_IDS.length} className="px-3 py-8 text-center text-muted-foreground">
                No projects match these filters.
              </td>
            </tr>
          ) : null}
          {projects.map((project) => (
            <tr
              key={project.id}
              className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors hover:transition-none"
              onClick={() => props.onSelectProject(project.id)}
            >
              <td className="px-2 py-1.5 align-middle">
                <UsersCell nonAnon={project.non_anonymous_users} anon={project.anonymous_users} />
              </td>
              <td className="px-2 py-1.5 align-middle max-w-[14rem]">
                <CellTooltip label={project.description === NEON_PROJECT_DESCRIPTION ? `${project.id} · Created with Neon` : project.id}>
                  <span className="flex min-w-0 items-center gap-1.5">
                    {project.description === NEON_PROJECT_DESCRIPTION ? (
                      <AppIcon appId="neon" className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    ) : null}
                    <span className="font-medium truncate block">{project.display_name}</span>
                  </span>
                </CellTooltip>
              </td>
              <td className="px-2 py-1.5 align-middle max-w-[14rem]">
                <OwnerCell owner={project.owner} />
              </td>
              <td className="px-2 py-1.5 align-middle max-w-48">
                <DomainsCell domains={project.domains} />
              </td>
              {project.is_onboarding ? (
                <td
                  colSpan={FEATURED_APP_IDS.length + 1}
                  className="px-2 py-1.5 align-middle text-center"
                >
                  <span className="font-medium text-amber-500">Onboarding</span>
                  <span className="ml-1 text-muted-foreground">({project.onboarding_status})</span>
                </td>
              ) : (
                <>
                  {FEATURED_APP_IDS.map((appId) => (
                    <td key={appId} className="px-1 py-1.5 align-middle text-center">
                      <Tick level={project.featured_apps[appId]} appId={appId} project={project} />
                    </td>
                  ))}
                  <td className="px-2 py-1.5 align-middle">
                    <OtherAppsCell appIds={project.other_enabled_apps} />
                  </td>
                </>
              )}
              <td className="px-2 py-1.5 align-middle whitespace-nowrap">
                <CellTooltip label={project.created_at}>
                  <span>{formatDateTime(project.created_at)}</span>
                </CellTooltip>
              </td>
              <td className="px-2 py-1.5 align-middle whitespace-nowrap">
                <CellTooltip label={project.last_user_activity_at ?? "No activity"}>
                  <span className={project.has_activity_24h_after_creation ? undefined : "text-muted-foreground"}>
                    {formatDateTime(project.last_user_activity_at)}
                  </span>
                </CellTooltip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        {projects.length} projects · generated {formatDateTime(props.state.data.generated_at)}
        <span className="mx-2">·</span>
        <span>✓ white=enabled · </span>
        <span className="text-emerald-500">✓ green=setup</span>
        <span> · </span>
        <span className="text-amber-500">✓ gold=used</span>
      </div>
    </div>
  );
}

function DetailPanel(props: {
  projectId: string,
  state: DetailState,
  onLoadMoreReplays: (detail: ProjectDetail) => Promise<void>,
  onBack: () => void,
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <DesignButton variant="ghost" size="sm" onClick={async () => props.onBack()}>
          <ArrowLeftIcon className="h-4 w-4" />
          Back to list
        </DesignButton>
        <Typography type="label" className="text-muted-foreground font-mono text-xs">
          {props.projectId}
        </Typography>
      </div>

      {props.state.status === "loading" || props.state.status === "idle" ? (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : null}
      {props.state.status === "error" ? (
        <DesignAlert variant="error">{props.state.message}</DesignAlert>
      ) : null}
      {props.state.status === "ok" ? (
        <DetailBody
          data={props.state.data}
          onLoadMoreReplays={props.onLoadMoreReplays}
        />
      ) : null}
    </div>
  );
}

function DetailBody(props: {
  data: ProjectDetail,
  onLoadMoreReplays: (detail: ProjectDetail) => Promise<void>,
}) {
  const data = props.data;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <DesignCard className="p-4 space-y-3">
        <div>
          <div className="flex items-center gap-2">
            {data.description === NEON_PROJECT_DESCRIPTION ? (
              <AppIcon appId="neon" className="h-4 w-4 shrink-0 text-emerald-500" />
            ) : null}
            <Typography type="h3">{data.display_name}</Typography>
          </div>
          <Typography type="label" className="text-muted-foreground font-mono text-xs break-all">
            {data.id}
          </Typography>
        </div>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Users</dt>
          <dd><UsersCell nonAnon={data.non_anonymous_users} anon={data.anonymous_users} /></dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{formatDateTime(data.created_at)}</dd>
          <dt className="text-muted-foreground">Updated</dt>
          <dd>{formatDateTime(data.updated_at)}</dd>
          <dt className="text-muted-foreground">Last activity</dt>
          <dd>{formatDateTime(data.last_user_activity_at)}</dd>
          <dt className="text-muted-foreground">Onboarding</dt>
          <dd>
            {data.is_onboarding ? (
              <span className="text-amber-500 font-medium">{data.onboarding_status}</span>
            ) : (
              data.onboarding_status
            )}
          </dd>
          <dt className="text-muted-foreground">RDE</dt>
          <dd>{data.is_development_environment ? <span className="text-red-500 font-semibold">Yes</span> : "No"}</dd>
          <dt className="text-muted-foreground">Production mode</dt>
          <dd>{data.is_production_mode ? "Yes" : "No"}</dd>
          <dt className="text-muted-foreground">Stripe</dt>
          <dd>
            {data.stripe_connected ? "Connected" : "Not connected"}
            {data.stripe_setup_complete ? " · setup complete" : ""}
            {data.has_live_payment ? " · live payment ✓" : ""}
          </dd>
          <dt className="text-muted-foreground">Email setup</dt>
          <dd>{describeEmailSetup(data)}</dd>
          <dt className="text-muted-foreground">Email content</dt>
          <dd>{data.email_customized ? describeEmailCustomization(data) : "Default templates; no drafts"}</dd>
          <dt className="text-muted-foreground">Domains</dt>
          <dd className="break-all">{data.domains.length > 0 ? data.domains.join(", ") : "—"}</dd>
          <dt className="text-muted-foreground">Owners</dt>
          <dd>
            <OwnerCell owner={data.owner} />
            {data.owner.members.length > 1 ? (
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {data.owner.members.map((member) => (
                  <li key={member.id}>{member.primary_email ?? member.display_name ?? member.id}</li>
                ))}
              </ul>
            ) : null}
          </dd>
          <dt className="text-muted-foreground">Description</dt>
          <dd>{data.description.trim() === "" ? "—" : data.description}</dd>
        </dl>
        <div>
          <Typography type="label" className="mb-1 block">Apps</Typography>
          {data.is_onboarding ? (
            <span className="text-amber-500 font-medium">Onboarding ({data.onboarding_status})</span>
          ) : (
            <div className="flex flex-wrap gap-2">
              {FEATURED_APP_IDS.map((appId) => (
                <span key={appId} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5">
                  <AppIcon appId={appId} />
                  <Tick level={data.featured_apps[appId]} appId={appId} project={data} />
                </span>
              ))}
              {data.other_enabled_apps.map((appId) => (
                <span key={appId} className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5" title={appDisplayName(appId)}>
                  <AppIcon appId={appId} />
                  <span className="text-[10px]">{appDisplayName(appId)}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </DesignCard>

      <DesignCard className="p-4 space-y-3">
        <div>
          <Typography type="h4">Owner session replays</Typography>
          <Typography type="label" className="text-muted-foreground">
            Internal-dashboard replays from project owners that visited this project.
          </Typography>
        </div>
        {data.session_replays.length === 0 ? (
          <Typography type="label" className="text-muted-foreground">No matching owner session replays.</Typography>
        ) : (
          <div className="max-h-96 overflow-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground sticky top-0">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">User</th>
                  <th className="px-2 py-1.5 text-left font-medium">Started</th>
                  <th className="px-2 py-1.5 text-left font-medium">Last event</th>
                  <th className="px-2 py-1.5 text-right font-medium">Events</th>
                  <th className="px-2 py-1.5 text-right font-medium">Replay</th>
                </tr>
              </thead>
              <tbody>
                {data.session_replays.map((replay) => (
                  <tr key={replay.id} className="border-t">
                    <td className="px-2 py-1">
                      <CellTooltip label={replay.id}>
                        <span>
                          {replay.project_user.primary_email
                            ?? replay.project_user.display_name
                            ?? replay.project_user.id}
                        </span>
                      </CellTooltip>
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap">{formatDateTime(new Date(replay.started_at_millis).toISOString())}</td>
                    <td className="px-2 py-1 whitespace-nowrap">{formatDateTime(new Date(replay.last_event_at_millis).toISOString())}</td>
                    <td className="px-2 py-1 text-right tabular-nums">{replay.event_count}</td>
                    <td className="px-2 py-1 text-right">
                      <a
                        href={urlString`/projects/internal/session-replays/${replay.id}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.replay_next_cursor != null ? (
          <DesignButton
            variant="secondary"
            size="sm"
            onClick={async () => await props.onLoadMoreReplays(data)}
          >
            Load more replays
          </DesignButton>
        ) : null}
      </DesignCard>

      <DesignCard className="p-4 space-y-2 lg:col-span-1">
        <Typography type="h4">Branch config</Typography>
        <JsonBlock value={data.branch_config} />
      </DesignCard>

      <DesignCard className="p-4 space-y-2 lg:col-span-1">
        <Typography type="h4">Rendered config</Typography>
        <JsonBlock value={data.rendered_config} />
      </DesignCard>

      {data.onboarding_state != null ? (
        <DesignCard className="p-4 space-y-2 lg:col-span-2">
          <Typography type="h4">Onboarding state</Typography>
          <JsonBlock value={data.onboarding_state} />
        </DesignCard>
      ) : null}
    </div>
  );
}
