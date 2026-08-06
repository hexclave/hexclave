"use client";

import PageClient from "../../../../../email-templates/[templateId]/sent/page-client";

export default function TemplateSentPageClient(props: { templateId: string }) {
  return <PageClient templateId={props.templateId} />;
}
