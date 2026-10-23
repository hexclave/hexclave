// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamPageRequest } from "../utils/team-lists";
import { useTeamPages, type TeamPagesSource } from "./use-team-pages";

type FakeTeam = { id: string, displayName: string };
type FakeTeamList = FakeTeam[] & { nextCursor: string | null };

const pageSize = 200;

/**
 * Mimics the SDK: `useTeams` returns a cached array (stable identity until invalidated), and pages are
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
  let cached: FakeTeamList | null = null;
  const listTeams = vi.fn(async (options: TeamPageRequest) => page(options.query, options.cursor));
  const source: TeamPagesSource<FakeTeam> = {
    useTeams: () => {
      cached ??= page(undefined, undefined);
      return cached;
    },
    listTeams,
  };
  const invalidate = () => {
    cached = null;
  };
  return { source, listTeams, invalidate, page };
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
  /** Lets the debounce elapse and the resulting search request settle. */
  async function settleSearch() {
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {});
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
    vi.restoreAllMocks();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  });

  it("walks every page exactly once until there is no cursor left", async () => {
    const { source, listTeams } = createFakeSource(450);
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
    expect(listTeams).toHaveBeenCalledTimes(2);

    // Nothing left to load: a further call must not hit the API.
    await act(() => current().loadMore());
    expect(listTeams).toHaveBeenCalledTimes(2);
  });

  it("reports a single page for users with at most 200 teams", async () => {
    const { source } = createFakeSource(200);
    await render(source);
    expect(current().teams).toHaveLength(200);
    expect(current().hasMore).toBe(false);
    expect(current().hasMultiplePages).toBe(false);
  });

  it("ignores a second loadMore while one is in flight", async () => {
    const { source, listTeams } = createFakeSource(450);
    await render(source);
    await act(async () => {
      await Promise.all([current().loadMore(), current().loadMore()]);
    });
    expect(listTeams).toHaveBeenCalledTimes(1);
    expect(current().teams).toHaveLength(400);
  });

  it("searches server-side after the debounce, keeping the previous list on screen meanwhile", async () => {
    const { source, listTeams } = createFakeSource(450);
    await render(source);
    await render(source, "Zebra");
    expect(current().teams).toHaveLength(200);
    expect(current().isSearchPending).toBe(true);
    expect(listTeams).not.toHaveBeenCalled();

    await settleSearch();
    expect(listTeams).toHaveBeenCalledWith({ query: "Zebra", limit: 200 });
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);
    expect(current().activeQuery).toBe("Zebra");
    expect(current().isSearchPending).toBe(false);
    expect(current().searchFailed).toBe(false);
    expect(current().hasMore).toBe(false);
    // The "is there more than one page" signal is about the user's teams, not the search results.
    expect(current().hasMultiplePages).toBe(true);
  });

  it("runs an initial query on mount", async () => {
    const { source } = createFakeSource(450);
    await render(source, "Zebra");
    await act(async () => {});
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);
    expect(current().isSearchPending).toBe(false);
  });

  it("passes the active query along with the cursor when loading more search results", async () => {
    const { source, listTeams } = createFakeSource(450);
    await render(source, "Team");
    await act(async () => {});
    expect(current().hasMore).toBe(true);
    await act(() => current().loadMore());
    expect(listTeams).toHaveBeenLastCalledWith({ query: "Team", limit: 200, cursor: "team-0199" });
    expect(current().teams).toHaveLength(400);
  });

  it("treats a whitespace-only query as no query", async () => {
    const { source, listTeams } = createFakeSource(450);
    await render(source, "   ");
    await settleSearch();
    expect(listTeams).not.toHaveBeenCalled();
    expect(current().activeQuery).toBe("");
    expect(current().isSearchPending).toBe(false);
    expect(current().teams).toHaveLength(200);
  });

  it("goes straight back to the unfiltered list when the search is cleared", async () => {
    const { source } = createFakeSource(450);
    await render(source, "Zebra");
    await act(async () => {});
    await render(source, "");
    await settleSearch();
    expect(current().activeQuery).toBe("");
    expect(current().teams).toHaveLength(200);

    // The next search must not briefly resurrect the "Zebra" results from before the box was cleared.
    await render(source, "Team 4");
    expect(current().isSearchPending).toBe(true);
    expect(current().teams).toHaveLength(200);
    expect(current().activeQuery).toBe("");
  });

  it("reports a failed search instead of throwing, and recovers on retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { source, listTeams, page } = createFakeSource(450);
    await render(source);
    listTeams.mockRejectedValueOnce(new Error("network down"));
    await render(source, "Zebra");
    await settleSearch();
    expect(current().searchFailed).toBe(true);
    expect(current().isSearchPending).toBe(false);

    let resolveRetry: ((value: FakeTeamList) => void) | null = null;
    listTeams.mockImplementationOnce(() => new Promise(resolve => {
      resolveRetry = resolve;
    }));
    await act(async () => {
      current().retrySearch();
    });
    expect(current().searchFailed).toBe(false);
    expect(current().isSearchPending).toBe(true);
    await act(async () => {
      if (resolveRetry == null) throw new Error("The retry request was never started");
      resolveRetry(page("Zebra", undefined));
    });
    expect(current().searchFailed).toBe(false);
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);
    expect(listTeams).toHaveBeenCalledTimes(2);
  });

  it("keeps the last successful search in place when a later search fails, and during its retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { source, listTeams, page } = createFakeSource(450);
    await render(source, "Zebra");
    await act(async () => {});
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);

    listTeams.mockRejectedValueOnce(new Error("network down"));
    await render(source, "Zebra N");
    await settleSearch();
    expect(current().searchFailed).toBe(true);
    expect(current().activeQuery).toBe("Zebra");
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);

    let resolveRetry: ((value: FakeTeamList) => void) | null = null;
    listTeams.mockImplementationOnce(() => new Promise(resolve => {
      resolveRetry = resolve;
    }));
    await act(async () => {
      current().retrySearch();
    });
    // While the retry is in flight, the list must not flash back to the unfiltered teams.
    expect(current().isSearchPending).toBe(true);
    expect(current().activeQuery).toBe("Zebra");
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);

    await act(async () => {
      if (resolveRetry == null) throw new Error("The retry request was never started");
      resolveRetry(page("Zebra N", undefined));
    });
    expect(current().activeQuery).toBe("Zebra N");
    expect(current().searchFailed).toBe(false);
  });

  it("re-runs an open search when the user's teams are refreshed", async () => {
    const { source, listTeams, invalidate } = createFakeSource(450);
    await render(source, "Zebra");
    await act(async () => {});
    expect(listTeams).toHaveBeenCalledTimes(1);

    invalidate();
    await render(source, "Zebra");
    await act(async () => {});
    expect(listTeams).toHaveBeenCalledTimes(2);
    expect(listTeams).toHaveBeenLastCalledWith({ query: "Zebra", limit: 200 });
    // A background refresh doesn't put the search back into the pending state.
    expect(current().isSearchPending).toBe(false);
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);
  });

  it("clears a search failure when the query changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { source, listTeams } = createFakeSource(450);
    await render(source);
    listTeams.mockRejectedValueOnce(new Error("network down"));
    await render(source, "Zebra");
    await settleSearch();
    expect(current().searchFailed).toBe(true);

    await render(source, "Zebra Needle");
    await settleSearch();
    expect(current().searchFailed).toBe(false);
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);
  });

  it("ignores a slow response for a query that is no longer current", async () => {
    const { source, listTeams, page } = createFakeSource(450);
    let resolveSlow: ((value: FakeTeamList) => void) | null = null;
    listTeams.mockImplementationOnce(() => new Promise(resolve => {
      resolveSlow = resolve;
    }));
    await render(source);
    await render(source, "Team");
    await settleSearch();
    await render(source, "Zebra");
    await settleSearch();
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);

    await act(async () => {
      if (resolveSlow == null) throw new Error("The slow request was never started");
      resolveSlow(page("Team", undefined));
    });
    expect(current().activeQuery).toBe("Zebra");
    expect(current().teams.map(team => team.displayName)).toEqual(["Zebra Needle"]);
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
    await settleSearch();
    expect(current().teams.length).toBeGreaterThan(0);
    expect(current().teams.every(team => team.displayName.includes("Team 4"))).toBe(true);
  });
});
