"use client";

import {
  DesignButton,
  DesignCard,
  DesignEmptyState,
  DesignListItemRow,
} from "@/components/design-components";
import { useRouter } from "@/components/router";
import { listExperimentRuns, type ExperimentRun } from "@/lib/feature-flags/admin-adapter";
import { formatBps } from "@/lib/feature-flags/config";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { FlaskIcon, PlusIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";
import {
  AdapterErrorAlert,
  AnalyticsRequiredGuard,
  BackendUnavailableAlert,
  ExperimentStatusBadge,
  useAdapterData,
  useFeatureFlagsSection,
} from "../shared";

export default function PageClient() {
  return (
    <PageLayout
      title="Experiments"
      description="Measure the impact of flag variants with A/B experiments"
      actions={<NewExperimentButton />}
    >
      <AnalyticsRequiredGuard>
        <ExperimentsList />
      </AnalyticsRequiredGuard>
    </PageLayout>
  );
}

function NewExperimentButton() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const router = useRouter();
  return (
    <DesignButton size="sm" onClick={() => router.push(urlString`/projects/${project.id}/feature-flags/experiments/new`)}>
      <PlusIcon className="h-4 w-4 mr-1" />
      New experiment
    </DesignButton>
  );
}

function ExperimentsList() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const router = useRouter();
  const section = useFeatureFlagsSection();

  const experimentIds = useMemo(() => [...section.experiments.keys()], [section]);
  const runsState = useAdapterData(async () => await listExperimentRuns(adminApp, experimentIds), [adminApp, experimentIds]);
  const runsById = useMemo(() => {
    const map = new Map<string, ExperimentRun>();
    if (runsState.status === "ok") {
      for (const run of runsState.data) map.set(run.experimentId, run);
    }
    return map;
  }, [runsState]);

  const experiments = useMemo(
    () => [...section.experiments.entries()].filter(([, experiment]) => !experiment.archived),
    [section],
  );

  if (experiments.length === 0) {
    return (
      <DesignCard>
        <DesignEmptyState
          icon={FlaskIcon}
          title="No experiments yet"
          description="Link an experiment to a feature flag to measure how its variants affect your metrics."
        >
          <NewExperimentButton />
        </DesignEmptyState>
      </DesignCard>
    );
  }

  return (
    <>
      {runsState.status === "unavailable" && <BackendUnavailableAlert what="Live experiment data" />}
      {runsState.status === "error" && <AdapterErrorAlert what="experiment runs" message={runsState.message} />}
      <DesignCard title="Experiments" icon={FlaskIcon} gradient="purple">
        <div className="flex flex-col gap-1">
          {experiments.map(([id, experiment]) => {
            const run = runsById.get(id);
            const flag = section.flags.get(experiment.flagKey);
            return (
              <div key={id} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <DesignListItemRow
                    size="sm"
                    icon={FlaskIcon}
                    title={experiment.displayName}
                    subtitle={`${flag?.displayName ?? experiment.flagKey} · ${formatBps(experiment.trafficBps)} of traffic · ${experiment.assignmentUnit}-level`}
                    onClick={() => router.push(urlString`/projects/${project.id}/feature-flags/experiments/${id}`)}
                  />
                </div>
                <div className="shrink-0">
                  {runsState.status === "ok" ? (
                    // No run record means the experiment was configured but
                    // its first immutable run has not been created yet.
                    <ExperimentStatusBadge status={run?.status ?? "not_started"} />
                  ) : (
                    <span className="text-xs text-muted-foreground" title="Live status unavailable">—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </DesignCard>
    </>
  );
}
