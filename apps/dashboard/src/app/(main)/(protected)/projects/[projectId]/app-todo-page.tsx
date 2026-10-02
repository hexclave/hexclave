"use client";

import { DesignAlert } from "@/components/design-components";
import { PageLayout } from "./page-layout";

export function AppTodoPage(props: { title: string, description: string }) {
  return (
    <PageLayout title={props.title} description={props.description}>
      <DesignAlert
        variant="info"
        description="TODO: this surface is registered in the product architecture but is not implemented yet."
      />
    </PageLayout>
  );
}
