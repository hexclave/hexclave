import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captureError } from "../utils/errors";
import { runAsynchronously } from "../utils/promises";
import { Result } from "../utils/results";
import { firstTeamsPageOptions, teamsPageSize, type TeamList, type TeamPageLister } from "../utils/team-lists";

const searchDebounceMs = 250;

/**
 * Both functions are called as methods on the source object, so an SDK user (whose methods rely on `this`) can be
 * passed directly.
 */
export type TeamPagesSource<T> = TeamPageLister<T> & {
  useTeams: (options: { limit: number }) => TeamList<T>,
};

type SearchOutcome = { query: string, attempt: number, failed: boolean };

/**
 * Team lists are capped at 200 per request, so any UI that lets a user pick one of their teams must be able to
 * reach the rest. This hook returns the first page from the (suspending, cached) `useTeams`, plus later pages
 * fetched on demand with `loadMore`, optionally narrowed by a server-side search query.
 *
 * Searches are fetched imperatively rather than with a suspending `useTeams({ query })`: the SDK's hooks throw
 * failed requests during render, and Suspense only covers loading, so a failed search would escape to the
 * nearest error boundary and replace the surrounding page (discarding e.g. a half-filled form). Here a failed
 * search is reported as `searchFailed`, and `retrySearch` re-runs it.
 *
 * Later pages are kept in local state tagged with the first-page array they were fetched after. When the first
 * page changes (cache refresh, new search query), the stale later pages are discarded instead of being
 * stitched onto a list they no longer continue — the user can load them again.
 */
export function useTeamPages<T extends { id: string }>(source: TeamPagesSource<T>, rawQuery: string) {
  const query = useDebouncedValue(rawQuery.trim(), searchDebounceMs);
  const unfilteredFirstPage = source.useTeams(firstTeamsPageOptions);

  const [attempt, setAttempt] = useState(0);
  // The outcome of the most recent search request, success or failure.
  const [latestSearch, setLatestSearch] = useState<SearchOutcome | null>(null);
  // The most recent successful search, kept separately so that a failed or still-loading search leaves it in place.
  const [lastSuccessfulSearch, setLastSuccessfulSearch] = useState<{ query: string, firstPage: TeamList<T> } | null>(null);
  const [previousQuery, setPreviousQuery] = useState(query);
  if (query !== previousQuery) {
    setPreviousQuery(query);
    // Clearing the search box goes straight back to the unfiltered list. Without this, the next search would
    // keep showing the results from before the box was cleared while it loads.
    if (query === "") {
      setLatestSearch(null);
      setLastSuccessfulSearch(null);
    }
  }

  useEffect(() => {
    if (query === "") return;
    let cancelled = false;
    runAsynchronously(async () => {
      const result = await Result.fromThrowingAsync(async () => await source.listTeams({ query, limit: teamsPageSize }));
      // A response for a query (or attempt) that is no longer current must not overwrite the newer one.
      if (cancelled) return;
      if (result.status === "error") {
        captureError("useTeamPages search", result.error);
      } else {
        setLastSuccessfulSearch({ query, firstPage: result.data });
      }
      setLatestSearch({ query, attempt, failed: result.status === "error" });
    });
    return () => {
      cancelled = true;
    };
    // `unfilteredFirstPage` changes identity whenever the SDK refreshes the user's teams (team renamed, created,
    // left, ...). Search results aren't in the SDK's cache, so an open search is re-run then to pick up the change.
  }, [query, attempt, source, unfilteredFirstPage]);

  const currentSearch = query !== "" && latestSearch?.query === query && latestSearch.attempt === attempt ? latestSearch : null;
  // While a search is loading (or after it failed), the previous successful results stay in `teams`, so typing
  // more characters refines the list instead of flashing back to the unfiltered one.
  const shown = query !== "" && lastSuccessfulSearch != null
    ? { query: lastSuccessfulSearch.query, firstPage: lastSuccessfulSearch.firstPage }
    : { query: "", firstPage: unfilteredFirstPage };

  const [laterPages, setLaterPages] = useState<{ after: TeamList<T>, teams: T[], nextCursor: string | null } | null>(null);
  const currentLaterPages = laterPages?.after === shown.firstPage ? laterPages : null;
  const teams = useMemo(
    () => currentLaterPages == null ? [...shown.firstPage] : [...shown.firstPage, ...currentLaterPages.teams],
    [shown.firstPage, currentLaterPages],
  );
  const nextCursor = currentLaterPages == null ? shown.firstPage.nextCursor : currentLaterPages.nextCursor;

  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const isLoadingMoreRef = useRef(false);
  const loadMore = useCallback(async () => {
    if (nextCursor == null || isLoadingMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const page = await source.listTeams({
        query: shown.query === "" ? undefined : shown.query,
        limit: teamsPageSize,
        cursor: nextCursor,
      });
      setLaterPages({
        after: shown.firstPage,
        teams: [...(currentLaterPages?.teams ?? []), ...page],
        nextCursor: page.nextCursor,
      });
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [nextCursor, source, shown.query, shown.firstPage, currentLaterPages]);

  const retrySearch = useCallback(() => setAttempt(previous => previous + 1), []);

  return {
    teams,
    hasMore: nextCursor != null,
    loadMore,
    isLoadingMore,
    /** Whether the user has more teams than fit in one page, i.e. whether a search box is worth showing. */
    hasMultiplePages: unfilteredFirstPage.nextCursor != null,
    isSearchPending: rawQuery.trim() !== query || (query !== "" && currentSearch == null),
    /**
     * Whether the current search failed. `teams` and `activeQuery` then still describe the last successful search
     * (or the unfiltered list), which no longer matches the search box, so callers show the error in place of the
     * list. The error itself is already reported via `captureError` and isn't exposed, since SDK errors can carry
     * retry logs and stack traces that shouldn't be shown to users.
     */
    searchFailed: currentSearch?.failed === true,
    retrySearch,
    activeQuery: shown.query,
  };
}

function useDebouncedValue<V>(value: V, delayMs: number): V {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);
  return debounced;
}
