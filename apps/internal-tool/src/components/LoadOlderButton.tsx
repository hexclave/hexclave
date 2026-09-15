import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { clsx } from "clsx";


export type HistoryPagingProps = {
  hasMoreHistory: boolean,
  isLoadingOlder: boolean,
  onLoadOlder: () => Promise<void>,
};

export function NextPageButton({
  currentPage,
  pageCount,
  setPage,
  hasMoreHistory,
  isLoadingOlder,
  onLoadOlder,
  className,
}: {
  currentPage: number,
  pageCount: number,
  setPage: (updater: (page: number) => number) => void,
  className?: string,
} & HistoryPagingProps) {
  const atLastLoadedPage = currentPage >= pageCount - 1;
  // Only truly the end when there is nothing left to load either.
  const atEnd = atLastLoadedPage && !hasMoreHistory;

  return (
    <button
      onClick={() => {
        if (!atLastLoadedPage) {
          setPage(page => page + 1);
          return;
        }
        // Advance only once the fetch lands, so the page index never points at
        // rows that do not exist yet. `currentPage` is clamped on render, so an
        // overshoot from a short final batch corrects itself.
        runAsynchronouslyWithAlert(onLoadOlder().then(() => setPage(page => page + 1)));
      }}
      disabled={atEnd || isLoadingOlder}
      title={atLastLoadedPage && hasMoreHistory
        ? "Fetch older rows from the server. The live view only streams the newest window."
        : undefined}
      className={clsx(
        "px-2 py-0.5 text-xs rounded bg-white border border-gray-200 text-gray-600 transition-colors hover:transition-none hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-white",
        className,
      )}
    >
      {isLoadingOlder ? "Loading…" : "Next"}
    </button>
  );
}


export function LoadOlderButton({
  hasMoreHistory,
  isLoadingOlder,
  onLoadOlder,
  hasRows,
  className,
}: {
  hasRows: boolean,
  className?: string,
} & HistoryPagingProps) {
  if (!hasMoreHistory) {
    if (!hasRows) return null;
    return <span className={clsx("text-gray-400", className)}>end of history</span>;
  }

  return (
    <button
      onClick={() => runAsynchronouslyWithAlert(onLoadOlder())}
      disabled={isLoadingOlder}
      className={clsx(
        "px-2 py-0.5 text-xs rounded bg-white border border-gray-200 text-gray-600 transition-colors hover:transition-none hover:bg-gray-100 disabled:opacity-40 disabled:hover:bg-white",
        className,
      )}
    >
      {isLoadingOlder ? "Loading…" : "Load older"}
    </button>
  );
}
