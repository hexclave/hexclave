// TODO(ui-fixes-minor): URL-synced search state was dropped in the DataGrid
// migration — the debounced search routes to the server but the current
// query is no longer reflected in the URL. Restore via `useUrlQueryState`
// when product is ready to treat this as a regression.
'use client';

import { useAdminApp } from '@/app/(main)/(protected)/projects/[projectId]/use-admin-app';
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui";
import type { ServerUser } from '@hexclave/next';
import { type DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { useCallback, useMemo, useRef } from "react";
import { ServerSearchPickerTable } from "./server-search-picker-table";
import { extendUsers } from "./user-table";

export function UserPickerTable(props: {
  action: (user: ServerUser) => React.ReactNode,
}) {
  const hexclaveAdminApp = useAdminApp();
  const actionRef = useRef(props.action);
  actionRef.current = props.action;

  const columns = useMemo<DataGridColumnDef<ServerUser>[]>(() => [
    {
      id: "avatar",
      header: "",
      width: 56,
      minWidth: 56,
      maxWidth: 56,
      align: "center",
      sortable: false,
      hideable: false,
      resizable: false,
      renderCell: ({ row }) => (
        <Avatar className="h-7 w-7">
          <AvatarImage src={row.profileImageUrl ?? undefined} />
          <AvatarFallback className="text-xs">
            {row.displayName?.charAt(0) ?? row.primaryEmail?.charAt(0) ?? "?"}
          </AvatarFallback>
        </Avatar>
      ),
    },
    {
      id: "displayName",
      header: "Display Name",
      accessor: "displayName",
      width: 140,
      flex: 1,
      sortable: false,
      type: "string",
      renderCell: ({ row }) => (
        <span className={row.displayName == null ? 'text-muted-foreground' : ''}>
          {row.displayName ?? '–'}
        </span>
      ),
    },
    {
      id: "primaryEmail",
      header: "Email",
      accessor: "primaryEmail",
      width: 160,
      flex: 1,
      sortable: false,
      type: "string",
      renderCell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.primaryEmail ?? '–'}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: 100,
      minWidth: 100,
      maxWidth: 100,
      align: "right",
      sortable: false,
      hideable: false,
      resizable: false,
      renderCell: ({ row }) => actionRef.current(row),
    },
  ], []);

  const fetchPage = useCallback(async (options: { limit: number, cursor: string | undefined, query: string | undefined }) => {
    const result = await hexclaveAdminApp.listUsers(options);
    return { rows: extendUsers(result), nextCursor: result.nextCursor };
  }, [hexclaveAdminApp]);

  const getRowId = useCallback((row: ServerUser) => row.id, []);

  return (
    <ServerSearchPickerTable
      columns={columns}
      getRowId={getRowId}
      fetchPage={fetchPage}
      emptyStateLabel="No users found"
    />
  );
}
