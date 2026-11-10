// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqlConsole } from "./SqlConsole";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SQL Console", () => {
  it("runs the editor query and displays empty results", async () => {
    const fetchMock = vi.fn(async () => Response.json({ columns: ["id"], rows: [], elapsedMs: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<SqlConsole />);
    const view = within(container);
    fireEvent.click(view.getByRole("button", { name: "Run query" }));
    await waitFor(() => expect(view.getByText("No rows matched.")).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(view.getByRole("button", { name: "Run query" }).hasAttribute("disabled")).toBe(false);
  });
  it("renders returned columns and rows in the results grid", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 900, 400));
    vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.callback([{
          target, contentRect: new DOMRect(0, 0, 900, 400),
          borderBoxSize: [{ inlineSize: 900, blockSize: 400 }], contentBoxSize: [], devicePixelContentBoxSize: [],
        }], this);
      }
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      columns: ["question"], rows: [["fixture-value"]], elapsedMs: 3,
    })));
    const { container } = render(<SqlConsole />);
    const view = within(container);
    fireEvent.click(view.getByRole("button", { name: "Run query" }));
    await waitFor(() => expect(view.getByText("fixture-value")).not.toBeNull());
    expect(view.getByRole("button", { name: "Copy JSON" })).not.toBeNull();
  });
  it("shows query failures in an alert", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Query rejected.", { status: 400 })));
    const { container } = render(<SqlConsole />);
    const view = within(container);
    fireEvent.click(view.getByRole("button", { name: "Run query" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toBe("Query rejected."));
  });
  it("blocks invalid SQL before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<SqlConsole />);
    const view = within(container);
    fireEvent.change(view.getByRole("textbox", { name: "SQL query" }), { target: { value: "DELETE FROM query_ai_usage" } });
    fireEvent.click(view.getByRole("button", { name: "Run query" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Only SELECT"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("cancels an in-flight request and restores the editor", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    })));
    const { container } = render(<SqlConsole />);
    const view = within(container);
    fireEvent.click(view.getByRole("button", { name: "Run query" }));
    expect(view.getByRole("button", { name: "Running…" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(view.getByText("Query cancelled.")).not.toBeNull());
    expect(view.getByRole("textbox", { name: "SQL query" }).hasAttribute("disabled")).toBe(false);
  });
  it("lazily loads a view's columns and inserts a clicked column at the caret", async () => {
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ columns: ["id", "createdAt"], rows: [], elapsedMs: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<SqlConsole />);
    const view = within(container);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: /query_feedback/ }));
    await waitFor(() => expect(view.getByRole("button", { name: "createdAt" })).not.toBeNull());
    const body: unknown = JSON.parse(String(fetchMock.mock.calls[0]?.[1].body));
    expect(body).toMatchInlineSnapshot(`
      {
        "sql": "SELECT * FROM query_feedback LIMIT 1",
      }
    `);
    const editor = view.getByRole("textbox", { name: "SQL query" });
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error("SQL editor must be a textarea");
    fireEvent.change(editor, { target: { value: "SELECT  FROM query_feedback" } });
    editor.setSelectionRange(7, 7);
    fireEvent.click(view.getByRole("button", { name: "createdAt" }));
    // camelCase identifiers must be quoted for SpacetimeDB.
    expect(editor.value).toBe('SELECT "createdAt" FROM query_feedback');
  });
});
