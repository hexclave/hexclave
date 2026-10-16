import { Button, Input } from "~/components/ui";
import { useUser } from "@hexclave/react";
import { useTeamPages } from "@hexclave/shared/dist/hooks/use-team-pages";
import { useState } from "react";
import { PageLayout } from "../page-layout";
import { setHash } from "../sidebar-layout";
import { TeamIcon } from "../supporting/team-icon";

/**
 * The account settings sidebar lists only the first page of the user's teams (one request is capped at 200), so
 * users with more teams reach the others from here. Each row links to the same `#team-<id>` page as the sidebar.
 */
export function TeamDirectoryPage() {
  const user = useUser({ or: 'redirect' });
  const [query, setQuery] = useState("");
  const pages = useTeamPages(user, query);

  return (
    <PageLayout>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search teams"
      />
      {pages.searchFailed ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-destructive">Could not search teams. Check your connection and try again.</span>
          <Button variant="secondary" onClick={pages.retrySearch}>Retry</Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {pages.teams.map(team => (
              <Button
                key={team.id}
                variant="ghost"
                className="justify-start gap-2"
                onClick={() => setHash(`#team-${team.id}`)}
              >
                <TeamIcon team={team} />
                <span className="truncate text-sm font-medium">{team.displayName}</span>
              </Button>
            ))}
            {pages.teams.length === 0 ? (
              <span className="text-sm text-muted-foreground">
                {pages.activeQuery !== "" ? "No matching teams" : "No teams yet"}
              </span>
            ) : null}
            {pages.isSearchPending ? <span className="text-sm text-muted-foreground">Searching...</span> : null}
          </div>
          {pages.hasMore ? (
            <Button variant="secondary" onClick={pages.loadMore}>
              Load more teams
            </Button>
          ) : null}
        </>
      )}
    </PageLayout>
  );
}
