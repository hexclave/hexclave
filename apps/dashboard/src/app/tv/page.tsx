import type { Metadata } from "next";
import IndependentTvPageClient from "./page-client";

export const metadata: Metadata = {
  title: "TV Display",
  robots: { index: false, follow: false },
};

export default function Page() {
  return <IndependentTvPageClient />;
}
