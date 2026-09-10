// @vitest-environment jsdom

import {
  DATA_GRID_DEFAULT_STRINGS,
  type DataGridState,
} from "@hexclave/dashboard-ui-components";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { InternalDataGridFooter } from "./InternalDataGridFooter";

type TestRow = { id: string };

function createTestState(): DataGridState {
  return {
    sorting: [],
    columnVisibility: {},
    columnWidths: {},
    columnPinning: { left: [], right: [] },
    columnOrder: [],
    pagination: { pageIndex: 0, pageSize: 50 },
    selection: { selectedIds: new Set(), anchorId: null },
    dateDisplay: "relative",
    quickSearch: "",
  };
}

function FooterHarness() {
  const [state, setState] = useState(createTestState);
  return (
    <InternalDataGridFooter
      context={{
        state,
        totalRowCount: 600,
        visibleRowCount: Math.min(state.pagination.pageSize, 600),
        selectedRowCount: 0,
        paginationMode: "paginated",
        strings: DATA_GRID_DEFAULT_STRINGS,
      }}
      onChange={setState}
      historyPaging={{
        hasMoreHistory: false,
        isLoadingOlder: false,
        onLoadOlder: async () => {},
      }}
    />
  );
}

function HistoryFooterHarness() {
  const [state, setState] = useState(createTestState);
  const [totalRowCount, setTotalRowCount] = useState(50);
  return (
    <InternalDataGridFooter
      context={{
        state,
        totalRowCount,
        visibleRowCount: Math.min(state.pagination.pageSize, totalRowCount),
        selectedRowCount: 0,
        paginationMode: "paginated",
        strings: DATA_GRID_DEFAULT_STRINGS,
      }}
      onChange={setState}
      historyPaging={{
        hasMoreHistory: totalRowCount === 50,
        isLoadingOlder: false,
        onLoadOlder: async () => setTotalRowCount(100),
      }}
    />
  );
}

function EmptyFinalBatchFooterHarness() {
  const [state, setState] = useState(createTestState);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  return (
    <InternalDataGridFooter
      context={{
        state,
        totalRowCount: 50,
        visibleRowCount: 50,
        selectedRowCount: 0,
        paginationMode: "paginated",
        strings: DATA_GRID_DEFAULT_STRINGS,
      }}
      onChange={setState}
      historyPaging={{
        hasMoreHistory,
        isLoadingOlder: false,
        onLoadOlder: async () => setHasMoreHistory(false),
      }}
    />
  );
}

describe("InternalDataGridFooter", () => {
  it("preserves the 500-row page size option", () => {
    const { getByRole, getByText } = render(<FooterHarness />);
    const pageSize = getByRole("combobox", { name: /rows per page/i });

    expect(Array.from(pageSize.querySelectorAll("option"), option => option.textContent))
      .toEqual(["25", "50", "100", "500"]);

    fireEvent.change(pageSize, { target: { value: "500" } });

    expect(getByText("1 / 2")).not.toBeNull();
    expect(getByText("1–500 of 600")).not.toBeNull();
  });

  it("loads older history through Next and advances to it", async () => {
    const { container } = render(<HistoryFooterHarness />);
    const footer = within(container);

    expect(footer.queryByText("Load older")).toBeNull();
    fireEvent.click(footer.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(footer.getByText("2 / 2")).not.toBeNull());
    expect(footer.getByText("51–100 of 100")).not.toBeNull();
  });

  it("stays on the last real page when the final history fetch is empty", async () => {
    const { container } = render(<EmptyFinalBatchFooterHarness />);
    const footer = within(container);

    fireEvent.click(footer.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(footer.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(true));
    expect(footer.getByText("1 / 1")).not.toBeNull();
    expect(footer.getByText("1–50 of 50")).not.toBeNull();
  });
});
