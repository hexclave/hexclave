'use client';
import { Button, Input, Typography } from "@hexclave/ui";
import { useMemo, useState } from "react";
import { TeamIcon } from "../../../components/team-icon";
import { useTeamPages } from "@hexclave/shared/dist/hooks/use-team-pages";
import { useStackApp, useUser } from "../../../lib/hooks";
import { useTranslation } from "../../../lib/translations";
import { PageLayout } from "../page-layout";

/**
 * The account settings sidebar lists only the first page of the user's teams (one request is capped at 200), so
 * users with more teams reach the others from here. Each row links to the same `#team-<id>` page as the sidebar.
 */
export function TeamDirectoryPage() {
  const { t } = useTranslation();
  const app = useStackApp();
  const navigate = app.useNavigate();
  const user = useUser({ or: 'redirect' });
  const [query, setQuery] = useState("");
  const source = useMemo(() => ({
    useTeams: (options?: { query?: string }) => user.useTeams(options),
    listTeams: (options: { query?: string, limit: number, cursor: string }) => user.listTeams(options),
  }), [user]);
  const pages = useTeamPages(source, query);

  return (
    <PageLayout>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('Search teams')}
      />
      <div className="flex flex-col gap-1">
        {pages.teams.map(team => (
          <Button
            key={team.id}
            variant='ghost'
            className="justify-start gap-2"
            onClick={() => navigate(`#team-${team.id}`)}
          >
            <TeamIcon team={team} />
            <Typography className="truncate">{team.displayName}</Typography>
          </Button>
        ))}
        {pages.teams.length === 0 ? (
          <Typography variant='secondary'>
            {pages.activeQuery !== "" ? t('No matching teams') : t('No teams yet')}
          </Typography>
        ) : null}
        {pages.isSearchPending ? <Typography variant='secondary'>{t('Searching...')}</Typography> : null}
      </div>
      {pages.hasMore ? (
        <Button variant='secondary' onClick={pages.loadMore}>
          {t('Load more teams')}
        </Button>
      ) : null}
    </PageLayout>
  );
}
