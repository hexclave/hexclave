"use client";

import { useSyncExternalStore } from "react";

/**
 * Local port of apps/dashboard/src/lib/theme.tsx (minus the dashboard-only preview-mode default),
 * so the internal tool reads and writes the same `theme` localStorage key and applies the same
 * `light`/`dark` class on `<html>`.
 */
export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "theme";

let currentTheme: Theme = "system";

if (typeof window !== "undefined") {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") {
      currentTheme = stored;
    }
  } catch { /* localStorage unavailable (eg. private browsing) */ }
}

const themeListeners = new Set<() => void>();

function notifyThemeListeners() {
  for (const listener of themeListeners) listener();
}

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

function getThemeSnapshot(): Theme {
  return currentTheme;
}

function getThemeServerSnapshot(): Theme {
  return "system";
}

const darkMq = typeof window !== "undefined"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;

const systemListeners = new Set<() => void>();

if (darkMq) {
  darkMq.addEventListener("change", () => {
    if (currentTheme === "system") {
      applyThemeToDOM(darkMq.matches ? "dark" : "light");
    }
    for (const listener of systemListeners) listener();
  });
}

function subscribeSystem(listener: () => void): () => void {
  systemListeners.add(listener);
  return () => {
    systemListeners.delete(listener);
  };
}

function getSystemSnapshot(): ResolvedTheme {
  return darkMq?.matches === true ? "dark" : "light";
}

function getSystemServerSnapshot(): ResolvedTheme {
  return "light";
}

function subscribeMounted(): () => void {
  return () => {};
}

function getMountedClient(): boolean {
  return true;
}

function getMountedServer(): boolean {
  return false;
}

function applyThemeToDOM(resolved: ResolvedTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
}

function resolve(theme: Theme, system: ResolvedTheme): ResolvedTheme {
  return theme === "system" ? system : theme;
}

export function setTheme(theme: Theme) {
  currentTheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* localStorage unavailable */ }
  applyThemeToDOM(resolve(theme, getSystemSnapshot()));
  notifyThemeListeners();
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeServerSnapshot);
  const systemTheme = useSyncExternalStore(subscribeSystem, getSystemSnapshot, getSystemServerSnapshot);
  const resolvedTheme = resolve(theme, systemTheme);
  const mounted = useSyncExternalStore(subscribeMounted, getMountedClient, getMountedServer);

  return { theme, resolvedTheme, systemTheme, setTheme, mounted };
}
