import { redirect } from "next/navigation";

import { issuesListHref } from "../issue-links";

export default async function Page(props: {
  params: Promise<{ projectId: string }>,
}) {
  const { projectId } = await props.params;
  redirect(issuesListHref(projectId));
}
