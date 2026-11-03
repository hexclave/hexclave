import type { Metadata } from "next";
import PageClient from "./page-client";

export const metadata: Metadata = {
  title: "Upgrade",
};

export default function Page() {
  return <PageClient />;
}
