"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { Button } from "@/components/ui";
import { ServerTeam } from "@hexclave/next";
import {
  createDefaultDataGridState,
  DataGrid,
  useDataSource,
  type DataGridColumnDef,
  type DataGridDataSource,
  type DataGridState,
} from "@hexclave/dashboard-ui-components";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useDebounce } from "use-debounce";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

export function TeamSearchTable(props: {
  action: (team: ServerTeam) => ReactNode,
}) {
  const adminApp = useAdminApp();
  const actionRef = useRef(props.action);
  actionRef.current = props.action;

  const columns = useMemo<DataGridColumnDef<ServerTeam>[]>(
    () => [
      {
        id: "displayName",
        header: "Display Name",
        accessor: "displayName",
        width: 200,
        flex: 1,
        type: "string",
        sortable: false,
      },
      {
        id: "id",
        header: "Team ID",
        accessor: "id",
        width: 160,
        type: "string",
        sortable: false,
        renderCell: ({ value }) => (
          <span className="font-mono text-xs">{String(value)}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        sortable: false,
        hideable: false,
        resizable: false,
        width: 96,
        align: "right",
        renderCell: ({ row }) => actionRef.current(row),
      },
    ],
    [],
  );

  const [gridState, setGridState] = useState<DataGridState>(() =>
    createDefaultDataGridState(columns),
  );

  const [debouncedQuickSearch] = useDebounce(gridState.quickSearch.trim(), SEARCH_DEBOUNCE_MS);

  const dataSource = useMemo<DataGridDataSource<ServerTeam>>(
    () => async function* (params) {
      const query = typeof params.quickSearch === "string" && params.quickSearch.trim().length > 0
        ? params.quickSearch.trim()
        : undefined;
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
      const result = await adminApp.listTeams({
        limit: PAGE_SIZE,
        orderBy: "createdAt",
        desc: true,
        query,
        cursor,
      });
      yield {
        rows: result,
        hasMore: result.nextCursor != null,
        nextCursor: result.nextCursor ?? undefined,
      };
    },
    [adminApp],
  );

  const getRowId = useCallback((row: ServerTeam) => row.id, []);

  const gridData = useDataSource({
    dataSource,
    columns,
    getRowId,
    sorting: gridState.sorting,
    quickSearch: debouncedQuickSearch,
    pagination: gridState.pagination,
    paginationMode: "infinite",
  });

  if (gridData.error) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <p className="text-sm text-muted-foreground">Failed to load teams</p>
        <Button size="sm" variant="outline" onClick={gridData.reload}>Retry</Button>
      </div>
    );
  }

  return (
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
      emptyState={
        <div className="text-center py-8">
          <p className="text-sm text-muted-foreground">No teams found</p>
        </div>
      }
    />
  );
}
