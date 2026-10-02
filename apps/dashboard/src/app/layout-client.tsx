"use client";

import Loading from "@/app/loading";
import { isIndependentTvDisplayPath } from "@/lib/tv-mode/routes";
import { usePathname } from "next/navigation";
import React, { lazy, Suspense } from "react";

const DashboardLayoutClient = lazy(() => import("./dashboard-layout-client"));

export function LayoutClient(props: {
  children: React.ReactNode,
  translationLocale?: string,
}) {
  const pathname = usePathname();

  // Independent displays authenticate only through the narrowly scoped TV
  // credential endpoints. Loading the dashboard provider tree here would also
  // initialize dashboard identity, analytics, replay, and development tooling
  // before the display has any dashboard principal or reason to use them.
  if (isIndependentTvDisplayPath(pathname)) {
    return props.children;
  }

  return (
    <Suspense fallback={<Loading />}>
      <DashboardLayoutClient translationLocale={props.translationLocale}>
        {props.children}
      </DashboardLayoutClient>
    </Suspense>
  );
}
