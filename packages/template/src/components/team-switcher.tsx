'use client';
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Typography,
  cn,
} from "@hexclave/ui";
import { PlusCircle, Settings } from "lucide-react";
import { Suspense, useState } from "react";
import { CurrentUser, Team, useStackApp, useUser } from "..";
import { useTranslation } from "../lib/translations";
import { TeamIcon } from "./team-icon";
import { useTeamPages } from "@hexclave/shared/dist/hooks/use-team-pages";

type MockTeam = {
  id: string,
  displayName: string,
  profileImageUrl?: string | null,
};

type TeamSwitcherProps<AllowNull extends boolean = false> = {
  team?: Team,
  teamId?: string,
  teams?: Team[],
  allowNull?: AllowNull,
  nullLabel?: string,
  triggerClassName?: string,
  onChange?: (team: AllowNull extends true ? Team | null : Team) => Promise<void>,
  // Mock data props
  mockUser?: {
    team?: MockTeam,
  },
  mockTeams?: MockTeam[],
  mockProject?: {
    config: {
      clientTeamCreationEnabled: boolean,
    },
  },
};

export function TeamSwitcher<AllowNull extends boolean = false>(props: TeamSwitcherProps<AllowNull>) {
  return <Suspense fallback={<Fallback />}>
    <Inner {...props} />
  </Suspense>;
}

function Fallback() {
  return <Skeleton className="h-9 w-full max-w-64 stack-scope" />;
}

type ViewSharedProps = {
  allowNull?: boolean,
  nullLabel?: string,
  triggerClassName?: string,
  clientTeamCreationEnabled: boolean,
  onOpenAccountSettings: () => void,
  onSelect: (team: MockTeam | null) => Promise<void>,
};

function Inner<AllowNull extends boolean>(props: TeamSwitcherProps<AllowNull>) {
  const appFromHook = useStackApp();
  const userFromHook = useUser();

  // Use mock data if provided, otherwise use real data
  const app = props.mockUser ? {
    useProject: () => props.mockProject || { config: { clientTeamCreationEnabled: false } },
    redirectToAccountSettings: async () => {},
  } : appFromHook;
  const project = app.useProject();

  const shared: ViewSharedProps = {
    allowNull: props.allowNull,
    nullLabel: props.nullLabel,
    triggerClassName: props.triggerClassName,
    clientTeamCreationEnabled: project.config.clientTeamCreationEnabled,
    onOpenAccountSettings: () => {
      if (!props.mockUser) {
        runAsynchronouslyWithAlert(app.redirectToAccountSettings());
      }
    },
    onSelect: async (team) => {
      if (props.onChange) {
        await props.onChange(team as Team);
      }
    },
  };

  // An explicit `teams` list (or mock data) is the caller's responsibility, so it's rendered as-is.
  if (props.mockUser != null || props.teams != null || userFromHook == null) {
    const teams = props.teams ?? props.mockTeams ?? [];
    return <TeamSwitcherView
      {...shared}
      teams={teams}
      selectedTeam={props.team ?? teams.find(team => team.id === props.teamId) ?? null}
    />;
  }

  if (props.team == null && props.teamId != null) {
    return <PagedTeamSwitcherWithTeamId {...shared} user={userFromHook} teamId={props.teamId} />;
  }
  return <PagedTeamSwitcher {...shared} user={userFromHook} selectedTeam={props.team ?? null} />;
}

function PagedTeamSwitcherWithTeamId(props: ViewSharedProps & { user: CurrentUser, teamId: string }) {
  // `useTeam` also finds teams that aren't on the user's first (capped) page of teams.
  const selectedTeam = props.user.useTeam(props.teamId);
  return <PagedTeamSwitcher {...props} selectedTeam={selectedTeam} />;
}

function PagedTeamSwitcher(props: ViewSharedProps & { user: CurrentUser, selectedTeam: Team | null }) {
  const [query, setQuery] = useState("");
  const pages = useTeamPages(props.user, query);

  return <TeamSwitcherView
    {...props}
    teams={pages.teams}
    search={pages.hasMultiplePages || query !== "" ? {
      query,
      setQuery,
      isPending: pages.isSearchPending,
      isActive: pages.activeQuery !== "",
      failure: pages.searchFailed ? { retry: pages.retrySearch } : null,
    } : undefined}
    loadMore={pages.hasMore ? pages.loadMore : undefined}
  />;
}

function TeamSwitcherView(props: ViewSharedProps & {
  teams: MockTeam[],
  selectedTeam: MockTeam | null,
  search?: {
    query: string,
    setQuery: (query: string) => void,
    isPending: boolean,
    isActive: boolean,
    failure: { retry: () => void } | null,
  },
  loadMore?: () => Promise<void>,
}) {
  const { t } = useTranslation();
  const { selectedTeam, search } = props;
  const searchFailure = search?.failure ?? null;
  // After a failed search, the previous results no longer match the search box, so they're hidden behind the error.
  const otherTeams = searchFailure != null ? [] : props.teams.filter(team => team.id !== selectedTeam?.id);

  return (
    <Select
      value={selectedTeam?.id || (props.allowNull ? 'null-sentinel' : undefined)}
      onOpenChange={(open) => {
        if (!open) {
          search?.setQuery("");
        }
      }}
      onValueChange={(value) => {
        runAsynchronouslyWithAlert(async () => {
          let team: MockTeam | null = null;
          if (value !== 'null-sentinel') {
            team = (selectedTeam?.id === value ? selectedTeam : props.teams.find(team => team.id === value)) ?? null;
            if (!team) {
              throw new HexclaveAssertionError('Team not found, this should not happen');
            }
          }
          await props.onSelect(team);
        });
      }}
    >
      <SelectTrigger className={cn("stack-scope max-w-64", props.triggerClassName)}>
        <SelectValue placeholder="Select team"/>
      </SelectTrigger>
      <SelectContent className="stack-scope">
        {search ? <div className="p-1">
          <Input
            value={search.query}
            onChange={(e) => search.setQuery(e.target.value)}
            // Radix Select handles keys on its content for typeahead and arrow navigation, which would swallow the
            // text being typed here.
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={t('Search teams')}
            className="h-8"
          />
        </div> : null}

        {selectedTeam ? <SelectGroup>
          <SelectLabel>
            <div className="flex items-center justify-between">
              <span>
                {t('Current team')}
              </span>
              <Button
                variant='ghost'
                size='icon'
                className="h-6 w-6"
                onClick={props.onOpenAccountSettings}
              >
                <Settings className="h-4 w-4"/>
              </Button>
            </div>
          </SelectLabel>
          <SelectItem value={selectedTeam.id}>
            <div className="flex items-center gap-2">
              <TeamIcon team={selectedTeam as Team} />
              <Typography className="max-w-40 truncate">{selectedTeam.displayName}</Typography>
            </div>
          </SelectItem>
        </SelectGroup> : undefined}

        {props.allowNull && <SelectGroup>
          <SelectItem value="null-sentinel">
            <div className="flex items-center gap-2">
              <TeamIcon team='personal' />
              <Typography className="max-w-40 truncate">{props.nullLabel || t('No team')}</Typography>
            </div>
          </SelectItem>
        </SelectGroup>}

        {otherTeams.length > 0 ?
          <SelectGroup>
            <SelectLabel>{search?.isActive ? t('Matching teams') : t('Other teams')}</SelectLabel>
            {otherTeams.map(team => (
              <SelectItem value={team.id} key={team.id}>
                <div className="flex items-center gap-2">
                  <TeamIcon team={team as Team} />
                  <Typography className="max-w-64 truncate">{team.displayName}</Typography>
                </div>
              </SelectItem>
            ))}
          </SelectGroup> : null}

        {searchFailure != null ? <div className="flex items-center justify-between gap-2 p-2">
          <Typography variant='destructive' className="text-sm">{t('Could not search teams.')}</Typography>
          <Button onClick={searchFailure.retry} variant='secondary' size='sm'>
            {t('Retry')}
          </Button>
        </div> : null}

        {searchFailure == null && search?.isActive && otherTeams.length === 0 ?
          <SelectGroup>
            <SelectLabel>{t('No matching teams')}</SelectLabel>
          </SelectGroup> : null}

        {searchFailure == null && !search?.isActive && props.teams.length === 0 && !props.allowNull ?
          <SelectGroup>
            <SelectLabel>{t('No teams yet')}</SelectLabel>
          </SelectGroup> : null}

        {search?.isPending ?
          <SelectGroup>
            <SelectLabel>{t('Searching...')}</SelectLabel>
          </SelectGroup> : null}

        {props.loadMore && searchFailure == null ? <div className="p-1">
          <Button onClick={props.loadMore} className="w-full" variant='ghost' size='sm'>
            {t('Load more teams')}
          </Button>
        </div> : null}

        {props.clientTeamCreationEnabled && <>
          <SelectSeparator/>
          <div>
            <Button
              onClick={props.onOpenAccountSettings}
              className="w-full"
              variant='ghost'
            >
              <PlusCircle className="mr-2 h-4 w-4"/> {t('Create a team')}
            </Button>
          </div>
        </>}
      </SelectContent>
    </Select>
  );
}
