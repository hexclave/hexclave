import { redirect } from "next/navigation";

export const metadata = { title: "Deployment secrets" };

export default async function Page(props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  redirect(`/projects/${projectId}/project-settings/deployments`);
}
