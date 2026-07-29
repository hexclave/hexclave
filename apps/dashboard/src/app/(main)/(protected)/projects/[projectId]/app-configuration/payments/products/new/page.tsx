import { redirect } from "next/navigation";
export const metadata = { title: "New Product" };
export default async function Page(props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  redirect(`/projects/${projectId}/payments/products/new`);
}
