'use client';

import {
  createDefaultDataGridState,
  DataGrid,
  useDataSource,
  type DataGridColumnDef,
  type DataGridDataSource,
  type DataGridState,
} from "@hexclave/dashboard-ui-components";
import { DesignAlert, DesignButton } from "@/components/design-components";
import { useMemo, useState } from "react";
import { useDebounce } from "use-debounce";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

export type ServerSearchPickerPage<TRow> = {
  rows: TRow[],
  nextCursor: string | null,
};

/**
 * Compact picker table whose search and pagination both run on the server, so
 * it works for projects with more rows than fit in a single list request.
 * `columns` and `fetchPage` must be referentially stable (memoize them), as
 * changing either resets the loaded rows.
 */
export function ServerSearchPickerTable<TRow>(props: {
  columns: DataGridColumnDef<TRow>[],
  getRowId: (row: TRow) => string,
  fetchPage: (options: { limit: number, cursor: string | undefined, query: string | undefined }) => Promise<ServerSearchPickerPage<TRow>>,
  emptyStateLabel: string,
}) {
  const { columns, getRowId, fetchPage } = props;

  const [gridState, setGridState] = useState<DataGridState>(() =>
    createDefaultDataGridState(columns)
  );

  // Debounce the toolbar search so we don't hit the list endpoint on every keystroke.
  const [debouncedQuickSearch] = useDebounce(gridState.quickSearch.trim(), SEARCH_DEBOUNCE_MS);

  const dataSource = useMemo<DataGridDataSource<TRow>>(
    () => async function* (params) {
      const query = typeof params.quickSearch === "string" && params.quickSearch.trim().length > 0
        ? params.quickSearch.trim()
        : undefined;
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
      const page = await fetchPage({ limit: PAGE_SIZE, cursor, query });
      yield {
        rows: page.rows,
        hasMore: page.nextCursor != null,
        nextCursor: page.nextCursor ?? undefined,
      };
    },
    [fetchPage],
  );

  const gridData = useDataSource({
    dataSource,
    columns,
    getRowId,
    sorting: gridState.sorting,
    quickSearch: debouncedQuickSearch,
    pagination: gridState.pagination,
    paginationMode: "infinite",
  });

  // `useDataSource` reports failed fetches only through `error` (DataGrid doesn't render it), so without this a
  // failed first page looks like "no results", and a failed later page just stops loading. The raw error isn't shown:
  // SDK errors can carry a full retry log and stack trace, and `useDataSource` already logs them to the console.
  const errorAlert = gridData.error != null && (
    <DesignAlert
      variant="error"
      title="Couldn't load results"
      description={
        <div className="flex flex-col items-start gap-2">
          <span>Something went wrong while loading. Check your connection and try again.</span>
          <DesignButton type="button" size="sm" variant="outline" onClick={() => gridData.reload()}>Retry</DesignButton>
        </div>
      }
    />
  );

  return (
    <div className="flex flex-col gap-3">
      <DataGrid
        columns={columns}
        rows={gridData.rows}
        getRowId={getRowId}
        isLoading={gridData.isLoading}
        isRefetching={gridData.isRefetching}
        state={gridState}
        onChange={setGridState}
        paginationMode="infinite"
        hasMore={gridData.hasMore}
        isLoadingMore={gridData.isLoadingMore}
        onLoadMore={gridData.loadMore}
        fillHeight={false}
        maxHeight={420}
        footer={false}
        emptyState={errorAlert || (
          <div className="text-center py-8">
            <p className="text-sm text-muted-foreground">{props.emptyStateLabel}</p>
          </div>
        )}
      />
      {gridData.rows.length > 0 && errorAlert}
    </div>
  );
}
