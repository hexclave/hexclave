// TODO(ui-fixes-minor): URL-synced cursor (page state) was dropped when this
// table moved from the hand-rolled cursor cache to DataGrid infinite scroll.
// Reload resets scroll position and re-fetches from scratch. Restore if
// product cares about deep-linking to specific rows.
'use client';

import { useAdminApp } from '@/app/(main)/(protected)/projects/[projectId]/use-admin-app';
import { CustomerCell } from '@/components/payments/customer-cell';
import {
  formatTransactionTypeLabel,
  getTransactionSummary,
} from '@/components/payments/transaction-actions';
import { TransactionAmountCell, TransactionEventCell } from '@/components/payments/transaction-table-cells';
import { useTransactionDialog } from '@/components/payments/transaction-row-actions';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { DataGrid, DataGridToolbar, useDataGridUrlState, useDataSource, type DataGridColumnDef, type DataGridDataSource, type DataGridExportField, type DataGridExportScope } from '@hexclave/dashboard-ui-components';
import type { Transaction, TransactionType } from '@hexclave/shared/dist/interface/crud/transactions';
import { TRANSACTION_TYPES } from '@hexclave/shared/dist/interface/crud/transactions';
import React, { useCallback, useMemo, useRef, useState } from 'react';

type FilterState = {
  type?: TransactionType,
  customerType?: 'user' | 'team' | 'custom',
};

const PAGE_SIZE = 25;
const CUSTOMER_TYPE_OPTIONS = ["user", "team", "custom"] as const satisfies ReadonlyArray<NonNullable<FilterState["customerType"]>>;

const transactionExportSummaryCache = new WeakMap<Transaction, ReturnType<typeof getTransactionSummary>>();
function getTransactionExportSummary(transaction: Transaction): ReturnType<typeof getTransactionSummary> {
  const cached = transactionExportSummaryCache.get(transaction);
  if (cached != null) {
    return cached;
  }

  const summary = getTransactionSummary(transaction);
  transactionExportSummaryCache.set(transaction, summary);
  return summary;
}

const TRANSACTION_EXPORT_FIELDS: DataGridExportField<Transaction>[] = [
  { key: "id", label: "Transaction ID", enabled: true, getValue: (transaction) => transaction.id },
  { key: "type", label: "Type", enabled: true, getValue: (transaction) => getTransactionExportSummary(transaction).displayType.label },
  { key: "customerType", label: "Customer Type", enabled: true, getValue: (transaction) => getTransactionExportSummary(transaction).customerType ?? "" },
  { key: "customerId", label: "Customer ID", enabled: true, getValue: (transaction) => getTransactionExportSummary(transaction).customerId ?? "" },
  { key: "amount", label: "Amount", enabled: true, getValue: (transaction) => getTransactionExportSummary(transaction).amountDisplay },
  { key: "detail", label: "Detail", enabled: true, getValue: (transaction) => getTransactionExportSummary(transaction).detail },
  { key: "createdAt", label: "Created At", enabled: true, getValue: (transaction) => new Date(transaction.created_at_millis).toISOString() },
  { key: "status", label: "Status", enabled: true, getValue: (transaction) => getTransactionExportSummary(transaction).status?.label ?? "" },
];

export function TransactionTable() {
  const [filters, setFilters] = useState<FilterState>({});

  return (
    <TransactionTableBody filters={filters} setFilters={setFilters} />
  );
}

function TransactionTableBody(props: {
  filters: FilterState,
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>,
}) {
  const app = useAdminApp();
  const { filters, setFilters } = props;

  const dataSource = useMemo<DataGridDataSource<Transaction>>(
    () => async function* (params) {
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
      const result = await app.listTransactions({
        limit: PAGE_SIZE,
        type: filters.type,
        customerType: filters.customerType,
        cursor,
      });
      yield {
        rows: result.transactions,
        hasMore: result.nextCursor != null,
        nextCursor: result.nextCursor ?? undefined,
      };
    },
    [app, filters.type, filters.customerType],
  );

  const getRowId = useCallback((row: Transaction) => row.id, []);

  // `summaryById` is populated AFTER useDataSource returns rows, but the
  // column `renderCell` closures read it via ref so columns can be defined
  // first and stay stable across paginate/append. Empty initially; filled
  // below once we have rows.
  const summaryByIdRef = useRef<Map<string, ReturnType<typeof getTransactionSummary>>>(new Map());

  // Same ref indirection as `summaryByIdRef`: the stable (`[]`-deps) column
  // closures need the grid's `reload`, but `gridData` is created below them.
  const reloadRef = useRef<() => void>(() => {});
  // Refetch the grid after a refund/cancel so the new refund row shows up
  // immediately — `refundTransaction` invalidates the transactions cache, but
  // this table reads via a `DataGridDataSource` generator that doesn't
  // subscribe to that cache, so it must be told to reload.
  const handleCompleted = useCallback(() => {
    reloadRef.current();
  }, []);
  const transactionDialog = useTransactionDialog({ onCompleted: handleCompleted });

  const columns = useMemo<DataGridColumnDef<Transaction>[]>(() => [
    {
      id: "event",
      header: "Event",
      minWidth: 220,
      flex: 1.4,
      sortable: false,
      hideable: false,
      cellOverflow: "truncate",
      renderCell: ({ row }) => {
        const summary = summaryByIdRef.current.get(row.id);
        if (summary == null) {
          return <span>—</span>;
        }
        return <TransactionEventCell summary={summary} />;
      },
    },
    {
      id: "customer",
      header: "Customer",
      width: 180,
      minWidth: 140,
      maxWidth: 220,
      flex: 1,
      sortable: false,
      renderCell: ({ row }) => <CustomerCell customerType={row.customer_type} customerId={row.customer_id} />,
    },
    {
      id: "amount",
      header: "Amount",
      width: 108,
      minWidth: 96,
      maxWidth: 148,
      align: "right",
      sortable: false,
      renderCell: ({ row }) => {
        const summary = summaryByIdRef.current.get(row.id);
        if (summary == null) {
          return <span>—</span>;
        }
        return <TransactionAmountCell summary={summary} size="sm" />;
      },
    },
    {
      id: "created",
      header: "Date",
      accessor: (row: Transaction) => new Date(row.created_at_millis),
      width: 120,
      minWidth: 100,
      maxWidth: 140,
      type: "dateTime",
      sortable: false,
    },
    transactionDialog.actionsColumn,
  ], [transactionDialog.actionsColumn]);

  const [gridState, setGridState] = useDataGridUrlState(columns, { paramPrefix: "transactions" });

  const gridData = useDataSource({
    dataSource,
    columns,
    getRowId,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "infinite",
  });

  // Keep the column closures' reload hook pointed at the live grid reload.
  reloadRef.current = gridData.reload;

  // Populate `summaryByIdRef` from the current rows — the `renderCell`
  // closures read this on every render.
  summaryByIdRef.current = useMemo(
    () => new Map(gridData.rows.map((transaction) => [transaction.id, getTransactionSummary(transaction)])),
    [gridData.rows],
  );

  const filterTypeValue = filters.type ?? "__all";
  const filterCustomerValue = filters.customerType ?? "__all";
  const handleTypeChange = useCallback((value: string) => {
    setFilters((prev) => {
      if (value === "__all") {
        return { ...prev, type: undefined };
      }

      const selectedType = TRANSACTION_TYPES.find((transactionType) => transactionType === value);
      if (selectedType == null) {
        return prev;
      }

      return { ...prev, type: selectedType };
    });
  }, [setFilters]);
  const handleCustomerTypeChange = useCallback((value: string) => {
    setFilters((prev) => {
      if (value === "__all") {
        return { ...prev, customerType: undefined };
      }

      const selectedType = CUSTOMER_TYPE_OPTIONS.find((customerType) => customerType === value);
      if (selectedType == null) {
        return prev;
      }

      return { ...prev, customerType: selectedType };
    });
  }, [setFilters]);

  const fetchExportRows = useCallback(async (options: {
    scope: DataGridExportScope,
    onProgress: (fetched: number) => void,
  }) => {
    const allTransactions: Transaction[] = [];
    let cursor: string | undefined = undefined;
    const limit = 100;
    const useFilters = options.scope === "filtered";

    do {
      const result = await app.listTransactions({
        limit,
        cursor,
        type: useFilters ? filters.type : undefined,
        customerType: useFilters ? filters.customerType : undefined,
      });

      allTransactions.push(...result.transactions);
      options.onProgress(allTransactions.length);
      cursor = result.nextCursor ?? undefined;
    } while (cursor);

    return allTransactions;
  }, [app, filters.customerType, filters.type]);

  return (
    <>
      <DataGrid
        columns={columns}
        rows={gridData.rows}
        getRowId={getRowId}
        isLoading={gridData.isLoading}
        isRefetching={gridData.isRefetching}
        state={gridState}
        onChange={setGridState}
        onRowClick={transactionDialog.onRowClick}
        paginationMode="infinite"
        hasMore={gridData.hasMore}
        isLoadingMore={gridData.isLoadingMore}
        onLoadMore={gridData.loadMore}
        fillHeight={false}
        footer={false}
        rowHeight="auto"
        estimatedRowHeight={56}
        exportOptions={{
          title: "Export Transactions",
          description: "Configure and download transaction data from your project",
          entityName: "transaction",
          entityNamePlural: "transactions",
          filenamePrefix: "stack-transactions-export",
          fields: TRANSACTION_EXPORT_FIELDS,
          fetchRows: fetchExportRows,
          emptyExportTitle: "No transactions to export",
          emptyExportDescription: "There are no transactions matching the current filters",
          allScopeLabel: "Export all transactions in the project",
          filteredScopeLabel: "Export only filtered transactions",
        }}
        toolbar={(ctx) => (
          <DataGridToolbar
            ctx={ctx}
            hideQuickSearch
            extra={
              <div className="flex items-center gap-2">
                <Select
                  value={filterTypeValue}
                  onValueChange={handleTypeChange}
                >
                  <SelectTrigger className="h-8 w-[180px] text-xs">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all">All types</SelectItem>
                    {TRANSACTION_TYPES.map((transactionType) => {
                      const { Icon: TypeIcon, label } = formatTransactionTypeLabel(transactionType);
                      return (
                        <SelectItem key={transactionType} value={transactionType}>
                          <div className="flex items-center gap-2">
                            <TypeIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
                            <span className="truncate">{label}</span>
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                <Select
                  value={filterCustomerValue}
                  onValueChange={handleCustomerTypeChange}
                >
                  <SelectTrigger className="h-8 w-[140px] text-xs">
                    <SelectValue placeholder="All customers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all">All customers</SelectItem>
                    <SelectItem value="user">User</SelectItem>
                    <SelectItem value="team">Team</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            }
          />
        )}
        emptyState={
          <div className="text-center py-8">
            <p className="text-sm text-muted-foreground">No transactions found</p>
          </div>
        }
      />
      {transactionDialog.dialog}
    </>
  );
}
