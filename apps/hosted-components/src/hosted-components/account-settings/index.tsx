import { Skeleton, cn } from "~/components/ui";
import { Bell, Contact, CreditCard, Key, Monitor, PlusCircle, Settings, ShieldCheck, Users } from "lucide-react";
import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Team, useStackApp, useUser } from "@hexclave/react";
import { AccountDeletionBoundary, type DeleteAccountCallback } from "./account-deletion-boundary";
import { HostedFullPage } from "./hosted-full-page";
import { SidebarLayout, useHash } from './sidebar-layout';
import { ProfilePage } from "./profile-page/profile-page";
import { SettingsPage } from './settings/settings-page';
import { TeamIcon } from "./supporting/team-icon";
import { findTeamsWithProducts, firstTeamsPageOptions } from "@hexclave/shared/dist/utils/team-lists";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";

const iconMap = {
  Contact,
  ShieldCheck,
  Bell,
  Monitor,
  Key,
  Settings,
  CreditCard,
  Plus: PlusCircle,
  Users,
} as const;

const Icon = ({ name }: { name: keyof typeof iconMap }) => {
  const LucideIcon = iconMap[name];
  return <LucideIcon className="h-4 w-4 shrink-0" />;
};

const emptyTeams: Team[] & { nextCursor: string | null } = Object.assign([], { nextCursor: null });

const EmailsAndAuthPage = React.lazy(async () => ({
  default: (await import("./email-and-auth/email-and-auth-page")).EmailsAndAuthPage,
}));

const NotificationsPage = React.lazy(async () => ({
  default: (await import("./notifications/notifications-page")).NotificationsPage,
}));

const ActiveSessionsPage = React.lazy(async () => ({
  default: (await import("./active-sessions/active-sessions-page")).ActiveSessionsPage,
}));

const ApiKeysPage = React.lazy(async () => ({
  default: (await import("./api-keys/api-keys-page")).ApiKeysPage,
}));

const PaymentsPage = React.lazy(async () => ({
  default: (await import("./payments/payments-page")).PaymentsPage,
}));

const TeamPage = React.lazy(async () => ({
  default: (await import("./teams/team-page")).TeamPage,
}));

const TeamDirectoryPage = React.lazy(async () => ({
  default: (await import("./teams/team-directory-page")).TeamDirectoryPage,
}));

const TeamCreationPage = React.lazy(async () => ({
  default: (await import("./teams/team-creation-page")).TeamCreationPage,
}));

type HostedAccountSettingsProps = {
  fullPage?: boolean,
  mockUser?: {
    displayName?: string,
    profileImageUrl?: string,
  },
  mockApiKeys?: Array<{
    id: string,
    description: string,
    createdAt: string,
    expiresAt?: string,
    manuallyRevokedAt?: string,
  }>,
  mockProject?: {
    config: {
      allowUserApiKeys: boolean,
      clientTeamCreationEnabled?: boolean,
      clientUserDeletionEnabled?: boolean,
    },
  },
  mockSessions?: Array<{
    id: string,
    isCurrentSession: boolean,
    isImpersonation?: boolean,
    createdAt: string,
    lastUsedAt?: string,
    geoInfo?: {
      ip?: string,
      cityName?: string,
    },
  }>,
};

export function HostedAccountSettings(props: HostedAccountSettingsProps) {
  return (
    <AccountDeletionBoundary>
      {(onDeleteAccount) => (
        <AuthenticatedAccountSettings {...props} onDeleteAccount={onDeleteAccount} />
      )}
    </AccountDeletionBoundary>
  );
}

function AuthenticatedAccountSettings(props: HostedAccountSettingsProps & {
  onDeleteAccount: DeleteAccountCallback,
}) {
  const userFromHook = useUser({ or: props.mockUser ? 'return-null' : 'redirect' });
  const stackApp = useStackApp();
  const projectFromHook = stackApp.useProject();

  const user = props.mockUser ? null : userFromHook;
  const project = props.mockProject || projectFromHook;

  const teams = user?.useTeams(firstTeamsPageOptions) ?? emptyTeams;
  // The sidebar only lists the first (capped) page of teams. A `#team-<id>` link to any other team (e.g. from the
  // team switcher, or the "All teams" page) is resolved by ID so its page still opens. The lookup hook is always
  // called; without a lookup it reuses the unfiltered cache entry, so it costs no extra request.
  const hash = useHash();
  const hashTeamId = hash.startsWith("team-") && hash !== "team-creation" ? hash.slice("team-".length) : null;
  const needsHashTeamLookup = hashTeamId != null && teams.nextCursor != null && !teams.some(team => team.id === hashTeamId);
  const hashTeamLookup = user?.useTeams(needsHashTeamLookup ? { query: hashTeamId, limit: firstTeamsPageOptions.limit } : firstTeamsPageOptions) ?? emptyTeams;
  const hashTeamOutsideSidebar = needsHashTeamLookup ? hashTeamLookup.find(team => team.id === hashTeamId) ?? null : null;
  const sidebarTeams = hashTeamOutsideSidebar == null ? teams : [...teams, hashTeamOutsideSidebar];
  const teamsKey = teams.map(team => team.id).join("|");
  // useTeams() may return a fresh array on each render; key by IDs so product checks do not refire unnecessarily.
  const teamsById = useMemo(() => teams, [teamsKey]);
  const userRef = useRef(userFromHook ?? null);
  const userId = userFromHook?.id ?? null;

  const [paymentsAvailability, setPaymentsAvailability] = useState<{
    userHasProducts: boolean,
    teamsWithProducts: Team[],
    isReady: boolean,
  }>(() => ({
    userHasProducts: false,
    teamsWithProducts: [],
    isReady: !!props.mockUser,
  }));

  useEffect(() => {
    userRef.current = userFromHook ?? null;
  }, [userFromHook]);

  useEffect(() => {
    if (props.mockUser || !userId) {
      return;
    }
    let cancelled = false;
    runAsynchronouslyWithAlert(async () => {
      const currentUser = userRef.current;
      if (!currentUser || currentUser.id !== userId) {
        return;
      }
      const [userProducts, teamsWithProducts] = await Promise.all([
        currentUser.listProducts({ limit: 1 }),
        findTeamsWithProducts(currentUser, teamsById),
      ]);
      if (cancelled) {
        return;
      }
      const userHasProducts = userProducts.some((product) => product.customerType === "user");
      setPaymentsAvailability({
        userHasProducts,
        teamsWithProducts,
        isReady: true,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [props.mockUser, teamsById, userId]);

  const teamsWithProducts = paymentsAvailability.teamsWithProducts;

  const shouldShowPaymentsTab = props.mockUser
    || !paymentsAvailability.isReady
    || paymentsAvailability.userHasProducts
    || teamsWithProducts.length > 0;

  if (!props.mockUser && !userFromHook) {
    return null;
  }

  const sidebarItems = [
    {
      title: 'My Profile',
      type: 'item' as const,
      id: 'profile',
      icon: <Icon name="Contact"/>,
      content: <ProfilePage mockUser={props.mockUser}/>,
    },
    {
      title: 'Emails & Auth',
      type: 'item' as const,
      id: 'auth',
      icon: <Icon name="ShieldCheck"/>,
      content: <Suspense fallback={<EmailsAndAuthPageSkeleton/>}>
        <EmailsAndAuthPage mockMode={!!props.mockUser}/>
      </Suspense>,
    },
    {
      title: 'Notifications',
      type: 'item' as const,
      id: 'notifications',
      icon: <Icon name="Bell"/>,
      content: <Suspense fallback={<NotificationsPageSkeleton/>}>
        <NotificationsPage/>
      </Suspense>,
    },
    {
      title: 'Active Sessions',
      type: 'item' as const,
      id: 'sessions',
      icon: <Icon name="Monitor"/>,
      content: <Suspense fallback={<ActiveSessionsPageSkeleton/>}>
        <ActiveSessionsPage mockSessions={props.mockSessions} mockMode={!!props.mockUser}/>
      </Suspense>,
    },
    ...(project.config.allowUserApiKeys ? [{
      title: 'API Keys',
      type: 'item' as const,
      id: 'api-keys',
      icon: <Icon name="Key" />,
      content: <Suspense fallback={<ApiKeysPageSkeleton/>}>
        <ApiKeysPage mockApiKeys={props.mockApiKeys} mockMode={!!props.mockUser} />
      </Suspense>,
    }] as const : []),
    ...(shouldShowPaymentsTab ? [{
      title: 'Payments',
      type: 'item' as const,
      id: 'payments',
      icon: <Icon name="CreditCard" />,
      content: <Suspense fallback={<PaymentsPageSkeleton/>}>
        {!paymentsAvailability.isReady && !props.mockUser ? (
          <PaymentsPageSkeleton />
        ) : (
          <PaymentsPage
            mockMode={!!props.mockUser}
            allowPersonal={paymentsAvailability.userHasProducts}
            availableTeams={teamsWithProducts}
          />
        )}
      </Suspense>,
    }] as const : []),
    {
      title: 'Settings',
      type: 'item' as const,
      id: 'settings',
      icon: <Icon name="Settings"/>,
      content: (
        <SettingsPage
          mockMode={!!props.mockUser}
          showDeleteSection={!!props.mockUser || project.config.clientUserDeletionEnabled === true}
          onDeleteAccount={async () => {
            if (userFromHook == null) {
              throw new Error("Cannot delete an account without an authenticated user");
            }
            await props.onDeleteAccount(() => userFromHook.delete());
          }}
        />
      ),
    },
    ...( (teams.length > 0 || project.config.clientTeamCreationEnabled) ? [{
      title: 'Teams',
      type: 'divider' as const,
    }] as const : [] ),
    ...sidebarTeams.map(team => ({
      title: (
        <div className="flex gap-2 items-center w-full min-w-0">
          <TeamIcon team={team}/>
          <span className="truncate max-w-[140px] md:max-w-[200px] text-sm font-medium">{team.displayName}</span>
        </div>
      ),
      type: 'item' as const,
      id: `team-${team.id}`,
      content: <Suspense fallback={<TeamPageSkeleton/>}>
        <TeamPage team={team}/>
      </Suspense>,
    } as const)),
    ...( teams.nextCursor != null ? [{
      title: 'All teams',
      icon: <Icon name="Users"/>,
      type: 'item' as const,
      id: 'teams',
      content: <Suspense fallback={<TeamPageSkeleton/>}>
        <TeamDirectoryPage />
      </Suspense>,
    }] as const : [] ),
    ...( project.config.clientTeamCreationEnabled ? [{
      title: 'Create a team',
      icon: <Icon name="Plus"/>,
      type: 'item' as const,
      id: 'team-creation',
      content: <Suspense fallback={<TeamCreationSkeleton/>}>
        <TeamCreationPage mockMode={!!props.mockUser} />
      </Suspense>,
    }] as const : [] ),
  ].filter(p => p.type === 'divider' || (p as any).content);

  return (
    <HostedFullPage fullPage={props.fullPage}>
      <SidebarLayout
        items={sidebarItems as any}
        title="Account Settings"
      />
    </HostedFullPage>
  );
}

function PageLayout(props: { children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-4'>
      {props.children}
    </div>
  );
}

function SkeletonLine(props: { className?: string }) {
  return <Skeleton className={cn("max-w-full", props.className ?? "h-3 w-40 rounded-full")} />;
}

function SkeletonCell(props: { children: React.ReactNode, align?: "start" | "end" | "center" }) {
  return (
    <div className={cn(
      "flex min-w-0 items-center",
      props.align === "end" ? "justify-end" : props.align === "center" ? "justify-center" : "justify-start",
    )}>
      {props.children}
    </div>
  );
}

function SkeletonHeader(props?: { action?: boolean }) {
  return (
    <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
      <div className="space-y-2 flex-1 min-w-0">
        <SkeletonLine className="h-4 w-36 rounded-full" />
        <SkeletonLine className="h-3 w-full max-w-[380px] rounded-full" />
      </div>
      {props?.action && (
        <div className="flex w-full justify-center md:w-auto md:justify-end">
          <Skeleton className="h-8 w-32 rounded-lg shrink-0" />
        </div>
      )}
    </div>
  );
}

function SkeletonSection(props?: { right?: "button" | "switch" | "text" }) {
  return (
    <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white/45 dark:bg-zinc-950/30 p-5">
      <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
        <div className="space-y-2 flex-1 min-w-0">
          <SkeletonLine className="h-4 w-32 rounded-full" />
          <SkeletonLine className="h-3 w-full max-w-[320px] rounded-full" />
        </div>
        <div className="flex w-full justify-center md:w-[350px] md:justify-center">
          {props?.right === "switch" ? (
            <Skeleton className="h-5 w-9 rounded-full shrink-0" />
          ) : props?.right === "text" ? (
            <SkeletonLine className="h-3 w-44 rounded-full" />
          ) : (
            <Skeleton className="h-9 w-[160px] rounded-lg shrink-0" />
          )}
        </div>
      </div>
    </div>
  );
}

function SkeletonListRow(props?: { icon?: boolean, action?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-black/[0.05] dark:border-white/[0.06] last:border-b-0">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {props?.icon && <Skeleton className="size-8 rounded-lg shrink-0" />}
        <div className="space-y-2 min-w-0 flex-1">
          <SkeletonLine className="h-3.5 w-full max-w-[220px] rounded-full" />
          <SkeletonLine className="h-2.5 w-full max-w-[150px] rounded-full" />
        </div>
      </div>
      {props?.action && <Skeleton className="size-8 rounded-lg shrink-0" />}
    </div>
  );
}

function SkeletonTable(props?: { rows?: number, columns?: number, toolbar?: boolean }) {
  const rows = props?.rows ?? 3;
  const columns = props?.columns ?? 4;
  return (
    <div className="space-y-4">
      {props?.toolbar && (
        <div className="flex flex-wrap justify-between gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap gap-2">
            <Skeleton className="h-8 w-[250px] max-w-full rounded-lg" />
            <Skeleton className="h-8 w-24 max-w-full rounded-lg" />
          </div>
          <Skeleton className="h-8 w-20 max-w-full shrink-0 rounded-lg" />
        </div>
      )}
      <div className="rounded-xl border border-black/[0.07] dark:border-white/[0.08] bg-white/40 dark:bg-zinc-950/25 overflow-hidden">
        <div className="grid items-center gap-3 px-4 py-3 border-b border-black/[0.06] dark:border-white/[0.06]" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {Array.from({ length: columns }).map((_, index) => (
            <SkeletonCell key={index} align={index === columns - 1 ? "end" : "start"}>
              <SkeletonLine className="h-2.5 w-full max-w-20 rounded-full" />
            </SkeletonCell>
          ))}
        </div>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <div key={rowIndex} className="grid items-center gap-3 px-4 py-4 border-b border-black/[0.04] dark:border-white/[0.04] last:border-b-0" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
            {Array.from({ length: columns }).map((_, columnIndex) => (
              <SkeletonCell key={columnIndex} align={columnIndex === columns - 1 ? "end" : "start"}>
                <SkeletonLine className={columnIndex === 0 ? "h-3.5 w-full max-w-28 rounded-full" : "h-3.5 w-full max-w-20 rounded-full"} />
              </SkeletonCell>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmailsAndAuthPageSkeleton() {
  return (
    <PageLayout>
      <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white/45 dark:bg-zinc-950/30 p-5 flex flex-col gap-5">
        <SkeletonHeader action />
        <div className="overflow-hidden rounded-xl border border-black/[0.06] dark:border-white/[0.07] bg-zinc-50/35 dark:bg-zinc-900/20">
          <SkeletonListRow icon action />
          <SkeletonListRow icon action />
        </div>
      </div>
      <SkeletonSection />
      <SkeletonSection />
      <SkeletonSection />
      <SkeletonSection />
    </PageLayout>
  );
}

function ActiveSessionsPageSkeleton() {
  return (
    <PageLayout>
      <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white/45 dark:bg-zinc-950/30 p-5 flex flex-col gap-5">
        <SkeletonHeader action />
        <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.07] bg-zinc-50/50 dark:bg-zinc-900/25 p-4">
          <SkeletonTable rows={2} columns={5} />
        </div>
      </div>
    </PageLayout>
  );
}

function ApiKeysPageSkeleton() {
  return (
    <PageLayout>
      <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white/45 dark:bg-zinc-950/30 p-5 flex flex-col gap-5">
        <SkeletonHeader action />
        <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.07] bg-zinc-50/50 dark:bg-zinc-900/25 p-4">
          <SkeletonTable rows={3} columns={5} toolbar />
        </div>
      </div>
    </PageLayout>
  );
}

function NotificationsPageSkeleton() {
  return (
    <PageLayout>
      <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white/45 dark:bg-zinc-950/30 p-5 flex flex-col gap-5">
        <SkeletonHeader />
        <div className="flex flex-col">
          <SkeletonListRow action />
          <SkeletonListRow action />
          <SkeletonListRow action />
        </div>
      </div>
    </PageLayout>
  );
}

function PaymentsPageSkeleton() {
  return (
    <PageLayout>
      <Skeleton className="h-9 w-[240px] rounded-lg" />
      <SkeletonSection right="text" />
      <SkeletonSection right="button" />
      <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white/45 dark:bg-zinc-950/30 p-5 flex flex-col gap-5">
        <SkeletonHeader />
        <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.07] bg-zinc-50/50 dark:bg-zinc-900/25 p-4">
          <SkeletonTable rows={3} columns={3} />
        </div>
      </div>
    </PageLayout>
  );
}

function TeamPageSkeleton() {
  return (
    <PageLayout>
      <SkeletonSection />
      <SkeletonSection />
      <SkeletonSection />
      <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white/45 dark:bg-zinc-950/30 p-5 flex flex-col gap-5">
        <SkeletonHeader />
        <div className="rounded-xl border border-black/[0.06] dark:border-white/[0.07] bg-zinc-50/50 dark:bg-zinc-900/25 p-4">
          <SkeletonTable rows={3} columns={4} />
        </div>
      </div>
      <SkeletonSection />
      <SkeletonSection />
    </PageLayout>
  );
}

function TeamCreationSkeleton() {
  return (
    <PageLayout>
      <div className="rounded-2xl border border-black/[0.07] dark:border-white/[0.08] bg-white/45 dark:bg-zinc-950/30 p-5">
        <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
          <div className="space-y-2 flex-1 min-w-0">
            <SkeletonLine className="h-4 w-32 rounded-full" />
            <SkeletonLine className="h-3 w-full max-w-[260px] rounded-full" />
          </div>
          <div className="flex gap-2 w-full md:w-[350px]">
            <Skeleton className="h-9 min-w-0 flex-1 rounded-lg" />
            <Skeleton className="h-9 w-20 rounded-lg" />
          </div>
        </div>
      </div>
    </PageLayout>
  );
}
