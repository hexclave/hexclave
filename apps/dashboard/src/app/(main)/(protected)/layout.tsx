import Loading from "@/app/loading";
import { Suspense } from "react";
import LayoutClient from "./layout-client";

export default function Layout({ children }: { children: React.ReactNode }) {
  // LayoutClient calls useUser(), which deliberately bails out of SSR via
  // suspendIfSsr(). With Cache Components / Instant Insights, that bailout must
  // happen under a Suspense boundary that owns this segment — root-layout
  // Suspense is not enough for nested layouts that suspend themselves.
  return (
    <Suspense fallback={<Loading />}>
      <LayoutClient>{children}</LayoutClient>
    </Suspense>
  );
}
