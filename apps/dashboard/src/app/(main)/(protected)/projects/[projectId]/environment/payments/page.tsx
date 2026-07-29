import { redirect } from "next/navigation";
export const metadata = { title: "Payments environment" };
export default async function Page(props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  redirect(`/projects/${projectId}/payments/settings`);
}
