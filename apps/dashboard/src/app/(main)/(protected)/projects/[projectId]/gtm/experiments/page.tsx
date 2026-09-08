import Loading from "@/app/loading";
import { Suspense } from "react";
import PageClient from "./page-client";

export const metadata = { title: "Growth Experiments" };
// The page depends on the authenticated project provider in the parent layout,
// so it cannot render an independently validated instant shell.
export const instant = false;

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <PageClient />
    </Suspense>
  );
}
