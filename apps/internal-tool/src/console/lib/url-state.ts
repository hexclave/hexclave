"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * A single query-string parameter as React state. The console keeps "which row is open" in the URL
 * (`?id=…`) so a reviewer can paste a link to a specific call, and the browser back button closes
 * the panel. `router.replace` (not push) for in-page changes keeps the history from filling up
 * with every row a reviewer clicked through; `push: true` is for cross-page jumps.
 */
export function useQueryParam(name: string): [string | null, (value: string | null) => void] {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const value = searchParams.get(name);
  const setValue = useCallback((next: string | null) => {
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (next == null) params.delete(name);
    else params.set(name, next);
    const query = params.toString();
    router.replace(query === "" ? pathname : `${pathname}?${query}`, { scroll: false });
  }, [name, pathname, router, searchParams]);
  return [value, setValue];
}

/** Link target for another console page with an optional open row, eg. `/console/mcp?id=42`. */
export function consoleHref(path: string, params: Record<string, string | undefined> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value != null) search.set(key, value);
  }
  const query = search.toString();
  return query === "" ? path : `${path}?${query}`;
}
