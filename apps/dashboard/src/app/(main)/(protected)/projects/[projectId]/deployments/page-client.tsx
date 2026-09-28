"use client";

import { DesignBadge, DesignButton } from "@/components/design-components";
import { getAppStageLabel } from "@/lib/apps-utils";
import { cn } from "@/components/ui";
import type { AdminDeploymentJson } from "@hexclave/next";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useRouter } from "@/components/router";
import { usePathname, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";
import { BoardCanvas } from "./board-canvas";
import { DeploymentsList } from "./deployments-list";

const stageLabel = getAppStageLabel("deploy");

function formatDeploymentTime(millis: number): string {
  return new Date(millis).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  // Null = the deployment list. Opening a deployment swaps the whole page for its service
  // map rather than nesting the map in a tab, so the map keeps the full height it needs
  // (its contents are absolutely positioned).
  //
  // The ID and the object are held separately on purpose. Keeping only the object froze it:
  // the list owns the poll, and unmounting the list left the detail rendering a snapshot that
  // never updated — an in-flight deploy sat at "Building" until the user went back and
  // reopened it. The list now stays mounted (hidden) and reports the fresh copy back.
  const [openDeploymentId, setOpenDeploymentId] = useState<string | null>(null);
  const [openDeployment, setOpenDeployment] = useState<AdminDeploymentJson | null>(null);
  // Held here rather than only inside the list, because the open deployment's map is scoped
  // to a moment in time across EVERY source and needs their deployments to resolve it.
  const [deployments, setDeployments] = useState<AdminDeploymentJson[]>([]);
  const isOpen = openDeploymentId !== null && openDeployment !== null;

  // `hexclave deploy` prints a link to the deployment it just ran, so the CLI's
  // last line is one click from the build log. The deployment has to be OPENED
  // from the list rather than fetched here, because the list owns the poll that
  // keeps it fresh — so this waits for the first load and opens the match.
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // Captured on the FIRST render, before the params are stripped below. The
  // components that consume `serviceId` and `panel` mount only once a deployment
  // is open, so reading the URL from inside them would race the strip — they take
  // these as props instead.
  const [linked] = useState(() => ({
    deploymentId: searchParams.get("deploymentId"),
    serviceId: searchParams.get("serviceId"),
    panel: searchParams.get("panel"),
  }));
  const linkedDeploymentId = linked.deploymentId;
  // CONSUMED, not just applied-once. A ref guard alone was not enough: it lives
  // on a mount, and the components below it are conditionally rendered — so
  // clicking "All deployments" unmounted the board, reset its guard, and left
  // `serviceId` in the URL to be re-applied to the next deployment the user
  // opened. Stripping the params after the first read is what actually makes
  // the link a one-time instruction, and it is what keeps a browser reload from
  // yanking the user back into it too.
  const appliedLink = useRef(false);
  const consumeLinkParams = () => {
    if (linked.deploymentId === null && linked.serviceId === null) return;
    const remaining = new URLSearchParams(searchParams.toString());
    for (const key of ["deploymentId", "serviceId", "panel"]) remaining.delete(key);
    const query = remaining.toString();
    // `replace`, so Back goes where the user came from rather than back into
    // the link they just consumed.
    router.replace(query === "" ? pathname : `${pathname}?${query}`);
  };
  const handleDeploymentsLoaded = (loaded: AdminDeploymentJson[]) => {
    setDeployments(loaded);
    if (appliedLink.current || linkedDeploymentId === null) return;
    appliedLink.current = true;
    // A link to a deployment this project no longer has — or one older than the
    // page the list loads — lands on the list, which is the honest thing to show
    // and needs no error of its own.
    const match = loaded.find((deployment) => deployment.id === linkedDeploymentId);
    if (match !== undefined) {
      setOpenDeploymentId(match.id);
      setOpenDeployment(match);
    }
    // Cleared either way: a link that found nothing has still been acted on, and
    // leaving it in the URL would re-fire it on the next deployment opened.
    consumeLinkParams();
  };

  return (
    <AppEnabledGuard appId="deploy">
      <PageLayout
        fillWidth
        title="Deploy"
        // No prose subheader — the list says what it is. The stage badge stays
        // because it is the only thing marking the app as alpha.
        description={stageLabel == null ? undefined : <DesignBadge label={stageLabel} color="purple" size="sm" />}
      >
        {isOpen && (
          <div className="mb-3 flex shrink-0 items-center gap-3">
            <DesignButton variant="ghost" size="sm" onClick={() => setOpenDeploymentId(null)}>
              <ArrowLeftIcon className="mr-1.5 h-4 w-4" />
              All deployments
            </DesignButton>
            {/* Deployments have no user-facing number in the list, so the timestamp is what
                tells the reader which one they opened. */}
            <span className="truncate text-sm text-muted-foreground">
              Deployment #{openDeployment.number} · {formatDeploymentTime(openDeployment.created_at_millis)}
            </span>
          </div>
        )}

        {/* The list stays MOUNTED while a deployment is open, hidden rather than unmounted,
            because it owns the poll that keeps every deployment — including the open one — up
            to date. It reports the open deployment's current value back through
            onOpenDeploymentChange on each poll, which is what makes a running build's statuses
            advance in the map instead of freezing. */}
        <div className={cn("min-h-0 flex-1 overflow-y-auto", isOpen && "hidden")}>
          <DeploymentsList
            project={project}
            openDeploymentId={openDeploymentId}
            onOpenDeployment={(deployment) => {
              setOpenDeploymentId(deployment.id);
              setOpenDeployment(deployment);
            }}
            onOpenDeploymentChange={setOpenDeployment}
            onDeploymentsLoaded={handleDeploymentsLoaded}
          />
        </div>

        {/* NOT wrapped in a div: BoardCanvas's root carries `flex min-h-0 flex-1` and its
            contents are absolutely positioned, so it has to be a direct child of PageLayout's
            flex column — inside a plain block wrapper the `flex-1` resolves against nothing
            and the board collapses to zero height. */}
        {isOpen && (
          <BoardCanvas
            deployment={openDeployment}
            deployments={deployments}
            linkedServiceId={linked.serviceId}
            linkedPanel={linked.panel}
          />
        )}
      </PageLayout>
    </AppEnabledGuard>
  );
}
