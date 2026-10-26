"use client";

import { useAdminApp } from "@/app/(main)/(protected)/projects/[projectId]/use-admin-app";
import { ServerTeam } from "@hexclave/next";
import { type DataGridColumnDef } from "@hexclave/dashboard-ui-components";
import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { ServerSearchPickerTable } from "./server-search-picker-table";

export function TeamSearchTable(props: {
  action: (team: ServerTeam) => ReactNode,
}) {
  const adminApp = useAdminApp();
  const actionRef = useRef(props.action);
  actionRef.current = props.action;

  const columns = useMemo<DataGridColumnDef<ServerTeam>[]>(() => [
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
  ], []);

  const fetchPage = useCallback(async (options: { limit: number, cursor: string | undefined, query: string | undefined }) => {
    const teams = await adminApp.listTeams({
      limit: options.limit,
      cursor: options.cursor,
      query: options.query,
      orderBy: "createdAt",
      desc: true,
    });
    return { rows: teams, nextCursor: teams.nextCursor };
  }, [adminApp]);

  const getRowId = useCallback((team: ServerTeam) => team.id, []);

  return (
    <ServerSearchPickerTable
      columns={columns}
      getRowId={getRowId}
      fetchPage={fetchPage}
      emptyStateLabel="No teams found"
    />
  );
}
