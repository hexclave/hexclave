import { redirect } from "next/navigation";

export const metadata = {
  title: "Sign-up Rules",
};

export default async function Page(props: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await props.params;
  redirect(`/projects/${projectId}/sign-up-rules`);
}
