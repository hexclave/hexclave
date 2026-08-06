import PageClient from "./page-client";

export const metadata = { title: "Email Theme Editor" };

export default async function Page(props: { params: Promise<{ themeId: string }> }) {
  const params = await props.params;
  return <PageClient themeId={params.themeId} />;
}
