import { redirect } from "next/navigation";

export const metadata = {
  title: "Email Theme Editor",
};

export default async function Page(props: { params: Promise<{ projectId: string, themeId: string }> }) {
  const { projectId, themeId } = await props.params;
  redirect(`/projects/${encodeURIComponent(projectId)}/app-configuration/emails/themes/${encodeURIComponent(themeId)}`);
}
