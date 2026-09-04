import { Metadata } from "next";
import PageClient from "./page-client";

export const metadata: Metadata = {
  title: "Feature Flags",
};

export default function Page() {
  return (
    <PageClient />
  );
}
