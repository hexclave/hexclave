import type { Metadata } from "next";
import PageClient from "./page-client";

export const metadata: Metadata = {
  title: "TV Profile",
};

export default function Page() {
  return <PageClient />;
}
