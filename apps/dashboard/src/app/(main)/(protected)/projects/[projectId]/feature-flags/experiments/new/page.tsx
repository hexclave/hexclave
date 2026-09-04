import { Metadata } from "next";
import PageClient from "./page-client";

export const metadata: Metadata = {
  title: "New Experiment",
};

export default function Page() {
  return (
    <PageClient />
  );
}
