// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePublishedQa } from "./useSpacetimeDB";

const sdk = vi.hoisted(() => {
  class Connection {
    onConnect: (conn: Connection) => void = () => {};
    onDisconnect: (ctx: object, error?: Error) => void = () => {};
    onApplied: () => void = () => {};
    db = { publishedQa: { iter: () => [], onInsert: () => {}, onDelete: () => {}, onUpdate: () => {} } };
    subscriptionBuilder() {
      const builder = {
        onApplied: (cb: () => void) => {
          this.onApplied = cb;
          return builder;
        },
        onError: () => builder,
        subscribe: () => this.onApplied(),
      };
      return builder;
    }
    disconnect() { this.onDisconnect({}); }
  }
  const connections: Connection[] = [];
  return {
    connections,
    captureError: vi.fn(),
    builder: () => {
      const conn = new Connection();
      const builder = {
        withUri: () => builder,
        withDatabaseName: () => builder,
        onConnect: (cb: (conn: Connection) => void) => {
          conn.onConnect = cb;
          return builder;
        },
        onConnectError: () => builder,
        onDisconnect: (cb: (ctx: object, error?: Error) => void) => {
          conn.onDisconnect = cb;
          return builder;
        },
        build: () => {
          connections.push(conn);
          return conn;
        },
      };
      return builder;
    },
  };
});

vi.mock("../module_bindings", () => ({ DbConnection: { builder: sdk.builder } }));
vi.mock("@hexclave/shared/dist/utils/errors", async (importOriginal) => ({
  ...await importOriginal<typeof import("@hexclave/shared/dist/utils/errors")>(),
  captureError: sdk.captureError,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_SPACETIMEDB_HOST", "wss://example.test");
  sdk.connections.length = 0;
  sdk.captureError.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function connection(index: number) {
  const conn = sdk.connections.at(index);
  if (conn == null) throw new Error(`Expected connection ${index} to have been created`);
  return conn;
}

describe("SpacetimeDB disconnect compatibility", () => {
  it("shows established-connection failures and reconnects through onDisconnect", async () => {
    const { result } = renderHook(() => usePublishedQa());
    const first = connection(0);
    act(() => first.onConnect(first));
    expect(result.current.connectionState).toBe("connected");

    const error = new Error("WebSocket transport failed");
    act(() => first.onDisconnect({}, error));
    expect(result.current.connectionErrorMessage).toBe(error.message);
    expect(result.current.connectionState).toBe("connecting");
    expect(sdk.captureError).toHaveBeenCalledWith("spacetimedb-disconnect", error);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const second = connection(1);
    act(() => second.onConnect(second));
    expect(result.current.connectionState).toBe("connected");
    expect(result.current.connectionErrorMessage).toBeNull();

    act(() => first.onDisconnect({}, new Error("Stale connection")));
    expect(result.current.connectionState).toBe("connected");
    expect(result.current.connectionErrorMessage).toBeNull();
  });

  it("does not retry or report an error when the component unmounts", async () => {
    const { unmount } = renderHook(() => usePublishedQa());
    const first = connection(0);
    act(() => first.onConnect(first));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(sdk.connections).toHaveLength(1);
    expect(sdk.captureError).not.toHaveBeenCalled();
  });
});
