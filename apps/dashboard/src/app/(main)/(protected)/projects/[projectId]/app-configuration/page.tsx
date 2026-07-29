import { redirect } from "next/navigation";

export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  redirect(`/projects/${encodeURIComponent(projectId)}/app-configuration/apps`);
}
