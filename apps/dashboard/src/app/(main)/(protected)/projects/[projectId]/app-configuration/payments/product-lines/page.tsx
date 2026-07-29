import { redirect } from "next/navigation";
export const metadata = { title: "Product Lines" };
export default async function Page(props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  redirect(`/projects/${projectId}/payments/product-lines`);
}
