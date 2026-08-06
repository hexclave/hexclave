import { redirect } from "next/navigation";

export const metadata = {
  title: "Template Sent Emails",
};

export default async function Page(props: { params: Promise<{ projectId: string, templateId: string }> }) {
  const { projectId, templateId } = await props.params;
  redirect(`/projects/${encodeURIComponent(projectId)}/app-configuration/emails/templates/${encodeURIComponent(templateId)}/sent`);
}
