'use client';

import { Skeleton } from "@/components/ui/skeleton";
import {
  UserCircle,
  ShieldCheck,
  Bell,
  Monitor,
  Key,
  Gear,
  CreditCard,
  Plus,
  UsersThree,
} from "@phosphor-icons/react";
import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Team, useStackApp, useUser } from "@hexclave/next";
import { SidebarLayout, useHash } from './sidebar-layout';
import { ActiveSessionsPage } from "./active-sessions/active-sessions-page";
import { ApiKeysPage } from "./api-keys/api-keys-page";
import { EmailsAndAuthPage } from './email-and-auth/email-and-auth-page';
import { NotificationsPage } from './notifications/notifications-page';
import { ProfilePage } from "./profile-page/profile-page";
import { SettingsPage } from './settings/settings-page';
import { PaymentsPage } from "./payments/payments-page";
import { TeamPage } from "./teams/team-page";
import { TeamCreationPage } from "./teams/team-creation-page";
import { TeamDirectoryPage } from "./teams/team-directory-page";
import { TeamIcon } from "./supporting/team-icon";
import { findTeamsWithProducts, firstTeamsPageOptions } from "@hexclave/shared/dist/utils/team-lists";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";

const iconMap = {
  Contact: UserCircle,
  ShieldCheck,
  Bell,
  Monitor,
  Key,
  Settings: Gear,
  CreditCard,
  Plus,
  Users: UsersThree,
} as const;

const Icon = ({ name }: { name: keyof typeof iconMap }) => {
  const PhosphorIcon = iconMap[name];
  return <PhosphorIcon className="h-4 w-4 shrink-0" />;
};

const emptyTeams: Team[] & { nextCursor: string | null } = Object.assign([], { nextCursor: null });

export function DashboardAccountSettingsPage(props: {
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    || (paymentsAvailability.isReady
      && (paymentsAvailability.userHasProducts || teamsWithProducts.length > 0));

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
        <PaymentsPage
          mockMode={!!props.mockUser}
          allowPersonal={paymentsAvailability.userHasProducts}
          availableTeams={teamsWithProducts}
        />
      </Suspense>,
    }] as const : []),
    {
      title: 'Settings',
      type: 'item' as const,
      id: 'settings',
      icon: <Icon name="Settings"/>,
      content: <SettingsPage mockMode={!!props.mockUser}/>,
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
      content: <Suspense fallback={<TeamDirectorySkeleton/>}>
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
    <div className="flex-grow w-full max-w-7xl mx-auto px-4 md:px-8 py-8 flex flex-col">
      <SidebarLayout
        items={sidebarItems as any}
        title="Account Settings"
      />
    </div>
  );
}

function PageLayout(props: { children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-6'>
      {props.children}
    </div>
  );
}

function EmailsAndAuthPageSkeleton() {
  return (
    <PageLayout>
      <Skeleton className="h-[120px] w-full rounded-2xl" />
      <Skeleton className="h-[120px] w-full rounded-2xl" />
      <Skeleton className="h-[120px] w-full rounded-2xl" />
    </PageLayout>
  );
}

function ActiveSessionsPageSkeleton() {
  return (
    <PageLayout>
      <Skeleton className="h-[250px] w-full rounded-2xl" />
    </PageLayout>
  );
}

function ApiKeysPageSkeleton() {
  return (
    <PageLayout>
      <Skeleton className="h-[250px] w-full rounded-2xl" />
    </PageLayout>
  );
}

function NotificationsPageSkeleton() {
  return (
    <PageLayout>
      <Skeleton className="h-[200px] w-full rounded-2xl" />
    </PageLayout>
  );
}

function PaymentsPageSkeleton() {
  return (
    <PageLayout>
      <Skeleton className="h-[350px] w-full rounded-2xl" />
    </PageLayout>
  );
}

function TeamPageSkeleton() {
  return (
    <PageLayout>
      <Skeleton className="h-[150px] w-full rounded-2xl" />
      <Skeleton className="h-[250px] w-full rounded-2xl" />
    </PageLayout>
  );
}

function TeamDirectorySkeleton() {
  return (
    <PageLayout>
      <Skeleton className="h-[250px] w-full rounded-2xl" />
    </PageLayout>
  );
}

function TeamCreationSkeleton() {
  return (
    <PageLayout>
      <Skeleton className="h-[150px] w-full rounded-2xl" />
    </PageLayout>
  );
}
