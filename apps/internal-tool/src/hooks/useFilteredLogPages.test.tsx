// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFilteredLogPages } from "./useFilteredLogPages";

type Row = { id: string };
type Filters = { status: string };

function row(id: string): Row {
  return { id };
}

describe("useFilteredLogPages", () => {
  it("loads 25 rows first and appends the next cursor page without duplicates", async () => {
    const fetchPage = vi.fn(async (_filters: Filters, cursor: { beforeCreatedAtMicros: bigint } | null, _limit: number) => cursor == null
      ? {
        rows: [row("1"), row("2")],
        nextBeforeCreatedAtMicros: 100n,
        nextBeforeId: 2n,
      }
      : {
        rows: [row("2"), row("3")],
        nextBeforeCreatedAtMicros: undefined,
        nextBeforeId: undefined,
      });
    const { result } = renderHook(() => useFilteredLogPages({
      enabled: true,
      queryKey: "error",
      filters: { status: "error" },
      fetchPage,
      getRowId: candidate => candidate.id,
    }));

    await waitFor(() => expect(result.current.rows.map(candidate => candidate.id)).toEqual(["1", "2"]));
    expect(fetchPage.mock.calls[0]?.[2]).toBe(25);

    await act(async () => await result.current.loadMore());

    expect(result.current.rows.map(candidate => candidate.id)).toEqual(["1", "2", "3"]);
    expect(result.current.hasMore).toBe(false);
  });

  it("discards a response from a filter generation that is no longer active", async () => {
    let resolveFirst: ((value: { rows: Row[], nextBeforeCreatedAtMicros: undefined, nextBeforeId: undefined }) => void) | undefined;
    const first = new Promise<{ rows: Row[], nextBeforeCreatedAtMicros: undefined, nextBeforeId: undefined }>(resolve => {
      resolveFirst = resolve;
    });
    const fetchPage = vi.fn(async (filters: Filters) => filters.status === "old"
      ? await first
      : { rows: [row("new")], nextBeforeCreatedAtMicros: undefined, nextBeforeId: undefined });
    const { result, rerender } = renderHook(
      ({ status }: Filters) => useFilteredLogPages({
        enabled: true,
        queryKey: status,
        filters: { status },
        fetchPage,
        getRowId: candidate => candidate.id,
      }),
      { initialProps: { status: "old" } },
    );

    rerender({ status: "new" });
    await waitFor(() => expect(result.current.rows.map(candidate => candidate.id)).toEqual(["new"]));

    if (resolveFirst == null) throw new Error("The first filtered query was not started");
    resolveFirst({ rows: [row("old")], nextBeforeCreatedAtMicros: undefined, nextBeforeId: undefined });
    await act(async () => await first);

    expect(result.current.rows.map(candidate => candidate.id)).toEqual(["new"]);
  });
});
