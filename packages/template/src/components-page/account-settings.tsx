'use client';

import { findTeamsWithProducts, firstTeamsPageOptions } from "@hexclave/shared/dist/utils/team-lists";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { Skeleton, Typography } from '@hexclave/ui';
import { Contact, ShieldCheck, Bell, Monitor, Key, Settings, CirclePlus, CreditCard, Users } from 'lucide-react';
import React, { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Team, useStackApp, useUser } from '..';
import type { ListTeamsOptions, TeamList } from "../lib/hexclave-app/teams";
import { MaybeFullPage } from "../components/elements/maybe-full-page";
import { SidebarLayout, useHash } from '../components/elements/sidebar-layout';
import { TeamIcon } from '../components/team-icon';
import { useTranslation } from "../lib/translations";
import { ActiveSessionsPage } from "./account-settings/active-sessions/active-sessions-page";
import { ApiKeysPage } from "./account-settings/api-keys/api-keys-page";
import { EmailsAndAuthPage } from './account-settings/email-and-auth/email-and-auth-page';
import { NotificationsPage } from './account-settings/notifications/notifications-page';
import { ProfilePage } from "./account-settings/profile-page/profile-page";
import { PaymentsPage } from "./account-settings/payments/payments-page";
import { SettingsPage } from './account-settings/settings/settings-page';
import { TeamCreationPage } from './account-settings/teams/team-creation-page';
import { TeamDirectoryPage } from './account-settings/teams/team-directory-page';
import { TeamPage } from './account-settings/teams/team-page';

const iconMap = {
  Contact,
  ShieldCheck,
  Bell,
  Monitor,
  Key,
  Settings,
  CirclePlus,
  CreditCard,
  Users,
} as const;

const emptyTeamList: TeamList<Team> = Object.assign([], { nextCursor: null });

const Icon = ({ name }: { name: keyof typeof iconMap }) => {
  const LucideIcon = iconMap[name];
  return <LucideIcon className="mr-2 h-4 w-4"/>;
};

export function AccountSettings(props: {
  fullPage?: boolean,
  extraItems?: ({
    title: string,
    content: React.ReactNode,
    id: string,
  } & ({
    icon?: React.ReactNode,
  } | {
    iconName?: keyof typeof iconMap,
  }))[],
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
      clientTeamCreationEnabled: boolean,
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
  const { t } = useTranslation();
  const userFromHook = useUser({ or: props.mockUser ? 'return-null' : 'redirect' });
  const hexclaveApp = useStackApp();
  const projectFromHook = hexclaveApp.useProject();

  // Use mock data if provided, otherwise use real data
  const user = props.mockUser ? {
    useTeams: (_options?: ListTeamsOptions) => emptyTeamList, // Mock empty teams for now
    useBilling: () => ({ hasCustomer: false }), // Mock empty billing for now
  } : userFromHook;

  const project = props.mockProject || projectFromHook;
  const teams = user?.useTeams(firstTeamsPageOptions) ?? emptyTeamList;
  // The sidebar only lists the first (capped) page of teams. A `#team-<id>` link to any other team (e.g. from a
  // team switcher, or the "All teams" page) is resolved by ID so its page still opens. The lookup hook is always
  // called; without a lookup it reuses the unfiltered cache entry, so it costs no extra request.
  const hash = useHash();
  const hashTeamId = hash.startsWith("team-") && hash !== "team-creation" ? hash.slice("team-".length) : null;
  const needsHashTeamLookup = hashTeamId != null && teams.nextCursor != null && !teams.some(team => team.id === hashTeamId);
  const hashTeamLookup = user?.useTeams(needsHashTeamLookup ? { query: hashTeamId, limit: firstTeamsPageOptions.limit } : firstTeamsPageOptions) ?? emptyTeamList;
  const hashTeamOutsideSidebar = needsHashTeamLookup ? hashTeamLookup.find(team => team.id === hashTeamId) ?? null : null;
  const sidebarTeams = hashTeamOutsideSidebar == null ? teams : [...teams, hashTeamOutsideSidebar];
  const billing = user?.useBilling() || null;
  const teamsKey = useMemo(() => teams.map(team => team.id).join("|"), [teams]);
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

  // If we're not in mock mode and don't have a user, the useUser hook will handle redirect
  if (!props.mockUser && !userFromHook) {
    return null;
  }

  return (
    <MaybeFullPage fullPage={!!props.fullPage}>
      <div className="self-stretch flex-grow w-full">
        <SidebarLayout
          items={([
            {
              title: t('My Profile'),
              type: 'item',
              id: 'profile',
              icon: <Icon name="Contact"/>,
              content: <ProfilePage mockUser={props.mockUser}/>,
            },
            {
              title: t('Emails & Auth'),
              type: 'item',
              id: 'auth',
              icon: <Icon name="ShieldCheck"/>,
              content: <Suspense fallback={<EmailsAndAuthPageSkeleton/>}>
                <EmailsAndAuthPage mockMode={!!props.mockUser}/>
              </Suspense>,
            },
            {
              title: t('Notifications'),
              type: 'item',
              id: 'notifications',
              icon: <Icon name="Bell"/>,
              content: <Suspense fallback={<NotificationsPageSkeleton/>}>
                <NotificationsPage/>
              </Suspense>,
            },
            {
              title: t('Active Sessions'),
              type: 'item',
              id: 'sessions',
              icon: <Icon name="Monitor"/>,
              content: <Suspense fallback={<ActiveSessionsPageSkeleton/>}>
                <ActiveSessionsPage mockSessions={props.mockSessions} mockMode={!!props.mockUser}/>
              </Suspense>,
            },
            ...(project.config.allowUserApiKeys ? [{
              title: t('API Keys'),
              type: 'item',
              id: 'api-keys',
              icon: <Icon name="Key" />,
              content: <Suspense fallback={<ApiKeysPageSkeleton/>}>
                <ApiKeysPage mockApiKeys={props.mockApiKeys} mockMode={!!props.mockUser} />
              </Suspense>,
            }] as const : []),
            ...(shouldShowPaymentsTab ? [{
              title: t('Payments'),
              type: 'item',
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
              title: t('Settings'),
              type: 'item',
              id: 'settings',
              icon: <Icon name="Settings"/>,
              content: <SettingsPage mockMode={!!props.mockUser}/>,
            },
            ...(props.extraItems?.map(item => ({
              title: item.title,
              type: 'item',
              id: item.id,
              icon: (() => {
                const iconName = (item as any).iconName as keyof typeof iconMap | undefined;
                if (iconName) {
                  return <Icon name={iconName}/>;
                } else if ((item as any).icon) {
                  return (item as any).icon;
                }
                return null;
              })(),
              content: item.content,
            } as const)) || []),
            ...(teams.length > 0 || project.config.clientTeamCreationEnabled) ? [{
              title: t('Teams'),
              type: 'divider',
            }] as const : [],
            ...sidebarTeams.map(team => ({
              title: <div className='flex gap-2 items-center w-full'>
                <TeamIcon team={team}/>
                <Typography className="max-w-[320px] md:w-[90%] truncate">{team.displayName}</Typography>
              </div>,
              type: 'item',
              id: `team-${team.id}`,
              content: <Suspense fallback={<TeamPageSkeleton/>}>
                <TeamPage team={team}/>
              </Suspense>,
            } as const)),
            ...teams.nextCursor != null ? [{
              title: t('All teams'),
              icon: <Icon name="Users"/>,
              type: 'item',
              id: 'teams',
              content: <Suspense fallback={<TeamDirectorySkeleton/>}>
                <TeamDirectoryPage />
              </Suspense>,
            }] as const : [],
            ...project.config.clientTeamCreationEnabled ? [{
              title: t('Create a team'),
              icon: <Icon name="CirclePlus"/>,
              type: 'item',
              id: 'team-creation',
              content: <Suspense fallback={<TeamCreationSkeleton/>}>
                <TeamCreationPage mockMode={!!props.mockUser} />
              </Suspense>,
            }] as const : [],
          ] as const).filter((p) => p.type === 'divider' || (p as any).content )}
          title={t("Account Settings")}
        />
      </div>
    </MaybeFullPage>
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
  return <PageLayout>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-9 w-full mt-1"/>
  </PageLayout>;
}

function ActiveSessionsPageSkeleton() {
  return <PageLayout>
    <Skeleton className="h-6 w-48 mb-2"/>
    <Skeleton className="h-4 w-full mb-4"/>
    <Skeleton className="h-[200px] w-full mt-1 rounded-md"/>
  </PageLayout>;
}

function ApiKeysPageSkeleton() {
  return <PageLayout>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-[200px] w-full mt-1 rounded-md"/>
  </PageLayout>;
}

function PaymentsPageSkeleton() {
  return <PageLayout>
    <Skeleton className="h-6 w-48 mb-2"/>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-[200px] w-full mt-1 rounded-md"/>
  </PageLayout>;
}

function TeamPageSkeleton() {
  return <PageLayout>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-[200px] w-full mt-1 rounded-md"/>
  </PageLayout>;
}

function TeamDirectorySkeleton() {
  return <PageLayout>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-[200px] w-full mt-1 rounded-md"/>
  </PageLayout>;
}

function TeamCreationSkeleton() {
  return <PageLayout>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-9 w-full mt-1"/>
  </PageLayout>;
}

function NotificationsPageSkeleton() {
  return <PageLayout>
    <Skeleton className="h-9 w-full mt-1"/>
    <Skeleton className="h-9 w-full mt-1"/>
  </PageLayout>;
}
