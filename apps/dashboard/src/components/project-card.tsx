'use client';
import { DesignBadge } from "@/components/design-components/badge";
import { DesignCard } from "@/components/design-components/card";
import { DesignMenu } from "@/components/design-components/menu";
import { DeleteProjectDialog } from "@/components/delete-project-dialog";
import { Link } from "@/components/link";
import { ProjectUsersMetric } from "@/components/project-users-metric";
import { useFromNow } from '@/hooks/use-from-now';
import { cn } from "@/lib/utils";
import { FolderOpenIcon, TrashIcon } from "@phosphor-icons/react";
import { AdminProject } from '@hexclave/next';
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { useState } from "react";

export function ProjectCard(props: {
  project: AdminProject,
  href?: string,
  showIncompleteBadge?: boolean,
  totalUsers?: number,
  dailySignups?: { date: string, activity: number }[],
  metricsLoading?: boolean,
  metricsError?: boolean,
  /**
   * When given, the card shows an actions menu that can delete the project. Called after the project
   * was deleted, so the caller can refresh whatever list the card is rendered in.
   */
  onDeleted?: () => Promise<void>,
}) {
  const createdAt = useFromNow(props.project.createdAt);
  const href = props.href ?? urlString`/projects/${props.project.id}`;
  const onDeleted = props.onDeleted;
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  return (
    <div className="relative h-full">
      <Link href={href}>
        <DesignCard
          className="h-full"
          contentClassName="p-3"
          gradient={props.showIncompleteBadge ? "orange" : "default"}
          glassmorphic
        >
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] ring-1 ring-black/[0.04] dark:ring-white/[0.04]">
              <FolderOpenIcon className="h-4 w-4 text-foreground/70" weight="duotone" />
            </div>
            <div className="min-w-0 flex-1">
              <div className={cn("flex items-baseline justify-between gap-2", onDeleted != null && "pr-7")}>
                <h3 className="truncate text-sm font-semibold leading-tight tracking-tight text-foreground">
                  {props.project.displayName}
                </h3>
                {props.showIncompleteBadge ? (
                  <DesignBadge label="Setup incomplete" color="orange" size="sm" />
                ) : (
                  <span className="shrink-0 text-[10px] text-muted-foreground/80 whitespace-nowrap">
                    {createdAt}
                  </span>
                )}
              </div>
              <p className="truncate text-xs leading-snug text-muted-foreground">
                {props.project.description || "No description yet"}
              </p>
            </div>
          </div>

          <div className="-mx-3 -mb-3 mt-3 overflow-hidden rounded-b-2xl border-t border-black/[0.08] dark:border-white/[0.06] px-3 pt-3 pb-3">
            <ProjectUsersMetric
              totalUsers={props.totalUsers}
              data={props.dailySignups}
              loading={props.metricsLoading}
              error={props.metricsError}
            />
          </div>
        </DesignCard>
      </Link>

      {onDeleted != null && (
        <>
          {/* Rendered as a sibling of the Link (instead of inside the card) so that the menu is not nested inside the anchor. */}
          <div className="absolute right-1.5 top-1.5 z-10">
            <DesignMenu
              variant="actions"
              trigger="icon"
              triggerLabel="Project actions"
              align="end"
              withIcons
              items={[{
                id: "delete",
                label: "Delete Project",
                itemVariant: "destructive",
                icon: <TrashIcon className="h-4 w-4" />,
                onClick: () => setIsDeleteDialogOpen(true),
              }]}
            />
          </div>
          <DeleteProjectDialog
            project={props.project}
            open={isDeleteDialogOpen}
            onOpenChange={setIsDeleteDialogOpen}
            onDeleted={onDeleted}
          />
        </>
      )}
    </div>
  );
}
