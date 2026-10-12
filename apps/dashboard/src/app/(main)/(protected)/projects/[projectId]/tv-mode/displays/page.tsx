import type { Metadata } from "next";
import { Suspense } from "react";
import { SiteLoadingIndicator } from "@/components/site-loading-indicator";
import PageClient from "./page-client";

export const metadata: Metadata = {
  title: "TV Displays",
};

export default function Page() {
  return (
    <Suspense fallback={<SiteLoadingIndicator />}>
      <PageClient />
    </Suspense>
  );
}
