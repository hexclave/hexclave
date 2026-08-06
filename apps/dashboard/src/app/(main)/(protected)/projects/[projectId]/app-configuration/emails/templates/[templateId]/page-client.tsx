"use client";

import PageClient from "../../../../email-templates/[templateId]/page-client";

export default function TemplateEditorPageClient(props: { templateId: string }) {
  return <PageClient templateId={props.templateId} />;
}
