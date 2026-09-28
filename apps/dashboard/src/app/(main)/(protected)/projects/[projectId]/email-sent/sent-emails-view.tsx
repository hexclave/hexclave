"use client";

import { DesignBadge } from "@/components/design-components";
import { DesignCard } from "@/components/design-components";
import { useRouter } from "@/components/router";
import { Spinner, Typography } from "@/components/ui";
import { Envelope } from "@phosphor-icons/react";
import { AdminEmailOutbox } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import {
  DataGrid,
  useDataGridUrlState,
  useDataSource,
  type DataGridColumnDef,
} from "@hexclave/dashboard-ui-components";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useAdminApp, useProjectId } from "../use-admin-app";
import { DomainReputationCard } from "./domain-reputation-card";
import { STATUS_LABELS, computeEmailStats, getStatusBadgeColor } from "./email-status-utils";
import { getRecipientDisplay, getEmailTimestamp } from "./email-outbox-utils";
import { StatsBar } from "./stats-bar";

const emailColumns: DataGridColumnDef<AdminEmailOutbox>[] = [
  {
    id: "recipient",
    header: "Recipient",
    width: 200,
    type: "string",
    accessor: (row) => getRecipientDisplay(row),
  },
  {
    id: "scheduledAt",
    header: "Time",
    accessor: (row) => getEmailTimestamp(row),
    width: 180,
    type: "dateTime",
  },
  {
    id: "status",
    header: "Status",
    width: 120,
    renderCell: ({ row }) => (
      <DesignBadge label={STATUS_LABELS[row.status]} color={getStatusBadgeColor(row.status)} size="sm" />
    ),
  },
];

type SentEmailsViewProps = {
  filterFn: (email: AdminEmailOutbox) => boolean,
  renderActions?: (emails: AdminEmailOutbox[], refresh: () => Promise<void>) => ReactNode,
  stickyTop?: number | string,
};

export function SentEmailsView({ filterFn, renderActions, stickyTop }: SentEmailsViewProps) {
  const hexclaveAdminApp = useAdminApp();
  const projectId = useProjectId();
  const router = useRouter();
  const [emails, setEmails] = useState<AdminEmailOutbox[]>([]);
  const [loading, setLoading] = useState(true);

  // Kept as a bulk fetch (rather than cursor-paginated via `dataSource`)
  // because `filterFn` is an arbitrary client-side predicate — we can't
  // translate it to backend query params, and `computeEmailStats` needs
  // every filtered row to produce accurate totals. If the outbox grows
  // too large for a single fetch, we'd need a server-side stats +
  // paginated-list endpoint.
  const refreshEmails = useCallback(async () => {
    setLoading(true);
    try {
      const result = await hexclaveAdminApp.listOutboxEmails();
      setEmails(result.items);
    } finally {
      setLoading(false);
    }
  }, [hexclaveAdminApp]);

  useEffect(() => {
    let cancelled = false;
    runAsynchronouslyWithAlert(async () => {
      await refreshEmails();
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [refreshEmails]);

  const filtered = useMemo(() => emails.filter(filterFn), [emails, filterFn]);
  const stats = useMemo(() => computeEmailStats(filtered), [filtered]);

  const [gridState, setGridState] = useDataGridUrlState(emailColumns, {
    paramPrefix: "sentview",
    initial: { sorting: [{ columnId: "scheduledAt", direction: "desc" }] },
  });

  const gridData = useDataSource({
    data: filtered,
    columns: emailColumns,
    getRowId: (row) => row.id,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    // Client mode: arbitrary `filterFn` + client-computed stats require the
    // full list. See comment above `refreshEmails`.
    paginationMode: "client",
  });

  return (
    <div className="flex gap-4">
      <div className="flex-1 flex flex-col gap-4">
        {renderActions != null && !loading && renderActions(filtered, refreshEmails)}

        {/* Delivery Stats */}
        <DesignCard gradient="default" glassmorphic contentClassName="p-3">
          <div className="py-1">
            <div className="mb-2 text-sm text-center">
              <span className="font-medium">{filtered.length} email{filtered.length !== 1 ? "s" : ""}</span>
            </div>
            <StatsBar data={stats} />
          </div>
        </DesignCard>

        {/* Email Log */}
        <DesignCard gradient="default" glassmorphic contentClassName="p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="p-1 rounded-md bg-foreground/[0.06] dark:bg-foreground/[0.04]">
              <Envelope className="h-3 w-3 text-foreground/70 dark:text-muted-foreground" />
            </div>
            <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
              Recipients
            </span>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8">
              <Spinner size={16} />
              <Typography variant="secondary">Loading...</Typography>
            </div>
          ) : (
            <DataGrid
              columns={emailColumns}
              rows={gridData.rows}
              getRowId={(row) => row.id}
              totalRowCount={gridData.totalRowCount}
              isLoading={gridData.isLoading}
              state={gridState}
              onChange={setGridState}
              fillHeight={false}
              stickyTop={stickyTop}
              onRowClick={(row) => {
                router.push(`/projects/${projectId}/email-viewer/${row.id}`);
              }}
            />
          )}
        </DesignCard>
      </div>

      <div className="flex-shrink-0">
        <DomainReputationCard />
      </div>
    </div>
  );
}
