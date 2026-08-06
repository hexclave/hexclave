import PageClient from "./page-client";

export const metadata = { title: "Template Sent Emails" };

export default async function Page(props: { params: Promise<{ templateId: string }> }) {
  const params = await props.params;
  return <PageClient templateId={params.templateId} />;
}
