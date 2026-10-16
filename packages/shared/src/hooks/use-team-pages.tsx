import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captureError } from "../utils/errors";
import { runAsynchronously } from "../utils/promises";
import { Result } from "../utils/results";

/** Structurally the SDK's `TeamList<T>`: one page of teams plus the cursor for the next one. */
type TeamList<T> = T[] & { nextCursor: string | null };

// Matches the backend's per-request cap for `/teams`.
const teamsPageSize = 200;
const searchDebounceMs = 250;

/** The subset of the SDK's `ListTeamsOptions` used here: a cursor is only valid together with a limit. */
export type TeamPageRequest =
  | { query?: string, limit: number, cursor?: undefined }
  | { query?: string, limit: number, cursor: string };

/**
 * Both functions are called as methods on the source object, so an SDK user (whose methods rely on `this`) can be
 * passed directly.
 */
export type TeamPagesSource<T> = {
  useTeams: () => TeamList<T>,
  listTeams: (options: TeamPageRequest) => Promise<TeamList<T>>,
};

/**
 * Fetches every team after `firstPage`, one capped page at a time, and returns them all including `firstPage`.
 * Only for checks that genuinely need every team (e.g. which teams have products); pickers should page lazily
 * with `useTeamPages` instead.
 */
export async function listAllTeams<T>(source: Pick<TeamPagesSource<T>, "listTeams">, firstPage: TeamList<T>): Promise<T[]> {
  const teams = [...firstPage];
  let cursor = firstPage.nextCursor;
  while (cursor != null) {
    const page = await source.listTeams({ limit: teamsPageSize, cursor });
    teams.push(...page);
    cursor = page.nextCursor;
  }
  return teams;
}

type SearchOutcome<T> = { query: string, attempt: number, result: Result<TeamList<T>, unknown> };

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
  const unfilteredFirstPage = source.useTeams();

  const [attempt, setAttempt] = useState(0);
  const [search, setSearch] = useState<SearchOutcome<T> | null>(null);
  const [previousQuery, setPreviousQuery] = useState(query);
  if (query !== previousQuery) {
    setPreviousQuery(query);
    // Clearing the search box goes straight back to the unfiltered list. Without this, the next search would
    // keep showing the results from before the box was cleared while it loads.
    if (query === "") setSearch(null);
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
      }
      setSearch({ query, attempt, result });
    });
    return () => {
      cancelled = true;
    };
  }, [query, attempt, source]);

  const currentSearch = query !== "" && search?.query === query && search.attempt === attempt ? search : null;
  // While a search is loading (or after it failed), the previous successful results stay on screen, so typing
  // more characters refines the list instead of flashing back to the unfiltered one.
  const shown = query !== "" && search?.result.status === "ok"
    ? { query: search.query, firstPage: search.result.data }
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
     * Whether the current search failed; `teams` then still holds the previously shown results. The error itself
     * is already reported via `captureError` and isn't exposed, since SDK errors can carry retry logs and stack
     * traces that shouldn't be shown to users.
     */
    searchFailed: currentSearch?.result.status === "error",
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
