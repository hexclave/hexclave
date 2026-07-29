import { redirect } from "next/navigation";
export const metadata = { title: "Edit Product" };
export default async function Page(props: { params: Promise<{ projectId: string, productId: string }> }) {
  const { projectId, productId } = await props.params;
  redirect(`/projects/${projectId}/payments/products/${productId}/edit`);
}
