import { Metadata } from "next";
import PageClient from "./page-client";

export const metadata: Metadata = {
  title: "Experiment",
};

type Params = {
  projectId: string,
  experimentId: string,
};

export default async function Page({ params }: { params: Promise<Params> }) {
  const { experimentId } = await params;
  return (
    <PageClient experimentId={experimentId} />
  );
}
