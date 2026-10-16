import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

/** Structurally the SDK's `TeamList<T>`: one page of teams plus the cursor for the next one. */
type TeamList<T> = T[] & { nextCursor: string | null };

// Matches the backend's per-request cap for `/teams`.
const teamsPageSize = 200;
const searchDebounceMs = 250;

export type TeamPagesSource<T> = {
  useTeams: (options?: { query?: string }) => TeamList<T>,
  listTeams: (options: { query?: string, limit: number, cursor: string }) => Promise<TeamList<T>>,
};

/**
 * Team lists are capped at 200 per request, so any UI that lets a user pick one of their teams must be able to
 * reach the rest. This hook returns the first page from the (suspending, cached) `useTeams`, plus later pages
 * fetched on demand with `loadMore`, optionally narrowed by a server-side search query.
 *
 * Later pages are kept in local state tagged with the first-page array they were fetched after. When the first
 * page changes (cache refresh, new search query), the stale later pages are discarded instead of being
 * stitched onto a list they no longer continue — the user can load them again.
 */
export function useTeamPages<T extends { id: string }>(source: TeamPagesSource<T>, rawQuery: string) {
  const query = useDebouncedValue(rawQuery.trim(), searchDebounceMs);
  // Deferred so that a new query suspends in the background while the previous results stay on screen,
  // instead of replacing the whole picker with its Suspense fallback on every keystroke.
  const deferredQuery = useDeferredValue(query);

  const unfilteredFirstPage = source.useTeams();
  const firstPage = source.useTeams(deferredQuery === "" ? undefined : { query: deferredQuery });

  const [laterPages, setLaterPages] = useState<{ after: TeamList<T>, teams: T[], nextCursor: string | null } | null>(null);
  const currentLaterPages = laterPages?.after === firstPage ? laterPages : null;
  const teams = useMemo(
    () => currentLaterPages == null ? [...firstPage] : [...firstPage, ...currentLaterPages.teams],
    [firstPage, currentLaterPages],
  );
  const nextCursor = currentLaterPages == null ? firstPage.nextCursor : currentLaterPages.nextCursor;

  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const isLoadingMoreRef = useRef(false);
  const loadMore = useCallback(async () => {
    if (nextCursor == null || isLoadingMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const page = await source.listTeams({
        query: deferredQuery === "" ? undefined : deferredQuery,
        limit: teamsPageSize,
        cursor: nextCursor,
      });
      setLaterPages({
        after: firstPage,
        teams: [...(currentLaterPages?.teams ?? []), ...page],
        nextCursor: page.nextCursor,
      });
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [nextCursor, source, deferredQuery, firstPage, currentLaterPages]);

  return {
    teams,
    hasMore: nextCursor != null,
    loadMore,
    isLoadingMore,
    /** Whether the user has more teams than fit in one page, i.e. whether a search box is worth showing. */
    hasMultiplePages: unfilteredFirstPage.nextCursor != null,
    isSearchPending: rawQuery.trim() !== deferredQuery,
    activeQuery: deferredQuery,
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
