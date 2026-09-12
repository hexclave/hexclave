import { describe, expect, it, vi } from "vitest";
import {
  exitStandaloneTvPresentation,
  getTvPresentationWindowName,
  openTvPresentationWindow,
  TV_PRESENTATION_EXIT_FALLBACK_DELAY_MS,
  type TvPresentationExitEnvironment,
} from "./presentation-window";

describe("TV presentation window lifecycle", () => {
  it("uses one stable presentation window name per project", () => {
    expect([
      getTvPresentationWindowName("project-a"),
      getTvPresentationWindowName("project-a"),
      getTvPresentationWindowName("project-b"),
    ]).toMatchInlineSnapshot(`
      [
        "hexclave-tv-presentation-project-a",
        "hexclave-tv-presentation-project-a",
        "hexclave-tv-presentation-project-b",
      ]
    `);
  });

  it("opens and focuses the named project window", () => {
    const focus = vi.fn();
    const openWindow = vi.fn(() => ({ focus }));

    expect(openTvPresentationWindow({
      projectId: "project-a",
      url: "/projects/project-a/tv-mode/present/company-pulse",
      openWindow,
    })).toBe(true);
    expect(openWindow).toHaveBeenCalledWith(
      "/projects/project-a/tv-mode/present/company-pulse",
      "hexclave-tv-presentation-project-a",
    );
    expect(focus).toHaveBeenCalledOnce();
  });

  it("reports a blocked popup without trying to focus it", () => {
    expect(openTvPresentationWindow({
      projectId: "project-a",
      url: "/projects/project-a/tv-mode/present/company-pulse",
      openWindow: () => null,
    })).toBe(false);
  });

  function createExitEnvironment({
    fullscreen,
    closedAfterClose,
  }: {
    fullscreen: boolean,
    closedAfterClose: boolean,
  }) {
    let closed = false;
    let fallback: (() => void) | null = null;
    const environment: TvPresentationExitEnvironment = {
      isFullscreen: () => fullscreen,
      exitFullscreen: vi.fn(async () => undefined),
      scheduleFallback: vi.fn((callback, delayMs) => {
        expect(delayMs).toBe(TV_PRESENTATION_EXIT_FALLBACK_DELAY_MS);
        fallback = callback;
      }),
      closeWindow: vi.fn(() => {
        closed = closedAfterClose;
      }),
      isWindowClosed: () => closed,
      replaceLocation: vi.fn(),
    };
    return {
      environment,
      runFallback: () => {
        if (fallback == null) throw new Error("Exit fallback was not scheduled");
        fallback();
      },
    };
  }

  it("exits fullscreen before closing and does not redirect a closed window", async () => {
    const { environment, runFallback } = createExitEnvironment({
      fullscreen: true,
      closedAfterClose: true,
    });
    await exitStandaloneTvPresentation({ fallbackHref: "/projects/project-a/tv-mode", environment });
    expect(environment.exitFullscreen).toHaveBeenCalledOnce();
    expect(environment.closeWindow).toHaveBeenCalledOnce();
    runFallback();
    expect(environment.replaceLocation).not.toHaveBeenCalled();
  });

  it("falls back to the overview when the browser refuses to close", async () => {
    const { environment, runFallback } = createExitEnvironment({
      fullscreen: false,
      closedAfterClose: false,
    });
    await exitStandaloneTvPresentation({ fallbackHref: "/projects/project-a/tv-mode", environment });
    expect(environment.exitFullscreen).not.toHaveBeenCalled();
    runFallback();
    expect(environment.replaceLocation).toHaveBeenCalledWith("/projects/project-a/tv-mode");
  });

  it("continues closing when fullscreen exit fails", async () => {
    const { environment } = createExitEnvironment({
      fullscreen: true,
      closedAfterClose: false,
    });
    vi.mocked(environment.exitFullscreen).mockRejectedValue(new Error("Fullscreen exit failed"));
    await exitStandaloneTvPresentation({
      fallbackHref: "/projects/project-a/tv-mode",
      environment,
    });
    expect(environment.closeWindow).toHaveBeenCalledOnce();
    expect(environment.scheduleFallback).toHaveBeenCalledOnce();
  });
});
