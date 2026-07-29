"use client";
import { UserPickerTable } from '@/components/data-table/user-picker-table';
import { TeamMemberTable } from '@/components/data-table/team-member-table';
import { DesignCategoryTabs, type DesignCategoryTabItem } from "@/components/design-components";
import { EditableInput } from "@/components/editable-input";
import { InputField } from '@/components/form-fields';
import { Link } from "@/components/link";
import { MetadataSection } from '@/components/metadata-editor';
import { useRouter } from "@/components/router";
import { ActionDialog, Avatar, AvatarFallback, AvatarImage, Button, Form, Separator, Skeleton } from '@/components/ui';
import { ALL_APPS_FRONTEND } from "@/lib/apps-frontend";
import { isAppEnabled } from "@/lib/apps-utils";
import { yupResolver } from '@hookform/resolvers/yup';
import { DatabaseIcon, PlusIcon } from "@phosphor-icons/react";
import { ServerTeam, hexclaveAppInternalsSymbol } from '@hexclave/next';
import { AppId } from "@hexclave/shared/dist/apps/apps-config";
import { strictEmailSchema, yupObject } from '@hexclave/shared/dist/schema-fields';
import { HexclaveAssertionError, throwErr } from '@hexclave/shared/dist/utils/errors';
import { runAsynchronouslyWithAlert } from '@hexclave/shared/dist/utils/promises';
import { notFound, usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import * as yup from 'yup';
import { AppEnabledGuard } from '../../app-enabled-guard';
import { PageLayout } from '../../page-layout';
import { useAdminApp } from '../../use-admin-app';
import { TeamAnalyticsSection } from './team-analytics';
import { TeamPaymentsSection } from './team-payments';

const teamMetadataDocsUrl = "https://docs.hexclave.com/guides/apps/teams/overview";

const inviteFormSchema = yupObject({
  email: strictEmailSchema("Please enter a valid email address").defined(),
});

export function AddUserDialog(props: {
  open?: boolean,
  onOpenChange?: (open: boolean) => void,
  trigger?: React.ReactNode,
  team: ServerTeam,
}) {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const teamUsers = props.team.useUsers();
  const inviteForm = useForm({
    resolver: yupResolver(inviteFormSchema),
  });

  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const onSubmit = async (values: yup.InferType<typeof inviteFormSchema>, e?: React.BaseSyntheticEvent) => {
    e?.preventDefault();
    setSubmitting(true);
    try {
      const domain = project.config.domains.find(d => !d.domain.includes('*'))?.domain;
      if (!domain) {
        alert("You must configure at least one non-wildcard domain for this project before you can invite users.");
        return;
      }
      await props.team.inviteUser({
        email: values.email,
        callbackUrl: new URL(adminApp[hexclaveAppInternalsSymbol].getUrls().teamInvitation, domain).toString(),
      });
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  };

  return <ActionDialog
    title="Add a user"
    trigger={props.trigger}
  >
    <div className="flex flex-col gap-4">
      <h3 className="font-semibold leading-none">Invite a new user</h3>
      <Form {...inviteForm}>
        <form onSubmit={e => runAsynchronouslyWithAlert(inviteForm.handleSubmit(onSubmit)(e))} onChange={() => setSubmitted(false)}>
          <div className="flex flex-row gap-4">
            <InputField control={inviteForm.control} className="flex-1" name="email" placeholder="Email" />
            <Button loading={submitting} type="submit" disabled={submitted}>
              {submitted ? 'Invited!' : 'Invite'}
            </Button>
          </div>
        </form>
      </Form>
      <div className="flex items-center justify-center stack-scope">
        <div className="flex-1">
          <Separator />
        </div>
        <div className="mx-2 text-sm text-zinc-500">OR</div>
        <div className="flex-1">
          <Separator />
        </div>
      </div>
      <h3 className="font-semibold leading-none">Add an existing user</h3>
      <UserPickerTable
        action={(user) => (
          <Button
            size="sm"
            variant="outline"
            disabled={teamUsers.find(u => u.id === user.id) !== undefined}
            onClick={() => {
            runAsynchronouslyWithAlert(props.team.addUser(user.id));
            }}
          >
            {teamUsers.find(u => u.id === user.id) ? 'Added' : 'Add'}
          </Button>
        )}
      />
    </div>
  </ActionDialog>;
}

export default function PageClient(props: { teamId: string }) {
  const hexclaveAdminApp = useAdminApp();
  const team = hexclaveAdminApp.useTeam(props.teamId);

  if (!team) {
    return notFound();
  }

  return (
    <AppEnabledGuard appId="teams">
      <TeamPage team={team} />
    </AppEnabledGuard>
  );
}

function TeamHeader({ team }: { team: ServerTeam }) {
  const name = team.displayName || team.id;
  return (
    <div className="flex min-w-0 flex-1 gap-4 items-center">
      <Avatar className="w-20 h-20 shrink-0">
        <AvatarImage src={team.profileImageUrl ?? undefined} alt={name} />
        <AvatarFallback>{name.slice(0, 2)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <EditableInput
          value={name}
          initialEditValue={team.displayName}
          placeholder={team.id}
          shiftTextToLeft
          inputClassName="font-semibold text-3xl"
          onUpdate={async (newName) => {
            await team.update({ displayName: newName });
          }}
        />
        <p className="text-sm text-muted-foreground">Created {team.createdAt.toLocaleDateString()}</p>
      </div>
    </div>
  );
}

type TeamPageTabConfig = {
  id: string,
  label: string,
} & (
  | { appId: AppId, icon?: undefined }
  | { appId: null, icon: NonNullable<DesignCategoryTabItem["icon"]> }
);

const TEAM_PAGE_TABS = [
  { id: "members", label: "Members", appId: "teams" },
  { id: "payments", label: "Payments", appId: "payments" },
  { id: "analytics", label: "Analytics", appId: "analytics" },
  { id: "metadata", label: "Metadata", appId: null, icon: DatabaseIcon },
] as const satisfies readonly TeamPageTabConfig[];

type TeamPageTab = typeof TEAM_PAGE_TABS[number]["id"];

function isTeamPageTab(id: string): id is TeamPageTab {
  return TEAM_PAGE_TABS.some((tab) => tab.id === id);
}

function TabContentSkeleton({ sections }: { sections: number }) {
  return (
    <div className="flex flex-col gap-6">
      {Array.from({ length: sections }).map((_, i) => (
        <section key={i} className="flex flex-col gap-3">
          <Skeleton className="h-4 w-32" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        </section>
      ))}
    </div>
  );
}

const TEAM_PAGE_TAB_PARAM = "tab";

function TeamPage({ team }: { team: ServerTeam }) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const visibleTabs = useMemo(
    () => TEAM_PAGE_TABS.filter((tab) => tab.appId === null || isAppEnabled(config.apps.installed, tab.appId)),
    [config.apps.installed],
  );

  const tabParam = searchParams.get(TEAM_PAGE_TAB_PARAM);
  const fallbackTab: TeamPageTab = visibleTabs[0]?.id ?? throwErr("Team page has no visible tabs");
  const activeTab: TeamPageTab = (tabParam && isTeamPageTab(tabParam) && visibleTabs.some((tab) => tab.id === tabParam))
    ? tabParam
    : fallbackTab;

  const setSelectedTab = useCallback((id: TeamPageTab) => {
    const newParams = new URLSearchParams(searchParams.toString());
    newParams.set(TEAM_PAGE_TAB_PARAM, id);
    const queryString = newParams.toString();
    router.push(queryString ? `${pathname}?${queryString}` : pathname);
  }, [pathname, router, searchParams]);

  return (
    <PageLayout>
      <div className="relative flex flex-col gap-6">
        <div className="flex items-start gap-4">
          <TeamHeader team={team} />
          {activeTab === "members" && (
            <AddUserDialog trigger={<Button>Add a user</Button>} team={team} />
          )}
        </div>
        {visibleTabs.length > 0 && (
          <DesignCategoryTabs
            categories={visibleTabs.map((tab) => ({
              id: tab.id,
              label: tab.label,
              icon: tab.appId === null ? tab.icon : ALL_APPS_FRONTEND[tab.appId].icon,
            }))}
            selectedCategory={activeTab}
            onSelect={(id) => {
              if (!isTeamPageTab(id)) {
                throw new HexclaveAssertionError(`Unknown team page tab selected: ${id}`);
              }
              setSelectedTab(id);
            }}
            showBadge={false}
            size="sm"
            glassmorphic={false}
            trailing={(
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="h-8 justify-center gap-1.5 rounded-lg bg-transparent px-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/75 transition-colors duration-150 hover:bg-transparent hover:text-foreground hover:transition-none"
              >
                <Link
                  href={`/projects/${encodeURIComponent(hexclaveAdminApp.projectId)}/app-configuration/apps`}
                  className="inline-flex items-center justify-center"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  <span>Install apps</span>
                </Link>
              </Button>
            )}
          />
        )}
        {activeTab === "members" && (
          <Suspense fallback={<TabContentSkeleton sections={1} />}>
            <TeamMemberTable team={team} />
          </Suspense>
        )}
        {activeTab === "payments" && (
          <Suspense fallback={<TabContentSkeleton sections={1} />}>
            <TeamPaymentsSection team={team} />
          </Suspense>
        )}
        {activeTab === "analytics" && (
          <Suspense fallback={<TabContentSkeleton sections={1} />}>
            <TeamAnalyticsSection team={team} />
          </Suspense>
        )}
        {activeTab === "metadata" && (
          <MetadataSection
            entityName="team"
            docsUrl={teamMetadataDocsUrl}
            clientMetadata={team.clientMetadata}
            clientReadOnlyMetadata={team.clientReadOnlyMetadata}
            serverMetadata={team.serverMetadata}
            onUpdateClientMetadata={async (value) => {
              await team.update({ clientMetadata: value });
            }}
            onUpdateClientReadOnlyMetadata={async (value) => {
              await team.update({ clientReadOnlyMetadata: value });
            }}
            onUpdateServerMetadata={async (value) => {
              await team.update({ serverMetadata: value });
            }}
          />
        )}
      </div>
    </PageLayout>
  );
}
