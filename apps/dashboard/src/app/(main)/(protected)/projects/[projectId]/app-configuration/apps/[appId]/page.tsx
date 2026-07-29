import { ALL_APPS, type AppId } from "@hexclave/shared/dist/apps/apps-config";
import { notFound } from "next/navigation";
import PageClient from "./page-client";

export const metadata = {
  title: "App",
};

export default async function Page({ params }: { params: Promise<{ appId: AppId }> }) {
  const appId = (await params).appId;
  if (!(appId in ALL_APPS)) {
    return notFound();
  }

  return (
    <PageClient appId={appId} />
  );
}
