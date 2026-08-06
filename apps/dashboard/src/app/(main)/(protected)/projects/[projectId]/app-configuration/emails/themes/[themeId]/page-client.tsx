"use client";

import PageClient from "../../../../email-themes/[themeId]/page-client";

export default function ThemeEditorPageClient(props: { themeId: string }) {
  return <PageClient themeId={props.themeId} />;
}
