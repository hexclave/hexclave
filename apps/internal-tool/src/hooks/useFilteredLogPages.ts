import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PageCursor } from "./useSpacetimeDB";

export const FILTERED_LOG_PAGE_SIZE = 25;

type PageResult<Row> = {
  rows: Row[],
  nextBeforeCreatedAtMicros: bigint | undefined,
  nextBeforeId: bigint | undefined,
};

type Settled<T> = { ok: true, value: T } | { ok: false, error: unknown };

function settledSuccess<T>(value: T): Settled<T> {
  return { ok: true, value };
}

function settledFailure<T>(error: unknown): Settled<T> {
  return { ok: false, error };
}

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return await promise.then(
    (value): Settled<T> => settledSuccess(value),
    (error): Settled<T> => settledFailure<T>(error),
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  if (typeof error === "string" && error !== "") return error;
  return "The filtered query failed. Try again.";
}

function nextCursor<Row>(page: PageResult<Row>): PageCursor | null {
  if (page.nextBeforeCreatedAtMicros == null) return null;
  return {
    beforeCreatedAtMicros: page.nextBeforeCreatedAtMicros,
    beforeId: page.nextBeforeId,
  };
}

type FilteredPageState<Row> = {
  rows: Row[],
  cursor: PageCursor | null,
  hasMore: boolean,
  status: "idle" | "loading" | "ready" | "loading-more" | "error",
  error: string | null,
  updatedAt: Date | null,
};

function createInitialState<Row>(): FilteredPageState<Row> {
  return {
    rows: [],
    cursor: null,
    hasMore: false,
    status: "idle",
    error: null,
    updatedAt: null,
  };
}

export function useFilteredLogPages<Row, Filters>({
  enabled,
  queryKey,
  filters,
  fetchPage,
  getRowId,
}: {
  enabled: boolean,
  queryKey: string,
  filters: Filters,
  fetchPage: (filters: Filters, cursor: PageCursor | null, limit: number) => Promise<PageResult<Row>>,
  getRowId: (row: Row) => string,
}) {
  const generationRef = useRef(0);
  const filtersRef = useRef(filters);
  const fetchPageRef = useRef(fetchPage);
  const getRowIdRef = useRef(getRowId);
  filtersRef.current = filters;
  fetchPageRef.current = fetchPage;
  getRowIdRef.current = getRowId;
  const [state, setState] = useState<FilteredPageState<Row>>(createInitialState);

  const loadFirstPage = useCallback(async (generation: number) => {
    const outcome = await settle(fetchPageRef.current(filtersRef.current, null, FILTERED_LOG_PAGE_SIZE));
    if (generationRef.current !== generation) return;
    if (!outcome.ok) {
      setState({ ...createInitialState<Row>(), status: "error", error: errorMessage(outcome.error) });
      return;
    }
    const cursor = nextCursor(outcome.value);
    setState({
      rows: outcome.value.rows,
      cursor,
      hasMore: cursor != null,
      status: "ready",
      error: null,
      updatedAt: new Date(),
    });
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    if (!enabled) {
      setState(createInitialState());
      return;
    }
    setState({ ...createInitialState<Row>(), status: "loading" });
    runAsynchronously(() => loadFirstPage(generation));
  }, [enabled, loadFirstPage, queryKey]);

  const loadMore = useCallback(async () => {
    if (!enabled || state.cursor == null || state.status === "loading" || state.status === "loading-more") return;
    const generation = generationRef.current;
    setState(current => ({ ...current, status: "loading-more", error: null }));
    const outcome = await settle(fetchPageRef.current(filtersRef.current, state.cursor, FILTERED_LOG_PAGE_SIZE));
    if (generationRef.current !== generation) return;
    if (!outcome.ok) {
      setState(current => ({ ...current, status: "error", error: errorMessage(outcome.error) }));
      return;
    }
    const cursor = nextCursor(outcome.value);
    setState(current => {
      const byId = new Map(current.rows.map(row => [getRowIdRef.current(row), row]));
      for (const row of outcome.value.rows) byId.set(getRowIdRef.current(row), row);
      return {
        rows: Array.from(byId.values()),
        cursor,
        hasMore: cursor != null,
        status: "ready",
        error: null,
        updatedAt: new Date(),
      };
    });
  }, [enabled, state.cursor, state.status]);

  const refresh = useCallback(async () => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setState({ ...createInitialState<Row>(), status: "loading" });
    await loadFirstPage(generation);
  }, [loadFirstPage]);

  return {
    ...state,
    isLoading: state.status === "loading",
    isLoadingMore: state.status === "loading-more",
    loadMore,
    refresh,
  };
}
