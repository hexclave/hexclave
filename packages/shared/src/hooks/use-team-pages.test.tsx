// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTeamPages, type TeamPagesSource } from "./use-team-pages";

type FakeTeam = { id: string, displayName: string };
type FakeTeamList = FakeTeam[] & { nextCursor: string | null };

const pageSize = 200;

/**
 * Mimics the SDK: `useTeams` returns a cached array per query (stable identity until invalidated), and pages are
 * keyset-paginated with the last team's ID as the cursor, at most 200 per request.
 */
function createFakeSource(total: number) {
  const all: FakeTeam[] = Array.from({ length: total }, (_, i) => ({
    id: `team-${String(i).padStart(4, "0")}`,
    displayName: i === 333 ? "Zebra Needle" : `Team ${i}`,
  }));
  const filter = (query: string | undefined) => query == null
    ? all
    : all.filter(team => team.id === query || team.displayName.toLowerCase().includes(query.toLowerCase()));
  const page = (query: string | undefined, cursor: string | undefined): FakeTeamList => {
    const list = filter(query);
    const start = cursor == null ? 0 : list.findIndex(team => team.id === cursor) + 1;
    const items = list.slice(start, start + pageSize);
    const nextCursor = start + pageSize < list.length ? items[items.length - 1].id : null;
    return Object.assign(items, { nextCursor });
  };
  let cache = new Map<string, FakeTeamList>();
  const source: TeamPagesSource<FakeTeam> = {
    useTeams: (options) => {
      const key = options?.query ?? "";
      const cached = cache.get(key) ?? page(options?.query, undefined);
      cache.set(key, cached);
      return cached;
    },
    listTeams: vi.fn(async (options: { query?: string, limit: number, cursor: string }) => page(options.query, options.cursor)),
  };
  const invalidate = () => {
    cache = new Map();
  };
  return { source, invalidate };
}

describe("useTeamPages", () => {
  const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  let latest: ReturnType<typeof useTeamPages<FakeTeam>> | null = null;

  function Harness(props: { source: TeamPagesSource<FakeTeam>, query: string }) {
    latest = useTeamPages(props.source, props.query);
    return null;
  }
  const current = () => {
    if (latest == null) throw new Error("Harness has not rendered yet");
    return latest;
  };

  async function render(source: TeamPagesSource<FakeTeam>, query = "") {
    await act(async () => {
      root?.render(<Harness source={source} query={query} />);
    });
  }

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    latest = null;
    vi.useRealTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  });

  it("walks every page exactly once until there is no cursor left", async () => {
    const { source } = createFakeSource(450);
    await render(source);
    expect(current().teams).toHaveLength(200);
    expect(current().hasMore).toBe(true);
    expect(current().hasMultiplePages).toBe(true);

    await act(() => current().loadMore());
    expect(current().teams).toHaveLength(400);
    await act(() => current().loadMore());

    const ids = current().teams.map(team => team.id);
    expect(ids).toHaveLength(450);
    expect(new Set(ids).size).toBe(450);
    expect(ids[449]).toBe("team-0449");
    expect(current().hasMore).toBe(false);
    expect(source.listTeams).toHaveBeenCalledTimes(2);

    // Nothing left to load: a further call must not hit the API.
    await act(() => current().loadMore());
    expect(source.listTeams).toHaveBeenCalledTimes(2);
  });

  it("reports a single page for users with at most 200 teams", async () => {
    const { source } = createFakeSource(200);
    await render(source);
    expect(current().teams).toHaveLength(200);
    expect(current().hasMore).toBe(false);
    expect(current().hasMultiplePages).toBe(false);
  });

  it("ignores a second loadMore while one is in flight", async () => {
    const { source } = createFakeSource(450);
    await render(source);
    await act(async () => {
      await Promise.all([current().loadMore(), current().loadMore()]);
    });
    expect(source.listTeams).toHaveBeenCalledTimes(1);
    expect(current().teams).toHaveLength(400);
  });

  it("searches server-side after the debounce and pages within the search", async () => {
    const { source } = createFakeSource(450);
    await render(source);
    await render(source, "Zebra");
    // Still debouncing: the unfiltered list stays on screen, flagged as pending.
    expect(current().teams).toHaveLength(200);
    expect(current().isSearchPending).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);
    expect(current().activeQuery).toBe("Zebra");
    expect(current().isSearchPending).toBe(false);
    expect(current().hasMore).toBe(false);
    // The "is there more than one page" signal is about the user's teams, not the search results.
    expect(current().hasMultiplePages).toBe(true);
  });

  it("passes the active query along with the cursor when loading more search results", async () => {
    const { source } = createFakeSource(450);
    await render(source, "Team");
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(current().hasMore).toBe(true);
    await act(() => current().loadMore());
    expect(source.listTeams).toHaveBeenLastCalledWith({ query: "Team", limit: 200, cursor: "team-0199" });
  });

  it("uses the initial query immediately on mount, without waiting for the debounce", async () => {
    const { source } = createFakeSource(450);
    await render(source, "Zebra");
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);
    expect(current().isSearchPending).toBe(false);
  });

  it("treats a whitespace-only query as no query", async () => {
    const { source } = createFakeSource(450);
    await render(source, "   ");
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(current().activeQuery).toBe("");
    expect(current().isSearchPending).toBe(false);
    expect(current().teams).toHaveLength(200);
  });

  it("drops later pages when the first page changes, instead of stitching them onto a different list", async () => {
    const { source, invalidate } = createFakeSource(450);
    await render(source);
    await act(() => current().loadMore());
    expect(current().teams).toHaveLength(400);

    invalidate();
    await render(source);
    expect(current().teams).toHaveLength(200);
    expect(current().hasMore).toBe(true);
  });

  it("drops later pages when the search query changes", async () => {
    const { source } = createFakeSource(450);
    await render(source);
    await act(() => current().loadMore());
    expect(current().teams).toHaveLength(400);

    await render(source, "Team 4");
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(current().teams.every(team => team.displayName.includes("Team 4"))).toBe(true);
  });
});
