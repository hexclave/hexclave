import PageClient from "./page-client";

export const metadata = {
  title: "Product",
};

export default async function Page(props: { params: Promise<{ productId: string }> }) {
  const { productId } = await props.params;
  return <PageClient productId={productId} />;
}
