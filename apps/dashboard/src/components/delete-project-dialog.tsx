'use client';

import { ActionDialog } from "@/components/ui";
import type { AdminProject } from "@hexclave/next";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";

/**
 * Shared confirmation dialog for permanently deleting a project. Used both by the project settings
 * danger zone and by the project list, so that both entry points warn about exactly the same data loss.
 *
 * Pass `trigger` to let the dialog manage its own open state, or `open`/`onOpenChange` to control it
 * from the outside (eg. when opening it from a dropdown menu item).
 */
export function DeleteProjectDialog(props: {
  project: AdminProject,
  onDeleted: () => Promise<void>,
  trigger?: React.ReactNode,
  open?: boolean,
  onOpenChange?: (open: boolean) => void,
}) {
  return (
    <ActionDialog
      trigger={props.trigger}
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Delete Project"
      danger
      okButton={{
        label: "Delete Project",
        onClick: async () => {
          await props.project.delete();
          // The project is irreversibly gone at this point, so post-deletion work (list refresh,
          // redirect) must not keep the dialog open or make the deletion look like it failed.
          runAsynchronouslyWithAlert(props.onDeleted());
        },
      }}
      cancelButton
      confirmText="I understand this action is IRREVERSIBLE and will delete ALL associated data."
    >
      <p className="text-sm text-foreground">
        {`Are you sure that you want to delete the project with name "${props.project.displayName}" and ID "${props.project.id}"?`}
      </p>
      <p className="mt-2 text-sm text-foreground">
        This action is <strong>irreversible</strong> and will permanently delete:
      </p>
      <ul className="mt-2 list-disc pl-5">
        <li>All users and their data</li>
        <li>All teams and team memberships</li>
        <li>All API keys</li>
        <li>All project configurations</li>
        <li>All OAuth provider settings</li>
      </ul>
    </ActionDialog>
  );
}
