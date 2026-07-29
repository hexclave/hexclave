import { redirect } from "next/navigation";

export const metadata = {
  title: "Team Settings",
};

export default async function Page(props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  redirect(`/projects/${projectId}/app-configuration/teams`);
}
