// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultDataGridState,
  DATA_GRID_DEFAULT_STRINGS,
  DataGrid,
  DataGridToolbar,
  isDataGridInteractiveRowClickTarget,
  useDataSource,
  type DataGridColumnDef,
  type DataGridDataSource,
  type DataGridProps,
} from "./index";

type Row = {
  id: string,
  name: string,
};

const columns: DataGridColumnDef<Row>[] = [
  {
    id: "name",
    header: "Name",
    accessor: (row) => row.name,
    width: 160,
    minWidth: 80,
    sortable: true,
    type: "string",
  },
];

const wideColumns: DataGridColumnDef<Row>[] = [
  {
    id: "name",
    header: "Name",
    accessor: (row) => row.name,
    width: 320,
    minWidth: 80,
    type: "string",
  },
  {
    id: "email",
    header: "Email",
    accessor: (row) => `${row.name.toLowerCase().replaceAll(" ", ".")}@example.com`,
    width: 420,
    minWidth: 80,
    type: "string",
  },
];

describe("DataGridToolbar action divider", () => {
  const ctx = {
    state: createDefaultDataGridState(columns),
    onChange: vi.fn(),
    columns,
    visibleColumns: columns,
    totalRowCount: 1,
    selectedRowCount: 0,
    strings: DATA_GRID_DEFAULT_STRINGS,
    exportCsv: vi.fn(),
  };

  afterEach(cleanup);

  it("does not render a divider for an empty React node", () => {
    const { container } = render(
      <DataGridToolbar ctx={ctx} extraActions={false} />,
    );

    expect(container.querySelector(".mx-0\\.5.h-4.w-px")).toBeNull();
  });

  it("renders the divider when an action is visible", () => {
    const { container, getByRole } = render(
      <DataGridToolbar
        ctx={ctx}
        extraActions={<button type="button">Refresh</button>}
      />,
    );

    expect(getByRole("button", { name: "Refresh" })).not.toBeNull();
    expect(container.querySelector(".mx-0\\.5.h-4.w-px")).not.toBeNull();
  });
});

type ObserverRecord = {
  options?: IntersectionObserverInit,
};

let intersectionObserverRecords: ObserverRecord[] = [];
let intersectionObserverInstances: MockIntersectionObserver[] = [];

class MockIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin: string;
  readonly thresholds: ReadonlyArray<number>;
  private readonly callback: IntersectionObserverCallback;
  private readonly record: ObserverRecord;

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.callback = callback;
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "";
    this.scrollMargin = "";
    this.thresholds = Array.isArray(options?.threshold)
      ? options.threshold
      : [options?.threshold ?? 0];
    this.record = { options };
    intersectionObserverRecords.push(this.record);
    intersectionObserverInstances.push(this);
  }

  disconnect() {}
  observe() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve() {}

  trigger(entry: Partial<IntersectionObserverEntry> = {}) {
    this.callback(
      [
        {
          boundingClientRect: {} as DOMRectReadOnly,
          intersectionRatio: 1,
          intersectionRect: {} as DOMRectReadOnly,
          isIntersecting: true,
          rootBounds: null,
          target: document.createElement("div"),
          time: 0,
          ...entry,
        },
      ],
      this,
    );
  }
}

class MockResizeObserver implements ResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  disconnect() {}
  observe(target: Element) {
    const el = target instanceof HTMLElement ? target : null;
    const parentWidth = el?.parentElement instanceof HTMLElement ? el.parentElement.clientWidth : 0;
    const width = (el?.clientWidth ?? 0) > 0 ? (el?.clientWidth ?? 320) : parentWidth > 0 ? parentWidth : 320;
    const height = (el?.clientHeight ?? 0) > 0 ? (el?.clientHeight ?? 400) : 400;
    this.callback(
      [
        {
          target,
          contentRect: {
            x: 0,
            y: 0,
            width,
            height,
            top: 0,
            left: 0,
            right: width,
            bottom: height,
            toJSON() {
              return this;
            },
          } as DOMRectReadOnly,
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
  unobserve() {}
}

function DataGridHarness(props: { fillHeight?: boolean }) {
  const [state, setState] = useState(() => createDefaultDataGridState(columns));

  return (
    <div style={{ height: 400 }}>
      <DataGrid<Row>
        columns={columns}
        rows={[{ id: "row-1", name: "Row 1" }]}
        getRowId={(row) => row.id}
        state={state}
        onChange={setState}
        paginationMode="infinite"
        hasMore
        fillHeight={props.fillHeight}
      />
    </div>
  );
}

function PaginatedDataGridHarness(props: { stickyTop?: number | string } = {}) {
  const [state, setState] = useState(() => createDefaultDataGridState(columns));

  return (
    <div style={{ height: 400 }}>
      <DataGrid<Row>
        columns={columns}
        rows={[{ id: "row-1", name: "Row 1" }]}
        getRowId={(row) => row.id}
        state={state}
        onChange={setState}
        paginationMode="paginated"
        fillHeight={false}
        stickyTop={props.stickyTop}
      />
    </div>
  );
}

function InteractiveDataGridHarness(props: {
  onSortChange?: DataGridProps<Row>["onSortChange"],
  onSelectionChange?: DataGridProps<Row>["onSelectionChange"],
  onRowClick?: DataGridProps<Row>["onRowClick"],
  rows?: readonly Row[],
}) {
  const [state, setState] = useState(() => createDefaultDataGridState(columns));
  const rows = props.rows ?? [{ id: "row-1", name: "Row 1" }];

  return (
    <div style={{ height: 400 }}>
      <DataGrid<Row>
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        state={state}
        onChange={setState}
        selectionMode="multiple"
        onSortChange={props.onSortChange}
        onSelectionChange={props.onSelectionChange}
        onRowClick={props.onRowClick}
      />
    </div>
  );
}

function WideDataGridHarness(props: {
  horizontalScrollbarPosition?: "top" | "bottom",
} = {}) {
  const [state, setState] = useState(() => createDefaultDataGridState(wideColumns));

  return (
    <div style={{ width: 320 }}>
      <DataGrid<Row>
        columns={wideColumns}
        rows={[{ id: "row-1", name: "Row 1" }]}
        getRowId={(row) => row.id}
        state={state}
        onChange={setState}
        horizontalScrollbarPosition={props.horizontalScrollbarPosition}
      />
    </div>
  );
}

describe("DataGrid infinite scroll observer", () => {
  beforeEach(() => {
    intersectionObserverRecords = [];

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect() {
        return {
          x: 0,
          y: 0,
          width: 320,
          height: 44,
          top: 0,
          left: 0,
          right: 320,
          bottom: 44,
          toJSON() {
            return this;
          },
        } as DOMRect;
      },
    );
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return 400;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 400;
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("observes against the grid body when the grid owns vertical scrolling", async () => {
    const { container } = render(<DataGridHarness fillHeight />);

    await waitFor(() => {
      expect(intersectionObserverRecords.length).toBeGreaterThan(0);
    });

    const grid = container.querySelector('[role="grid"]');
    expect(grid).not.toBeNull();
    const scrollContainer = grid?.children.item(1);

    expect(intersectionObserverRecords.at(-1)?.options?.root).toBe(scrollContainer);
  });

  // Regression: an infinite grid left unbounded (`fillHeight={false}`, no `maxHeight`) used to
  // grow its scroll container to fit every loaded row, which defeats virtualization (the
  // virtualizer measures the container as fully visible and mounts every row) and OOMs the tab on
  // large datasets. Such grids now fall back to a default `maxHeight`, so the grid owns its own
  // bounded scroll container and observes against it rather than the viewport.
  it("bounds an unbounded infinite grid and observes against its own scroll container", async () => {
    const { container } = render(<DataGridHarness fillHeight={false} />);

    await waitFor(() => {
      expect(intersectionObserverRecords.length).toBeGreaterThan(0);
    });

    const grid = container.querySelector('[role="grid"]');
    expect(grid).not.toBeNull();
    const scrollContainer = grid?.children.item(1);

    expect(intersectionObserverRecords.at(-1)?.options?.root).toBe(scrollContainer);
  });

  it("applies a default maxHeight to an otherwise-unbounded infinite grid", () => {
    const { container } = render(<DataGridHarness fillHeight={false} />);

    const grid = container.querySelector<HTMLElement>('[role="grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.style.maxHeight).toBe("calc(100dvh - 16rem)");
  });

  it("does not force a maxHeight onto a paginated grid", () => {
    const { container } = render(<PaginatedDataGridHarness />);

    const grid = container.querySelector<HTMLElement>('[role="grid"]');
    expect(grid).not.toBeNull();
    expect(grid?.style.maxHeight).toBe("");
  });

  it("writes an explicit sticky offset to the grid contract", () => {
    const { container } = render(<PaginatedDataGridHarness stickyTop={0} />);

    const grid = container.querySelector<HTMLElement>('[role="grid"]');
    expect(grid?.style.getPropertyValue("--data-grid-sticky-top")).toBe("0px");
  });
});

// Drives a real `useDataSource` infinite-scroll grid whose data source
// always reports `hasMore: true`, mirroring a project with a long
// transaction / customer history (e.g. the transactions table and customers
// tab). Used to prove the sentinel doesn't thrash its IntersectionObserver.
function InfiniteScrollLoadMoreHarness({ onFetch }: { onFetch: () => void }) {
  const [state, setState] = useState(() => createDefaultDataGridState(columns));
  const dataSource = useMemo<DataGridDataSource<Row>>(
    () => {
      let page = 0;
      return async function* () {
        onFetch();
        const current = page++;
        yield {
          rows: [{ id: `row-${current}`, name: `Row ${current}` }],
          hasMore: true,
          nextCursor: `cursor-${current}`,
        };
      };
    },
    [onFetch],
  );

  const gridData = useDataSource<Row>({
    dataSource,
    columns,
    getRowId: (row) => row.id,
    sorting: state.sorting,
    quickSearch: state.quickSearch,
    pagination: state.pagination,
    paginationMode: "infinite",
  });

  return (
    <div style={{ height: 400 }}>
      <DataGrid<Row>
        columns={columns}
        rows={gridData.rows}
        getRowId={(row) => row.id}
        state={state}
        onChange={setState}
        paginationMode="infinite"
        hasMore={gridData.hasMore}
        isLoading={gridData.isLoading}
        isLoadingMore={gridData.isLoadingMore}
        onLoadMore={gridData.loadMore}
      />
    </div>
  );
}

describe("DataGrid infinite scroll observer stability", () => {
  beforeEach(() => {
    intersectionObserverRecords = [];
    intersectionObserverInstances = [];

    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect() {
        return {
          x: 0,
          y: 0,
          width: 320,
          height: 44,
          top: 0,
          left: 0,
          right: 320,
          bottom: 44,
          toJSON() {
            return this;
          },
        } as DOMRect;
      },
    );
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return 400;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 400;
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // Regression: the sentinel used to re-create its IntersectionObserver every
  // time the `onLoadMore` callback changed identity (which happens on every
  // `isLoadingMore` / `hasMore` toggle). A freshly-created observer re-reports
  // the sentinel's current intersection state, so a sentinel that stays in
  // view fires `onLoadMore` again after every page — auto-loading the entire
  // history back-to-back and OOM-crashing the tab ("Aw snap") on large
  // datasets. The observer must stay stable across load-more cycles.
  it("does not re-create the observer on load-more cycles", async () => {
    const onFetch = vi.fn();
    render(<InfiniteScrollLoadMoreHarness onFetch={onFetch} />);

    // Initial page load, after which the sentinel (and its observer) mounts.
    await waitFor(() => expect(onFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(intersectionObserverInstances.length).toBeGreaterThan(0));

    const observersBeforeLoadMore = intersectionObserverInstances.length;

    // Simulate the sentinel scrolling into view exactly once.
    await act(async () => {
      intersectionObserverInstances.at(-1)?.trigger();
      await Promise.resolve();
    });

    await waitFor(() => expect(onFetch).toHaveBeenCalledTimes(2));

    // A single scroll-in must trigger a single fetch, without spawning new
    // observers — otherwise each new observer would re-fire and runaway.
    expect(intersectionObserverInstances.length).toBe(observersBeforeLoadMore);
  });
});

describe("DataGrid controlled callbacks", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect() {
        return {
          x: 0,
          y: 0,
          width: 320,
          height: 44,
          top: 0,
          left: 0,
          right: 320,
          bottom: 44,
          toJSON() {
            return this;
          },
        } as DOMRect;
      },
    );
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return 400;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return 400;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 400;
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fires onSortChange from the current controlled sort state", () => {
    const onSortChange = vi.fn();
    const { getByRole } = render(<InteractiveDataGridHarness onSortChange={onSortChange} />);

    fireEvent.click(getByRole("columnheader", { name: /name/i }));

    expect(onSortChange).toHaveBeenCalledTimes(1);
    expect(onSortChange).toHaveBeenCalledWith([{ columnId: "name", direction: "asc" }]);
  });

  it("fires onSelectionChange when selecting all rows", () => {
    const onSelectionChange = vi.fn();
    const { getByRole } = render(<InteractiveDataGridHarness onSelectionChange={onSelectionChange} />);

    fireEvent.click(getByRole("checkbox", { name: /select all rows/i }));

    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    const [selectedIds, selectedRows] = onSelectionChange.mock.calls[0];
    expect([...selectedIds]).toEqual(["row-1"]);
    expect(selectedRows).toEqual([{ id: "row-1", name: "Row 1" }]);
  });

  it("selects a row from its checkbox without firing onRowClick", () => {
    const onRowClick = vi.fn();
    const onSelectionChange = vi.fn();
    const { getByRole } = render(
      <InteractiveDataGridHarness onRowClick={onRowClick} onSelectionChange={onSelectionChange} />,
    );

    fireEvent.click(getByRole("checkbox", { name: /select row row-1/i }));

    expect(onRowClick).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    const [selectedIds] = onSelectionChange.mock.calls[0];
    expect([...selectedIds]).toEqual(["row-1"]);
  });

  it("toggles additional rows from checkboxes instead of replacing the selection", () => {
    const onRowClick = vi.fn();
    const onSelectionChange = vi.fn();
    const { getByRole } = render(
      <InteractiveDataGridHarness
        onRowClick={onRowClick}
        onSelectionChange={onSelectionChange}
        rows={[
          { id: "row-1", name: "Row 1" },
          { id: "row-2", name: "Row 2" },
        ]}
      />,
    );

    fireEvent.click(getByRole("checkbox", { name: /select row row-1/i }));
    fireEvent.click(getByRole("checkbox", { name: /select row row-2/i }));

    expect(onRowClick).not.toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenCalledTimes(2);
    const [selectedIds] = onSelectionChange.mock.calls[1] ?? [];
    expect(selectedIds).toEqual(new Set(["row-1", "row-2"]));
  });

  it("still fires onRowClick when a row cell is clicked", () => {
    const onRowClick = vi.fn();
    const { container } = render(<InteractiveDataGridHarness onRowClick={onRowClick} />);
    const cell = container.querySelector('[data-row-id="row-1"] [role="gridcell"]');
    if (cell == null) throw new Error("DataGrid: expected a rendered cell for row-1");
    fireEvent.click(cell);

    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0]?.[0]).toEqual({ id: "row-1", name: "Row 1" });
  });

  it("identifies nested interactive controls as row-click blockers", () => {
    const cell = document.createElement("div");
    const button = document.createElement("button");
    const label = document.createElement("span");
    label.textContent = "Open menu";
    button.append(label);
    cell.append(button);

    expect(isDataGridInteractiveRowClickTarget(label.firstChild)).toBe(true);
    expect(isDataGridInteractiveRowClickTarget(cell)).toBe(false);
  });
});

describe("DataGrid horizontal scrolling", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 320;
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect() {
        return {
          x: 0,
          y: 0,
          width: 320,
          height: 44,
          top: 0,
          left: 0,
          right: 320,
          bottom: 44,
          toJSON() {
            return this;
          },
        } as DOMRect;
      },
    );
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return 400;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return 400;
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sizes the sticky clipping layer to the full row width", () => {
    const { container } = render(<WideDataGridHarness />);

    const rowsClip = container.querySelector("[data-data-grid-rows-clip]");

    expect(rowsClip).toBeInstanceOf(HTMLElement);
    expect((rowsClip as HTMLElement).style.minWidth).toBe("740px");
  });

  it("lets the columns popover escape the sticky toolbar bounds", () => {
    const { container, getByTitle } = render(<WideDataGridHarness />);

    fireEvent.click(getByTitle("Columns"));

    const stickyChrome = container.querySelector('[role="grid"]')?.firstElementChild;
    expect(stickyChrome).toBeInstanceOf(HTMLElement);
    expect((stickyChrome as HTMLElement).className).toContain("overflow-visible");
    expect(container.textContent).toContain("Email");
  });

  it("puts the horizontal scrollbar under the column headers when position is top", () => {
    const { container } = render(<WideDataGridHarness horizontalScrollbarPosition="top" />);

    const stickyChrome = container.querySelector('[role="grid"]')?.firstElementChild;
    expect(stickyChrome).toBeInstanceOf(HTMLElement);
    const headerScroll = stickyChrome?.querySelector(".overflow-x-auto");
    expect(headerScroll).toBeInstanceOf(HTMLElement);

    const bodyScroll = container.querySelector('[role="grid"]')?.children.item(1);
    expect(bodyScroll).toBeInstanceOf(HTMLElement);
    expect((bodyScroll as HTMLElement).className).toContain("overflow-x-hidden");
    expect((bodyScroll as HTMLElement).className).toContain("overflow-y-auto");

    Object.defineProperty(headerScroll as HTMLElement, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 0,
    });
    Object.defineProperty(bodyScroll as HTMLElement, "scrollLeft", {
      configurable: true,
      writable: true,
      value: 0,
    });

    (headerScroll as HTMLElement).scrollLeft = 120;
    fireEvent.scroll(headerScroll as HTMLElement);
    expect((bodyScroll as HTMLElement).scrollLeft).toBe(120);
  });
});

describe("DataGrid loading skeleton", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows a full-width shimmer when loading before any columns are known", () => {
    function SchemaPendingHarness() {
      const [state, setState] = useState(() => createDefaultDataGridState([]));
      return (
        <DataGrid<Row>
          columns={[]}
          rows={[]}
          getRowId={(row) => row.id}
          state={state}
          onChange={setState}
          isLoading
        />
      );
    }

    const { container } = render(<SchemaPendingHarness />);

    const skeleton = container.querySelector("[data-data-grid-schema-pending-skeleton]");
    expect(skeleton).toBeInstanceOf(HTMLElement);
    // Five placeholder columns × 10 rows → visible shimmer cells, not an empty pane.
    expect(skeleton?.querySelectorAll("[role='row']").length).toBe(10);
  });

  it("uses per-column skeleton rows once the schema is known", () => {
    function KnownSchemaHarness() {
      const [state, setState] = useState(() => createDefaultDataGridState(columns));
      return (
        <DataGrid<Row>
          columns={columns}
          rows={[]}
          getRowId={(row) => row.id}
          state={state}
          onChange={setState}
          isLoading
        />
      );
    }

    const { container } = render(<KnownSchemaHarness />);

    expect(container.querySelector("[data-data-grid-schema-pending-skeleton]")).toBeNull();
    const rowsClip = container.querySelector("[data-data-grid-rows-clip]");
    expect(rowsClip?.querySelectorAll("[role='row']").length).toBe(8);
  });
});
