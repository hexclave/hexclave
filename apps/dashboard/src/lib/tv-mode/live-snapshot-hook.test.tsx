// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTvFixtureSnapshot, getTvProfileFixture } from "./fixtures";
import {
  useTvLiveSnapshot,
  useTvSnapshotPolling,
  type TvLiveSnapshotState,
} from "./live-snapshot";
import { TvSnapshotRequestError } from "@/lib/hexclave-app-internals";

declare global {
  // React reads this flag off the global object to decide whether act() is allowed. It is not part of the
  // ambient DOM types, so declare it here: this suite toggles it per test and restores the previous value.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const fetchTvSnapshotMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hexclave-app-internals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hexclave-app-internals")>()),
  fetchTvSnapshotOrThrow: fetchTvSnapshotMock,
}));

const profile = getTvProfileFixture("company-pulse");
if (profile == null) throw new Error("Missing company-pulse fixture profile");
const snapshot = createTvFixtureSnapshot("project", profile);
const ADMIN_APP = {};

function Probe({
  adminApp = ADMIN_APP,
  onState,
  projectId = "project",
  profileId = "company-pulse",
}: {
  adminApp?: object,
  onState: (state: TvLiveSnapshotState) => void,
  projectId?: string,
  profileId?: string,
}) {
  const state = useTvLiveSnapshot({
    adminApp,
    projectId,
    profileId,
    enabled: true,
  });
  onState(state);
  return null;
}

function PollingProbe({
  loadSnapshot,
  onState,
  sourceKey = "display-a",
}: {
  loadSnapshot: (signal: AbortSignal) => Promise<typeof snapshot>,
  onState: (state: TvLiveSnapshotState) => void,
  sourceKey?: string,
}) {
  const state = useTvSnapshotPolling({
    loadSnapshot,
    enabled: true,
    sourceKey,
  });
  onState(state);
  return null;
}

describe("useTvLiveSnapshot", () => {
  const previousReactActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchTvSnapshotMock.mockReset();
    fetchTvSnapshotMock.mockResolvedValue(snapshot);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousReactActEnvironment == null) {
      Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    } else {
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
        configurable: true,
        value: previousReactActEnvironment,
      });
    }
  });

  it("polls without overlap, pauses while hidden, and refreshes on restoration", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedStates: TvLiveSnapshotState[] = [];

    await act(async () => {
      root.render(<Probe onState={(state) => {
        observedStates.push(state);
      }} />);
      await Promise.resolve();
    });
    expect(fetchTvSnapshotMock).toHaveBeenCalledTimes(1);
    expect(observedStates.at(-1)?.snapshot?.project.id).toBe("project");

    const pendingSnapshot = Promise.withResolvers<typeof snapshot>();
    fetchTvSnapshotMock.mockReturnValueOnce(pendingSnapshot.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchTvSnapshotMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchTvSnapshotMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      pendingSnapshot.resolve(snapshot);
      await Promise.resolve();
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchTvSnapshotMock).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(fetchTvSnapshotMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    expect(fetchTvSnapshotMock).toHaveBeenCalledTimes(4);

    await act(async () => {
      root.unmount();
    });
  });

  it("shows initial offline failure and recovers immediately when the browser reconnects", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    fetchTvSnapshotMock.mockRejectedValueOnce(new Error("offline"));
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedStates: TvLiveSnapshotState[] = [];

    await act(async () => {
      root.render(<Probe onState={(state) => {
        observedStates.push(state);
      }} />);
      await Promise.resolve();
    });
    expect(observedStates.at(-1)).toMatchObject({
      snapshot: null,
      loading: false,
      unavailableReason: "offline",
    });

    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
    });
    expect(observedStates.at(-1)).toMatchObject({
      snapshot: { project: { id: "project" }, connectionStatus: "online" },
      loading: false,
      unavailableReason: null,
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("replaces an initial request error with offline state when connectivity drops", async () => {
    fetchTvSnapshotMock.mockRejectedValueOnce(new Error("request failed"));
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedStates: TvLiveSnapshotState[] = [];

    await act(async () => {
      root.render(<Probe onState={(state) => {
        observedStates.push(state);
      }} />);
      await Promise.resolve();
    });
    expect(observedStates.at(-1)?.unavailableReason).toBe("error");

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(observedStates.at(-1)).toMatchObject({
      snapshot: null,
      unavailableReason: "offline",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("marks retained data stale and offline without discarding it", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedStates: TvLiveSnapshotState[] = [];

    await act(async () => {
      root.render(<Probe onState={(state) => {
        observedStates.push(state);
      }} />);
      await Promise.resolve();
    });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });
    expect(observedStates.at(-1)?.snapshot).toMatchObject({
      project: { id: "project" },
      connectionStatus: "stale",
    });

    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(observedStates.at(-1)?.snapshot).toMatchObject({
      project: { id: "project" },
      connectionStatus: "offline",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("clears retained data after an authorization failure", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedStates: TvLiveSnapshotState[] = [];
    fetchTvSnapshotMock
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new TvSnapshotRequestError(401));

    await act(async () => {
      root.render(<Probe onState={(state) => observedStates.push(state)} />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(observedStates.at(-1)).toMatchObject({
      snapshot: null,
      unavailableReason: "unauthorized",
    });
    await act(async () => root.unmount());
  });

  it("does not let an in-flight response overwrite a newer offline event", async () => {
    const pending = Promise.withResolvers<typeof snapshot>();
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedStates: TvLiveSnapshotState[] = [];

    await act(async () => {
      root.render(<PollingProbe loadSnapshot={async () => await pending.promise} onState={(state) => observedStates.push(state)} />);
      await Promise.resolve();
    });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await act(async () => window.dispatchEvent(new Event("offline")));
    expect(observedStates.at(-1)).toMatchObject({ snapshot: null, unavailableReason: "offline" });

    await act(async () => {
      pending.resolve(snapshot);
      await pending.promise;
    });
    expect(observedStates.at(-1)?.snapshot?.connectionStatus).toBe("offline");

    await act(async () => root.unmount());
  });

  it("discards an older profile response when the route changes", async () => {
    const oldResponse = Promise.withResolvers<typeof snapshot>();
    const newSnapshot = {
      ...snapshot,
      profile: { ...snapshot.profile, id: "engineering-office" },
    };
    fetchTvSnapshotMock
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(newSnapshot);
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedStates: TvLiveSnapshotState[] = [];
    const onState = (state: TvLiveSnapshotState) => {
      observedStates.push(state);
    };

    await act(async () => {
      root.render(<Probe onState={onState} />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<Probe onState={onState} profileId="engineering-office" />);
      await Promise.resolve();
    });
    expect(fetchTvSnapshotMock).toHaveBeenNthCalledWith(
      2,
      ADMIN_APP,
      "engineering-office",
      expect.any(AbortSignal),
    );

    await act(async () => {
      oldResponse.resolve(snapshot);
      await Promise.resolve();
    });
    expect(observedStates.at(-1)?.snapshot?.profile.id).toBe("engineering-office");

    await act(async () => {
      root.unmount();
    });
  });

  it("discards an older project response when projects share a profile ID", async () => {
    const oldResponse = Promise.withResolvers<typeof snapshot>();
    const nextAdminApp = {};
    const newSnapshot = {
      ...snapshot,
      project: { ...snapshot.project, id: "project-b" },
    };
    fetchTvSnapshotMock
      .mockReturnValueOnce(oldResponse.promise)
      .mockResolvedValueOnce(newSnapshot);
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedStates: TvLiveSnapshotState[] = [];
    const onState = (state: TvLiveSnapshotState) => {
      observedStates.push(state);
    };

    await act(async () => {
      root.render(<Probe adminApp={ADMIN_APP} projectId="project-a" onState={onState} />);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<Probe adminApp={nextAdminApp} projectId="project-b" onState={onState} />);
      await Promise.resolve();
    });
    expect(fetchTvSnapshotMock).toHaveBeenNthCalledWith(
      2,
      nextAdminApp,
      "company-pulse",
      expect.any(AbortSignal),
    );

    await act(async () => {
      oldResponse.resolve(snapshot);
      await Promise.resolve();
    });
    expect(observedStates.at(-1)?.snapshot?.project.id).toBe("project-b");

    await act(async () => root.unmount());
  });

  it("does not reset retained data when the loader callback is recreated for the same source", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedStates: TvLiveSnapshotState[] = [];
    const firstLoader = vi.fn(async (_signal: AbortSignal) => snapshot);

    await act(async () => {
      root.render(<PollingProbe loadSnapshot={firstLoader} onState={(state) => observedStates.push(state)} />);
      await Promise.resolve();
    });
    expect(observedStates.at(-1)?.snapshot).toBe(snapshot);

    const replacementLoader = vi.fn(async (_signal: AbortSignal) => snapshot);
    await act(async () => {
      root.render(<PollingProbe loadSnapshot={replacementLoader} onState={(state) => observedStates.push(state)} />);
      await Promise.resolve();
    });

    expect(observedStates.at(-1)?.snapshot).toBe(snapshot);
    expect(firstLoader).toHaveBeenCalledTimes(1);
    expect(replacementLoader).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("times out a stalled request and resumes polling", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedStates: TvLiveSnapshotState[] = [];
    const stalled = new Promise<typeof snapshot>(() => {});
    const loadSnapshot = vi.fn()
      .mockReturnValueOnce(stalled)
      .mockResolvedValueOnce(snapshot);

    await act(async () => {
      root.render(<PollingProbe loadSnapshot={loadSnapshot} onState={(state) => observedStates.push(state)} />);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(observedStates.at(-1)).toMatchObject({
      snapshot: null,
      loading: false,
      unavailableReason: "error",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    expect(observedStates.at(-1)).toMatchObject({
      snapshot: { project: { id: "project" } },
      unavailableReason: null,
    });

    await act(async () => root.unmount());
  });

  it("aborts and ignores an in-flight request when the presentation unmounts", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const observedSignals: AbortSignal[] = [];
    const loadSnapshot = vi.fn(async (signal: AbortSignal) => {
      observedSignals.push(signal);
      return await new Promise<typeof snapshot>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });

    await act(async () => {
      root.render(<PollingProbe loadSnapshot={loadSnapshot} onState={() => {}} />);
      await Promise.resolve();
    });
    await act(async () => root.unmount());

    expect(observedSignals[0]?.aborted).toBe(true);
  });
});
