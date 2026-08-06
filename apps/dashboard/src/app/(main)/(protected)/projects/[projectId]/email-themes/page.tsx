import { redirect } from "next/navigation";

export const metadata = {
  title: "Email Themes",
};

export default async function Page(props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  redirect(`/projects/${encodeURIComponent(projectId)}/app-configuration/emails/themes`);
}
