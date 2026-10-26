'use client';
import { Button, Input, Typography } from "@hexclave/ui";
import { useState } from "react";
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
  const pages = useTeamPages(user, query);

  return (
    <PageLayout>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('Search teams')}
      />
      {pages.searchFailed ? (
        <div className="flex items-center justify-between gap-2">
          <Typography variant='destructive'>{t('Could not search teams. Check your connection and try again.')}</Typography>
          <Button variant='secondary' onClick={pages.retrySearch}>{t('Retry')}</Button>
        </div>
      ) : (
        <>
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
        </>
      )}
    </PageLayout>
  );
}
