"use client";

import { DesignAlert, DesignButton } from "@/components/design-components";
import { Link } from "@/components/link";
import {
  discardGrowthAdminActionPageDraft,
  getGrowthAdminActionPage,
  publishGrowthAdminActionPageDraft,
  saveGrowthAdminActionPageDraft,
} from "@/lib/growth/growth-api";
import { buildGrowthActionPagePrompt } from "@/lib/growth/growth-page-prompt";
import type { GrowthAdminActionPage } from "@/lib/growth/growth-types";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useStackApp, useUser } from "@hexclave/next";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageLayout } from "../../../../page-layout";
import { useProjectId } from "../../../../use-admin-app";
import { GrowthAdminDocumentEditor } from "../../document-editor";

type Loadable =
  | { status: "loading" }
  | { status: "error", message: string }
  | { status: "loaded", page: GrowthAdminActionPage };

export default function PageClient() {
  useUser({ or: "redirect", projectIdMustMatch: "internal" });
  if (useProjectId() !== "internal") throwErr("Growth Admin must be opened from the internal project.");
  const app = useStackApp();
  const params = useParams<{ actionId: string }>();
  const targetProjectId = useSearchParams().get("targetProjectId") ?? throwErr("Action admin page requires targetProjectId.");
  const [data, setData] = useState<Loadable>({ status: "loading" });

  const load = useCallback(async () => {
    try {
      setData({ status: "loaded", page: await getGrowthAdminActionPage(app, targetProjectId, params.actionId) });
    } catch (error) {
      captureError("growth-admin-action-page-load", error);
      setData({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [app, params.actionId, targetProjectId]);

  useEffect(() => runAsynchronously(load()), [load]);

  const backLink = (
    <DesignButton asChild variant="ghost" size="sm" className="-ml-3 text-muted-foreground">
      <Link href={urlString`/projects/internal/gtm/admin?targetProjectId=${targetProjectId}`}>
        <ArrowLeftIcon className="size-4" /> Back to Growth Admin
      </Link>
    </DesignButton>
  );

  return (
    <PageLayout
      allowContentOverflow
      width={1200}
      title={data.status === "loaded" ? `${data.page.action.title} · Growth Admin` : "Action page · Growth Admin"}
      description="Edit the customer-facing action page"
      backLink={backLink}
    >
      {data.status === "loading" ? <div className="h-64 animate-pulse rounded-2xl border bg-foreground/[0.03]" />
        : data.status === "error" ? (
          <DesignAlert variant="error"><div className="flex items-center justify-between gap-3"><span>{data.message}</span><DesignButton size="sm" variant="outline" onClick={async () => await load()}>Retry</DesignButton></div></DesignAlert>
        ) : (
          <GrowthAdminDocumentEditor
            contentKey={`${data.page.action.id}:${data.page.draft?.updatedAtMillis ?? "none"}:${data.page.publishedAtMillis ?? "generated"}`}
            noun="action page"
            prompt={buildGrowthActionPagePrompt(data.page.action)}
            promptButtonLabel="Copy action-page prompt"
            subtitle="Paste, preview, then publish the page customers read before acting"
            liveDocument={data.page.action.document ?? null}
            initialDraft={data.page.draft}
            publishedAtMillis={data.page.publishedAtMillis}
            saveDraft={async (input) => await saveGrowthAdminActionPageDraft(app, targetProjectId, params.actionId, input)}
            publishDraft={async (expected) => {
              await publishGrowthAdminActionPageDraft(app, targetProjectId, params.actionId, expected);
              await load();
            }}
            discardDraft={async () => {
              await discardGrowthAdminActionPageDraft(app, targetProjectId, params.actionId);
              await load();
            }}
          />
        )}
    </PageLayout>
  );
}
