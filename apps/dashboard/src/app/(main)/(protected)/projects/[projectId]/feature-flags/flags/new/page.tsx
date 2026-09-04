import { Metadata } from "next";
import PageClient from "./page-client";

export const metadata: Metadata = {
  title: "Create Feature Flag",
};

export default function Page() {
  return (
    <PageClient />
  );
}
