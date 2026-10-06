import PageClient from "./page-client";
import { Suspense } from "react";

export const metadata = { title: "Issue" };

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageClient />
    </Suspense>
  );
}
