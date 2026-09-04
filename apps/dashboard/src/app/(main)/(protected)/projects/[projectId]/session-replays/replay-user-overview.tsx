"use client";

import { DesignBadge } from "@/components/design-components";
import { CountryFlag, getReferrerHost, ReferrerFavicon, regionName } from "@/components/geo-referrer";
import { StyledLink } from "@/components/link";
import { Avatar, AvatarFallback, AvatarImage, CopyButton, SimpleTooltip, Skeleton, Typography } from "@/components/ui";
import { useFromNow } from "@/hooks/use-from-now";
import { formatDurationMs } from "@/lib/session-replay-format";
import { describeUserAgent, type UserAgentDeviceType } from "@/lib/user-agent";
import { cn } from "@/lib/utils";
import {
  ArrowUUpLeftIcon,
  CheckCircleIcon,
  ClockIcon,
  CursorClickIcon,
  DesktopIcon,
  DeviceMobileIcon,
  DeviceTabletIcon,
  FileHtmlIcon,
  IdentificationCardIcon,
  KeyIcon,
  MapPinIcon,
  RobotIcon,
  SignInIcon,
  UsersThreeIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import type { ServerUser } from "@hexclave/next";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import React, { useEffect, useMemo, useState } from "react";
import { useAdminApp, useServerApp } from "../use-admin-app";

/** The bits of a session replay row the overview needs; keeps this component decoupled from the player's state. */
export type ReplayUserOverviewReplay = {
  id: string,
  userId: string,
  /** Identifies the session, which is how the replay is correlated with its analytics events. */
  refreshTokenId: string,
  startedAt: Date,
  lastEventAt: Date,
};

type ReplayGeo = {
  countryCode: string | null,
  regionCode: string | null,
  cityName: string | null,
  tzIdentifier: string | null,
};

type ReplaySessionContext = {
  userAgent: string | null,
  entryPath: string | null,
  referrer: string | null,
  screenWidth: number | null,
  screenHeight: number | null,
  viewportWidth: number | null,
  viewportHeight: number | null,
  /** `null` when the counting query failed, which is different from a session with no page views. */
  activity: { pageViews: number, clicks: number } | null,
  geo: ReplayGeo | null,
};

type SessionContextState =
  | { status: "loading" }
  | { status: "error", error: unknown }
  | { status: "success", context: ReplaySessionContext };

// The entry page-view carries everything the browser told us about this session:
// which device it ran on, how large the window was, and where the visitor came
// from. Later page-views repeat the device fields, so the first row is enough.
const ENTRY_PAGE_VIEW_QUERY = `
  SELECT
    CAST(data.user_agent, 'Nullable(String)') AS user_agent,
    CAST(data.path, 'Nullable(String)') AS entry_path,
    CAST(data.referrer, 'Nullable(String)') AS referrer,
    CAST(data.screen_width, 'Nullable(Int64)') AS screen_width,
    CAST(data.screen_height, 'Nullable(Int64)') AS screen_height,
    CAST(data.viewport_width, 'Nullable(Int64)') AS viewport_width,
    CAST(data.viewport_height, 'Nullable(Int64)') AS viewport_height
  FROM default.events
  WHERE session_replay_id = {replayId:String}
    AND event_type = '$page-view'
  ORDER BY event_at ASC
  LIMIT 1
`;

const ACTIVITY_COUNTS_QUERY = `
  SELECT
    countIf(event_type = '$page-view') AS page_views,
    countIf(event_type = '$click') AS clicks
  FROM default.events
  WHERE session_replay_id = {replayId:String}
`;

// Geo is only ever attached to `$token-refresh` events (it's derived from the
// request IP, which replay events don't carry), so we read it off a refresh of
// the session the replay belongs to. Matching on the refresh token rather than
// the user is what keeps a user's other concurrent sessions — a phone on mobile
// data, say — from lending their location to this replay.
//
// Every refresh of that token belongs to this one session, so rather than cutting
// the search off at the replay's boundaries we take the refresh closest to when
// the replay started: a session that travelled mid-flight still reports where it
// began, and no valid row is discarded just because the replay's boundaries come
// from the visitor's clock (they're rrweb event timestamps) while `event_at` comes
// from ours.
const SESSION_GEO_QUERY = `
  SELECT
    CAST(data.ip_info.country_code, 'Nullable(String)') AS country_code,
    CAST(data.ip_info.region_code, 'Nullable(String)') AS region_code,
    CAST(data.ip_info.city_name, 'Nullable(String)') AS city_name,
    CAST(data.ip_info.tz_identifier, 'Nullable(String)') AS tz_identifier
  FROM default.events
  WHERE refresh_token_id = {refreshTokenId:String}
    AND event_type = '$token-refresh'
  ORDER BY abs(dateDiff('millisecond', event_at, fromUnixTimestamp64Milli({startedAtMillis:Int64}))) ASC
  LIMIT 1
`;

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toNumberOrNull(value: unknown): number | null {
  // ClickHouse serializes 64-bit integers as strings in its JSON formats, so
  // both shapes legitimately reach us for the same column.
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseCount(value: unknown): number {
  return toNumberOrNull(value) ?? 0;
}

function useReplaySessionContext(replay: ReplayUserOverviewReplay): SessionContextState {
  const serverApp = useServerApp();
  const [state, setState] = useState<SessionContextState>({ status: "loading" });

  const replayId = replay.id;
  const refreshTokenId = replay.refreshTokenId;
  const startedAtMs = replay.startedAt.getTime();

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    runAsynchronously(async () => {
      try {
        // ClickHouse rejects a blank substitution with an opaque "is not set"
        // error, which would surface as a generic failed facet; the replay row
        // always carries its session, so an empty one means the row was built
        // from something other than the replay API.
        if (refreshTokenId === "") throwErr("Session replay row has no refreshTokenId, so its analytics events can't be looked up", { replayId });
        // The three queries describe unrelated facets of the session, so a failure
        // in one (a geo lookup timing out, say) shouldn't hide the other two.
        const results = await Promise.allSettled([
          serverApp.queryAnalytics({
            query: ENTRY_PAGE_VIEW_QUERY,
            params: { replayId },
            include_all_branches: false,
            timeout_ms: 15_000,
          }),
          serverApp.queryAnalytics({
            query: ACTIVITY_COUNTS_QUERY,
            params: { replayId },
            include_all_branches: false,
            timeout_ms: 15_000,
          }),
          serverApp.queryAnalytics({
            query: SESSION_GEO_QUERY,
            params: {
              refreshTokenId,
              startedAtMillis: startedAtMs,
            },
            include_all_branches: false,
            timeout_ms: 15_000,
          }),
        ]);
        if (cancelled) return;

        const queryNames = ["entry-page-view", "activity-counts", "session-geo"] as const;
        const rejections: unknown[] = [];
        for (const [index, result] of results.entries()) {
          if (result.status === "rejected") {
            rejections.push(result.reason);
            captureError(`replay-user-overview-query:${queryNames[index]}`, result.reason);
          }
        }
        // Only a total failure is worth telling the operator about; a single
        // missing facet just renders one fewer fact.
        if (rejections.length === results.length) {
          setState({ status: "error", error: rejections[0] });
          return;
        }

        const [entryRes, countsRes, geoRes] = results;
        // `.at(0)` rather than `[0]`: an empty result set is the normal case for
        // replays whose project doesn't send analytics events.
        const entry = entryRes.status === "fulfilled" ? entryRes.value.result.at(0) ?? null : null;
        const counts = countsRes.status === "fulfilled" ? countsRes.value.result.at(0) ?? null : null;
        const geoRow = geoRes.status === "fulfilled" ? geoRes.value.result.at(0) ?? null : null;
        const geo: ReplayGeo | null = geoRow === null ? null : {
          countryCode: toStringOrNull(geoRow.country_code),
          regionCode: toStringOrNull(geoRow.region_code),
          cityName: toStringOrNull(geoRow.city_name),
          tzIdentifier: toStringOrNull(geoRow.tz_identifier),
        };

        setState({
          status: "success",
          context: {
            userAgent: entry === null ? null : toStringOrNull(entry.user_agent),
            entryPath: entry === null ? null : toStringOrNull(entry.entry_path),
            referrer: entry === null ? null : toStringOrNull(entry.referrer),
            screenWidth: entry === null ? null : toNumberOrNull(entry.screen_width),
            screenHeight: entry === null ? null : toNumberOrNull(entry.screen_height),
            viewportWidth: entry === null ? null : toNumberOrNull(entry.viewport_width),
            viewportHeight: entry === null ? null : toNumberOrNull(entry.viewport_height),
            activity: counts === null ? null : { pageViews: parseCount(counts.page_views), clicks: parseCount(counts.clicks) },
            geo: geo !== null && geo.countryCode === null && geo.cityName === null ? null : geo,
          },
        });
      } catch (error) {
        // Not the rejected-query path above (those are captured individually);
        // this is a bug in the overview itself, so it must reach Sentry.
        captureError("replay-user-overview", error);
        if (cancelled) return;
        setState({ status: "error", error });
      }
    }, { noErrorLogging: true });
    return () => {
      cancelled = true;
    };
  }, [refreshTokenId, replayId, serverApp, startedAtMs]);

  return state;
}

const DEVICE_ICONS = new Map<UserAgentDeviceType, Icon>([
  ["desktop", DesktopIcon],
  ["mobile", DeviceMobileIcon],
  ["tablet", DeviceTabletIcon],
  ["bot", RobotIcon],
]);

function Fact({ icon, label, tooltip, children, className }: {
  icon: Icon,
  /** Screen-reader/tooltip name of the fact; the value itself is what's rendered. */
  label: string,
  tooltip?: React.ReactNode,
  children: React.ReactNode,
  className?: string,
}) {
  const IconComponent = icon;
  const content = (
    // The icon is decorative, so the label is the only thing naming the value
    // for a screen reader ("Location: Berlin, Germany" instead of a bare city).
    <span aria-label={label} className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <IconComponent className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <span className="truncate text-[11px] text-foreground/90">{children}</span>
    </span>
  );
  return (
    <SimpleTooltip inline tooltip={tooltip ?? label} className="min-w-0 max-w-full">
      {content}
    </SimpleTooltip>
  );
}

function FactSeparator() {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-foreground/[0.12]" />;
}

function RelativeTime({ date }: { date: Date }) {
  return <>{useFromNow(date)}</>;
}

function formatLocalTime(date: Date, timeZone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit", timeZone }).format(date);
  } catch {
    // An unknown IANA zone from an old event shouldn't take down the header.
    return null;
  }
}

function formatLocation(geo: ReplayGeo): string | null {
  const parts = [geo.cityName, geo.countryCode === null ? null : regionName(geo.countryCode)].filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

function getUserInitials(user: ServerUser): string {
  const source = user.displayName ?? user.primaryEmail ?? user.id;
  const words = source.split(/[\s@._-]+/).filter((w) => w !== "");
  const initials = words.slice(0, 2).map((w) => w.slice(0, 1)).join("");
  return (initials === "" ? source.slice(0, 2) : initials).toUpperCase();
}

/** Auth methods the user can sign in with, eg. `Google, Password`. */
function useAuthMethods(user: ServerUser): string[] {
  const oauthProviders = user.useOAuthProviders();
  return useMemo(() => {
    const methods: string[] = [];
    for (const provider of oauthProviders) {
      if (!provider.allowSignIn) continue;
      const label = provider.type.charAt(0).toUpperCase() + provider.type.slice(1);
      if (!methods.includes(label)) methods.push(label);
    }
    if (user.hasPassword) methods.push("Password");
    if (user.passkeyAuthEnabled) methods.push("Passkey");
    if (user.otpAuthEnabled) methods.push("Email code");
    return methods;
  }, [oauthProviders, user.hasPassword, user.otpAuthEnabled, user.passkeyAuthEnabled]);
}

function UserBadges({ user, deviceType }: { user: ServerUser, deviceType: UserAgentDeviceType | null }) {
  return (
    <>
      {user.isAnonymous && <DesignBadge label="Anonymous" color="orange" size="sm" />}
      {user.isRestricted && (
        <DesignBadge
          label={user.restrictedByAdmin ? "Restricted by admin" : "Restricted"}
          color="red"
          size="sm"
          icon={WarningCircleIcon}
        />
      )}
      {user.isMultiFactorRequired && <DesignBadge label="2FA" color="blue" size="sm" icon={KeyIcon} />}
      {deviceType === "bot" && <DesignBadge label="Bot UA" color="purple" size="sm" icon={RobotIcon} />}
      {user.riskScores.signUp.bot >= 50 && (
        <DesignBadge label={`Bot risk ${user.riskScores.signUp.bot}`} color="red" size="sm" icon={RobotIcon} />
      )}
    </>
  );
}

function SessionFacts({ replay, state, deviceType }: {
  replay: ReplayUserOverviewReplay,
  state: SessionContextState,
  deviceType: UserAgentDeviceType | null,
}) {
  const durationMs = replay.lastEventAt.getTime() - replay.startedAt.getTime();

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-24" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <SimpleTooltip
        inline
        tooltip={`Couldn't load the device, location and referrer for this session: ${state.error instanceof Error ? state.error.message : String(state.error)}`}
      >
        <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <WarningCircleIcon className="h-3.5 w-3.5" aria-hidden />
          Session context unavailable
        </span>
      </SimpleTooltip>
    );
  }

  const context = state.context;
  const device = context.userAgent === null ? null : describeUserAgent(context.userAgent);
  // An entirely unrecognized user agent leaves both halves null; joining those
  // would give an empty string, which would render as an icon with no text.
  const deviceParts = device === null ? [] : [device.browser, device.os].filter((p): p is string => p !== null);
  const deviceLabel = deviceParts.length === 0 ? null : deviceParts.join(" on ");
  const screenLabel = context.screenWidth !== null && context.screenHeight !== null
    ? `${context.screenWidth}×${context.screenHeight}`
    : null;
  const viewportLabel = context.viewportWidth !== null && context.viewportHeight !== null
    ? `${context.viewportWidth}×${context.viewportHeight}`
    : null;
  const location = context.geo === null ? null : formatLocation(context.geo);
  const localTime = context.geo?.tzIdentifier == null
    ? null
    : formatLocalTime(replay.startedAt, context.geo.tzIdentifier);
  const referrerHost = context.referrer === null ? null : getReferrerHost(context.referrer);

  // Without the counts we only know the duration; showing "0 pages" would
  // claim the visitor never loaded anything.
  const activityParts = [
    formatDurationMs(durationMs),
    ...context.activity === null ? [] : [
      `${context.activity.pageViews} ${context.activity.pageViews === 1 ? "page" : "pages"}`,
      `${context.activity.clicks} ${context.activity.clicks === 1 ? "click" : "clicks"}`,
    ],
  ];

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <Fact
        icon={ClockIcon}
        label="This session"
        tooltip={`Session started ${replay.startedAt.toLocaleString()}${context.activity === null ? " (page and click counts unavailable)" : ""}`}
      >
        {activityParts.join(" · ")}
      </Fact>

      {(deviceLabel !== null || deviceType !== null) && (
        <>
          <FactSeparator />
          <Fact
            icon={(deviceType === null ? null : DEVICE_ICONS.get(deviceType)) ?? DesktopIcon}
            label="Device"
            tooltip={context.userAgent ?? "Device unknown"}
          >
            {deviceLabel ?? "Unknown browser"}
            {screenLabel !== null && <span className="text-muted-foreground"> · {screenLabel}</span>}
          </Fact>
        </>
      )}

      {viewportLabel !== null && (
        <>
          <FactSeparator />
          <Fact icon={DesktopIcon} label="Window size at session start">
            <span className="text-muted-foreground">window</span> {viewportLabel}
          </Fact>
        </>
      )}

      {location !== null && context.geo !== null && (
        <>
          <FactSeparator />
          <Fact
            icon={MapPinIcon}
            label="Location"
            tooltip={`Approximate location from the IP address used during this session${context.geo.regionCode === null ? "" : ` (${context.geo.regionCode})`}`}
          >
            <span className="inline-flex items-center gap-1.5">
              {context.geo.countryCode !== null && <CountryFlag code={context.geo.countryCode} />}
              {location}
              {localTime !== null && <span className="text-muted-foreground">· {localTime} local</span>}
            </span>
          </Fact>
        </>
      )}

      <FactSeparator />
      <Fact
        icon={ArrowUUpLeftIcon}
        label="Came from"
        tooltip={context.referrer ?? "No referrer — the visitor arrived directly"}
      >
        {referrerHost === null ? (
          <span className="text-muted-foreground">Direct traffic</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <ReferrerFavicon host={referrerHost} />
            {referrerHost}
          </span>
        )}
      </Fact>

      {context.entryPath !== null && (
        <>
          <FactSeparator />
          <Fact icon={FileHtmlIcon} label="Landed on" tooltip={`First page of the session: ${context.entryPath}`}>
            <span className="font-mono">{context.entryPath}</span>
          </Fact>
        </>
      )}
    </div>
  );
}

function AccountFacts({ user }: { user: ServerUser }) {
  const authMethods = useAuthMethods(user);
  const teams = user.useTeams();

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <Fact icon={SignInIcon} label="Signed up" tooltip={`Signed up ${user.signedUpAt.toLocaleString()}`}>
        <span className="text-muted-foreground">signed up</span> <RelativeTime date={user.signedUpAt} />
      </Fact>
      <FactSeparator />
      <Fact icon={ClockIcon} label="Last active" tooltip={`Last active ${user.lastActiveAt.toLocaleString()}`}>
        <span className="text-muted-foreground">last active</span> <RelativeTime date={user.lastActiveAt} />
      </Fact>
      {authMethods.length > 0 && (
        <>
          <FactSeparator />
          <Fact icon={KeyIcon} label="Sign-in methods">
            {authMethods.join(", ")}
          </Fact>
        </>
      )}
      {teams.length > 0 && (
        <>
          <FactSeparator />
          <Fact icon={UsersThreeIcon} label="Teams" tooltip={teams.map((t) => t.displayName).join(", ")}>
            {teams.length === 1 ? teams[0]!.displayName : `${teams.length} teams`}
          </Fact>
        </>
      )}
      <FactSeparator />
      <Fact icon={IdentificationCardIcon} label="User ID" tooltip={user.id}>
        <span className="font-mono">{user.id.slice(0, 8)}…</span>
      </Fact>
      <CopyButton content={user.id} className="h-5 w-5 p-0.5" aria-label="Copy user ID" />
    </div>
  );
}

function OverviewShell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>;
}

export function ReplayUserOverviewSkeleton() {
  return (
    <OverviewShell>
      <div className="flex items-center gap-2.5">
        <Skeleton className="h-9 w-9 rounded-full" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
      </div>
      <Skeleton className="h-3 w-full max-w-lg" />
    </OverviewShell>
  );
}

/**
 * Header of the session replay player: everything you'd want to know about the
 * person you're watching without leaving the replay. Account facts come from
 * the user itself; the device, location and referrer are session-specific and
 * come from the analytics events recorded alongside this replay.
 *
 * Suspends while the user loads — render inside a `<Suspense>` boundary with
 * `<ReplayUserOverviewSkeleton />` as the fallback.
 */
export function ReplayUserOverview({ replay }: { replay: ReplayUserOverviewReplay }) {
  const adminApp = useAdminApp();
  const user = adminApp.useUser(replay.userId);
  const sessionContext = useReplaySessionContext(replay);

  const deviceType = sessionContext.status === "success" && sessionContext.context.userAgent !== null
    ? describeUserAgent(sessionContext.context.userAgent).deviceType
    : null;

  if (user === null) {
    // Replays outlive their user: the account can be deleted while the
    // recording is still around, so this is an expected state, not an error.
    return (
      <OverviewShell>
        <Typography className="truncate text-sm font-medium">Deleted user</Typography>
        <span className="truncate font-mono text-[11px] text-muted-foreground">{replay.userId}</span>
        <SessionFacts replay={replay} state={sessionContext} deviceType={deviceType} />
      </OverviewShell>
    );
  }

  const profileHref = `/projects/${encodeURIComponent(adminApp.projectId)}/users/${encodeURIComponent(user.id)}`;

  return (
    <OverviewShell>
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar className="h-9 w-9 shrink-0">
          {user.profileImageUrl !== null && <AvatarImage src={user.profileImageUrl} alt="" />}
          <AvatarFallback className="text-[11px] font-medium">{getUserInitials(user)}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <StyledLink href={profileHref} className="truncate text-sm font-medium">
              {user.displayName ?? user.primaryEmail ?? "Unnamed user"}
            </StyledLink>
            <UserBadges user={user} deviceType={deviceType} />
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            {user.primaryEmail === null ? (
              <span className="text-[11px] text-muted-foreground">No email address</span>
            ) : (
              <>
                <a
                  href={`mailto:${encodeURIComponent(user.primaryEmail)}`}
                  className="truncate text-[11px] text-muted-foreground transition-colors duration-150 hover:text-foreground hover:transition-none"
                >
                  {user.primaryEmail}
                </a>
                <SimpleTooltip inline tooltip={user.primaryEmailVerified ? "Email verified" : "Email not verified"}>
                  {user.primaryEmailVerified ? (
                    <CheckCircleIcon className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" aria-hidden />
                  ) : (
                    <WarningCircleIcon className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" aria-hidden />
                  )}
                </SimpleTooltip>
              </>
            )}
          </div>
        </div>
      </div>

      <SessionFacts replay={replay} state={sessionContext} deviceType={deviceType} />
      {/* Own boundary: the teams/OAuth providers of the user load separately, and
          suspending them here keeps the already-rendered facts above on screen. */}
      <React.Suspense fallback={<Skeleton className="h-3 w-64" />}>
        <AccountFacts user={user} />
      </React.Suspense>
    </OverviewShell>
  );
}
