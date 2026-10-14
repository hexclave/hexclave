import type { Metadata } from "next";
import { Suspense } from "react";
import PageClient from "./page-client";

export const metadata: Metadata = {
  title: "TV Mode Presentation",
};

export default function Page() {
  return (
    <Suspense fallback={<div className="h-dvh bg-[#070910]" />}>
      <PageClient />
    </Suspense>
  );
}
