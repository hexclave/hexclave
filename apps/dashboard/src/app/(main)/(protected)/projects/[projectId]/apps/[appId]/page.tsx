import { redirect } from "next/navigation";

export const metadata = {
  title: "App",
};

export default async function Page(props: { params: Promise<{ projectId: string, appId: string }> }) {
  const { projectId, appId } = await props.params;
  redirect(`/projects/${projectId}/app-configuration/apps/${appId}`);
}
