"use client";

import { useCallback, useState } from "react";
import { captureError } from "@hexclave/shared/dist/utils/errors";

export const TV_PRESENTATION_EXIT_FALLBACK_DELAY_MS = 150;

export function getTvPresentationWindowName(projectId: string): string {
  return `hexclave-tv-presentation-${projectId}`;
}

type OpenPresentationWindow = (
  url: string,
  target: string,
) => Pick<Window, "focus"> | null;

export function openTvPresentationWindow({
  projectId,
  url,
  openWindow,
}: {
  projectId: string,
  url: string,
  openWindow: OpenPresentationWindow,
}): boolean {
  const presentationWindow = openWindow(url, getTvPresentationWindowName(projectId));
  if (presentationWindow == null) return false;
  presentationWindow.focus();
  return true;
}

export function useTvPresentationLauncher(projectId: string) {
  const [popupBlocked, setPopupBlocked] = useState(false);

  const launchPresentation = useCallback((url: string) => {
    const opened = openTvPresentationWindow({
      projectId,
      url,
      openWindow: (presentationUrl, target) => window.open(presentationUrl, target),
    });
    setPopupBlocked(!opened);
  }, [projectId]);

  return {
    launchPresentation,
    popupBlocked,
  };
}

export type TvPresentationExitEnvironment = {
  isFullscreen: () => boolean,
  exitFullscreen: () => Promise<void>,
  scheduleFallback: (callback: () => void, delayMs: number) => void,
  closeWindow: () => void,
  isWindowClosed: () => boolean,
  replaceLocation: (url: string) => void,
};

export async function exitStandaloneTvPresentation({
  fallbackHref,
  environment,
}: {
  fallbackHref: string,
  environment: TvPresentationExitEnvironment,
}): Promise<void> {
  try {
    if (environment.isFullscreen()) {
      try {
        await environment.exitFullscreen();
      } catch (cause) {
        captureError("tv-presentation-exit-fullscreen", cause);
      }
    }
  } finally {
    environment.scheduleFallback(() => {
      if (!environment.isWindowClosed()) {
        environment.replaceLocation(fallbackHref);
      }
    }, TV_PRESENTATION_EXIT_FALLBACK_DELAY_MS);
    environment.closeWindow();
  }
}

export function getBrowserTvPresentationExitEnvironment(): TvPresentationExitEnvironment {
  return {
    isFullscreen: () => document.fullscreenElement != null,
    exitFullscreen: () => document.exitFullscreen(),
    scheduleFallback: (callback, delayMs) => {
      window.setTimeout(callback, delayMs);
    },
    closeWindow: () => window.close(),
    isWindowClosed: () => window.closed,
    replaceLocation: (url) => window.location.replace(url),
  };
}
