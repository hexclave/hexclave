"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
} from "@/components/design-components";
import { useRouter } from "@/components/router";
import { useUpdateConfig } from "@/components/config-update";
import { featureFlagConfigUpdates, getFlagStatus, getLinkedExperiments } from "@/lib/feature-flags/config";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { ArchiveIcon, ArrowCounterClockwiseIcon, FlaskIcon, ProhibitIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { PageLayout } from "../../../page-layout";
import { useAdminApp } from "../../../use-admin-app";
import { EvaluatorTesterDialog } from "../../evaluator-tester-dialog";
import { FlagEditor } from "../../flag-editor";
import { FlagLifecycleConfirmDialog, type PendingFlagLifecycleAction } from "../../flag-lifecycle";
import { FlagStatusBadge, useFeatureFlagsSection } from "../../shared";

type PageClientProps = {
  flagKey: string,
};

export default function PageClient({ flagKey }: PageClientProps) {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const router = useRouter();
  const updateConfig = useUpdateConfig();
  const section = useFeatureFlagsSection();

  const [testerOpen, setTesterOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingFlagLifecycleAction | null>(null);

  const flag = section.flags.get(flagKey);

  if (flag == null) {
    return (
      <PageLayout title="Flag not found">
        <DesignAlert
          variant="error"
          title="This flag does not exist"
          description={`No flag with the key "${flagKey}" is configured in this project. It may have been renamed or removed.`}
        />
        <div>
          <DesignButton
            variant="secondary"
            size="sm"
            onClick={() => router.push(urlString`/projects/${project.id}/feature-flags/flags`)}
          >
            Back to flags
          </DesignButton>
        </div>
      </PageLayout>
    );
  }

  const status = getFlagStatus(flag);
  const linkedExperiments = getLinkedExperiments(section, flagKey);

  return (
    <PageLayout
      title={flag.displayName}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <FlagStatusBadge status={status} />
          <span className="font-mono text-xs">{flagKey}</span>
          {linkedExperiments.map(({ id, experiment }) => (
            <button
              key={id}
              type="button"
              className="inline-flex focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/[0.2] rounded-md"
              aria-label={`Open experiment ${experiment.displayName}`}
              onClick={() => router.push(urlString`/projects/${project.id}/feature-flags/experiments/${id}`)}
            >
              <DesignBadge label={experiment.displayName} color="purple" size="sm" icon={FlaskIcon} />
            </button>
          ))}
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          <DesignButton variant="outline" size="sm" onClick={() => setTesterOpen(true)}>
            <FlaskIcon className="h-4 w-4 mr-1" />
            Test
          </DesignButton>
          {status === "killed" ? (
            <DesignButton
              variant="outline"
              size="sm"
              onClick={() => setPendingAction({ flagId: flag.internalId, displayName: flag.displayName, action: "restore" })}
            >
              <ArrowCounterClockwiseIcon className="h-4 w-4 mr-1" />
              Restore
            </DesignButton>
          ) : status !== "archived" ? (
            <DesignButton
              variant="destructive"
              size="sm"
              onClick={() => setPendingAction({ flagId: flag.internalId, displayName: flag.displayName, action: "kill" })}
            >
              <ProhibitIcon className="h-4 w-4 mr-1" />
              Kill switch
            </DesignButton>
          ) : null}
          {status === "archived" ? (
            <DesignButton
              variant="outline"
              size="sm"
              onClick={() => setPendingAction({ flagId: flag.internalId, displayName: flag.displayName, action: "unarchive" })}
            >
              <ArrowCounterClockwiseIcon className="h-4 w-4 mr-1" />
              Unarchive
            </DesignButton>
          ) : (
            <DesignButton
              variant="outline"
              size="sm"
              onClick={() => setPendingAction({ flagId: flag.internalId, displayName: flag.displayName, action: "archive" })}
            >
              <ArchiveIcon className="h-4 w-4 mr-1" />
              Archive
            </DesignButton>
          )}
        </div>
      }
    >
      {status === "killed" && (
        <DesignAlert
          variant="error"
          title="Kill switch is active"
          description="All evaluations serve the fallback variant. Restore the flag to resume normal targeting."
        />
      )}
      {status === "archived" && (
        <DesignAlert
          variant="warning"
          title="This flag is archived"
          description="It no longer evaluates and is hidden from the default list. Unarchive it to make changes take effect."
        />
      )}
      <FlagEditor
        // Remount whenever the underlying config changes (publish, another
        // tab, config push). The editor's draft would otherwise silently go
        // stale relative to the saved flag it diffs against.
        key={JSON.stringify(flag)}
        fixedFlagKey={flagKey}
        initialFlag={flag}
        section={section}
        onPublish={async (publishedKey, publishedFlag) => {
          await updateConfig({
            adminApp,
            configUpdate: featureFlagConfigUpdates(flag.internalId, publishedKey, publishedFlag, section),
            pushable: true,
          });
          if (publishedKey !== flagKey) {
            router.push(urlString`/projects/${project.id}/feature-flags/flags/${publishedKey}`);
          }
        }}
      />

      {testerOpen && (
        <EvaluatorTesterDialog
          flagKey={flagKey}
          open
          onOpenChange={(open) => {
            if (!open) setTesterOpen(false);
          }}
        />
      )}
      <FlagLifecycleConfirmDialog pending={pendingAction} onClose={() => setPendingAction(null)} />
    </PageLayout>
  );
}
