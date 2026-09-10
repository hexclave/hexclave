import type { DataGridFooterContext, DataGridState } from "@hexclave/dashboard-ui-components";
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { Button, FieldLabel, Select } from "./design";
import { NextPageButton, type HistoryPagingProps } from "./LoadOlderButton";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 500] as const;
type PageSize = typeof PAGE_SIZE_OPTIONS[number];

function parsePageSize(value: string): PageSize {
  const parsed = Number(value);
  const pageSize = PAGE_SIZE_OPTIONS.find(option => option === parsed);
  if (pageSize == null) throw new Error(`Unexpected internal data grid page size: ${value}`);
  return pageSize;
}

export function InternalPaginationFooter({
  pageIndex,
  pageSize,
  totalRowCount,
  visibleRowCount,
  onPageChange,
  onPageSizeChange,
  historyPaging,
}: {
  pageIndex: number,
  pageSize: number,
  totalRowCount: number | null | undefined,
  visibleRowCount: number,
  onPageChange: (pageIndex: number) => void,
  onPageSizeChange: (pageSize: PageSize) => void,
  historyPaging: HistoryPagingProps,
}) {
  const pageCount = totalRowCount == null
    ? 1
    : Math.max(1, Math.ceil(totalRowCount / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const firstRow = totalRowCount == null || totalRowCount === 0
    ? 0
    : currentPage * pageSize + 1;
  const lastRow = totalRowCount == null
    ? visibleRowCount
    : Math.min((currentPage + 1) * pageSize, totalRowCount);

  useEffect(() => {
    if (pageIndex <= pageCount - 1) return;
    onPageChange(Math.max(0, pageCount - 1));
  }, [onPageChange, pageCount, pageIndex]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-foreground/[0.06] px-4 py-2.5 text-xs text-muted-foreground">
      <label className="flex items-center gap-2">
        <FieldLabel>Rows per page</FieldLabel>
        <span className="w-20">
          <Select
            value={pageSize}
            onChange={event => {
              onPageSizeChange(parsePageSize(event.target.value));
            }}
          >
            {PAGE_SIZE_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
          </Select>
        </span>
      </label>
      <div className="flex items-center gap-2">
        <span>{totalRowCount == null ? `${visibleRowCount} rows` : `${firstRow}–${lastRow} of ${totalRowCount}`}</span>
        <Button
          size="xs"
          disabled={currentPage === 0}
          onClick={() => onPageChange(Math.max(0, currentPage - 1))}
        >
          Prev
        </Button>
        <span className="font-mono tabular-nums">{currentPage + 1} / {pageCount}</span>
        <NextPageButton
          currentPage={currentPage}
          pageCount={pageCount}
          setPage={updater => onPageChange(updater(currentPage))}
          {...historyPaging}
        />
      </div>
    </div>
  );
}

export function InternalDataGridFooter<TRow>({
  context,
  onChange,
  historyPaging,
}: {
  context: DataGridFooterContext<TRow>,
  onChange: Dispatch<SetStateAction<DataGridState>>,
  historyPaging: HistoryPagingProps,
}) {
  return (
    <InternalPaginationFooter
      pageIndex={context.state.pagination.pageIndex}
      pageSize={context.state.pagination.pageSize}
      totalRowCount={context.totalRowCount}
      visibleRowCount={context.visibleRowCount}
      onPageChange={pageIndex => onChange(current => ({
        ...current,
        pagination: { ...current.pagination, pageIndex },
      }))}
      onPageSizeChange={pageSize => onChange(current => ({
        ...current,
        pagination: { pageIndex: 0, pageSize },
      }))}
      historyPaging={historyPaging}
    />
  );
}
