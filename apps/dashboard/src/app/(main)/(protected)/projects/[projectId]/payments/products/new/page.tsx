import { redirect } from "next/navigation";

export const metadata = {
  title: "New Product",
};

export default async function Page(props: {
  params: Promise<{ projectId: string }>,
  searchParams: Promise<Record<string, string | string[] | undefined>>,
}) {
  const { projectId } = await props.params;
  const searchParams = await props.searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === "string") {
      qs.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        qs.append(key, entry);
      }
    }
  }
  const query = qs.toString();
  redirect(`/projects/${encodeURIComponent(projectId)}/app-configuration/payments/products/new${query ? `?${query}` : ""}`);
}
