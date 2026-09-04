import { Metadata } from "next";
import PageClient from "./page-client";

export const metadata: Metadata = {
  title: "Edit Feature Flag",
};

type Params = {
  projectId: string,
  flagKey: string,
};

export default async function Page({ params }: { params: Promise<Params> }) {
  const { flagKey } = await params;
  return (
    <PageClient flagKey={flagKey} />
  );
}
