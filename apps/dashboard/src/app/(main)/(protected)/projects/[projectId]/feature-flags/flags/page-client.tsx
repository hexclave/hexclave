"use client";

import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignCategoryTabs,
  DesignEmptyState,
  DesignMenu,
} from "@/components/design-components";
import { useRouter } from "@/components/router";
import {
  describeCurrentRollout,
  getFlagStatus,
  getLinkedExperiments,
  type FlagStatus,
  type FlagValueType,
} from "@/lib/feature-flags/config";
import { getLastExposures } from "@/lib/feature-flags/admin-adapter";
import { getAppStageLabel } from "@/lib/apps-utils";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { ArchiveIcon, ArrowCounterClockwiseIcon, FlagIcon, FlaskIcon, PencilSimpleIcon, PlusIcon, ProhibitIcon } from "@phosphor-icons/react";
import {
  createDefaultDataGridState,
  DataGrid,
  useDataSource,
  type DataGridColumnDef,
} from "@hexclave/dashboard-ui-components";
import { useMemo, useState } from "react";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";
import { EvaluatorTesterDialog } from "../evaluator-tester-dialog";
import { FlagLifecycleConfirmDialog, type PendingFlagLifecycleAction } from "../flag-lifecycle";
import { SegmentsManager } from "../segments-manager";
import {
  FLAG_STATUS_BADGE,
  FlagStatusBadge,
  formatRelativeTime,
  useAdapterData,
  useFeatureFlagsSection,
} from "../shared";

type FlagRow = {
  internalId: string,
  key: string,
  displayName: string,
  status: FlagStatus,
  type: FlagValueType,
  rollout: string,
  experimentNames: string,
  lastExposureIso: string | null,
};

type StatusCategory = "all" | FlagStatus;

const stageLabel = getAppStageLabel("feature-flags");

export default function PageClient() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const router = useRouter();
  const section = useFeatureFlagsSection();

  const [category, setCategory] = useState<StatusCategory>("all");
  const [testerFlagKey, setTesterFlagKey] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingFlagLifecycleAction | null>(null);

  const lastExposures = useAdapterData(async () => await getLastExposures(adminApp), [adminApp]);

  const allRows = useMemo<FlagRow[]>(() => {
    return [...section.flags.entries()].map(([key, flag]) => ({
      internalId: flag.internalId,
      key,
      displayName: flag.displayName,
      status: getFlagStatus(flag),
      type: flag.type,
      rollout: describeCurrentRollout(flag),
      experimentNames: getLinkedExperiments(section, key).map(({ experiment }) => experiment.displayName).join(", "),
      lastExposureIso: lastExposures.status === "ok" ? lastExposures.data.get(flag.internalId) ?? null : null,
    }));
  }, [section, lastExposures]);

  const counts = useMemo(() => {
    const byStatus = new Map<FlagStatus, number>([["enabled", 0], ["disabled", 0], ["killed", 0], ["archived", 0]]);
    for (const row of allRows) {
      byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    }
    return byStatus;
  }, [allRows]);

  const filteredRows = useMemo(() => {
    // "All" hides archived flags — they have their own tab so day-to-day work
    // isn't cluttered by retired flags.
    if (category === "all") return allRows.filter((row) => row.status !== "archived");
    return allRows.filter((row) => row.status === category);
  }, [allRows, category]);

  const lastExposureUnavailable = lastExposures.status === "unavailable";

  const columns = useMemo<DataGridColumnDef<FlagRow>[]>(() => [
    {
      id: "displayName",
      header: "Flag",
      accessor: "displayName",
      width: 240,
      type: "string",
      renderCell: ({ row }) => (
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium truncate">{row.displayName}</span>
          <span className="text-xs text-muted-foreground font-mono truncate">{row.key}</span>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      accessor: "status",
      width: 110,
      type: "singleSelect",
      valueOptions: [...FLAG_STATUS_BADGE.entries()].map(([value, badge]) => ({ value, label: badge.label })),
      renderCell: ({ row }) => <FlagStatusBadge status={row.status} />,
    },
    {
      id: "type",
      header: "Type",
      accessor: "type",
      width: 90,
      type: "string",
      renderCell: ({ row }) => <span className="text-xs font-mono text-muted-foreground">{row.type}</span>,
    },
    {
      id: "rollout",
      header: "Current rollout",
      accessor: "rollout",
      width: 230,
      type: "string",
      renderCell: ({ row }) => <span className="text-xs text-muted-foreground">{row.rollout}</span>,
    },
    {
      id: "experiments",
      header: "Experiment",
      accessor: "experimentNames",
      width: 160,
      type: "string",
      renderCell: ({ row }) => row.experimentNames.length > 0
        ? <DesignBadge label={row.experimentNames} color="purple" size="sm" icon={FlaskIcon} />
        : <span className="text-xs text-muted-foreground">—</span>,
    },
    {
      id: "lastExposure",
      header: "Last exposure",
      accessor: (row) => row.lastExposureIso ?? "",
      width: 130,
      type: "string",
      renderCell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.lastExposureIso != null ? formatRelativeTime(row.lastExposureIso) : "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      width: 60,
      accessor: () => "",
      renderCell: ({ row }) => (
        <DesignMenu
          variant="actions"
          trigger="icon"
          triggerLabel={`Actions for ${row.displayName}`}
          align="end"
          withIcons
          items={[
            {
              id: "edit",
              label: "Edit",
              icon: <PencilSimpleIcon />,
              onClick: () => router.push(urlString`/projects/${project.id}/feature-flags/flags/${row.key}`),
            },
            {
              id: "test",
              label: "Test evaluation…",
              icon: <FlaskIcon />,
              onClick: () => setTesterFlagKey(row.key),
            },
            ...row.status === "killed" ? [{
              id: "restore",
              label: "Restore",
              icon: <ArrowCounterClockwiseIcon />,
              onClick: () => setPendingAction({ flagId: row.internalId, displayName: row.displayName, action: "restore" }),
            }] : [],
            ...row.status !== "killed" && row.status !== "archived" ? [{
              id: "kill",
              label: "Kill switch",
              icon: <ProhibitIcon />,
              itemVariant: "destructive" as const,
              onClick: () => setPendingAction({ flagId: row.internalId, displayName: row.displayName, action: "kill" }),
            }] : [],
            row.status === "archived" ? {
              id: "unarchive",
              label: "Unarchive",
              icon: <ArrowCounterClockwiseIcon />,
              onClick: () => setPendingAction({ flagId: row.internalId, displayName: row.displayName, action: "unarchive" }),
            } : {
              id: "archive",
              label: "Archive",
              icon: <ArchiveIcon />,
              onClick: () => setPendingAction({ flagId: row.internalId, displayName: row.displayName, action: "archive" }),
            },
          ]}
        />
      ),
    },
  ], [project.id, router]);

  const [gridState, setGridState] = useState(() => createDefaultDataGridState(columns));
  const gridData = useDataSource({
    data: filteredRows,
    columns,
    getRowId: (row) => row.key,
    sorting: gridState.sorting,
    quickSearch: gridState.quickSearch,
    pagination: gridState.pagination,
    paginationMode: "client",
  });

  return (
    <PageLayout
      title="Feature Flags"
      description={
        <span className="flex items-center gap-2">
          Ship features safely with typed flags, targeting rules, and gradual rollouts
          {stageLabel != null && <DesignBadge label={stageLabel} color="purple" size="sm" />}
        </span>
      }
      actions={
        <DesignButton size="sm" onClick={() => router.push(urlString`/projects/${project.id}/feature-flags/flags/new`)}>
          <PlusIcon className="h-4 w-4 mr-1" />
          New flag
        </DesignButton>
      }
    >
      <SegmentsManager section={section} />
      {section.flags.size === 0 ? (
        <DesignCard>
          <DesignEmptyState
            icon={FlagIcon}
            title="No feature flags yet"
            description="Create your first flag to start rolling out features gradually and safely."
          >
            <DesignButton size="sm" onClick={() => router.push(urlString`/projects/${project.id}/feature-flags/flags/new`)}>
              <PlusIcon className="h-4 w-4 mr-1" />
              Create flag
            </DesignButton>
          </DesignEmptyState>
        </DesignCard>
      ) : (
        <>
          <DesignCategoryTabs
            categories={[
              { id: "all", label: "All", count: allRows.filter((row) => row.status !== "archived").length },
              { id: "enabled", label: "Enabled", count: counts.get("enabled") ?? 0 },
              { id: "disabled", label: "Disabled", count: counts.get("disabled") ?? 0 },
              { id: "killed", label: "Killed", count: counts.get("killed") ?? 0 },
              { id: "archived", label: "Archived", count: counts.get("archived") ?? 0 },
            ]}
            selectedCategory={category}
            onSelect={(id) => setCategory(isStatusCategory(id) ? id : "all")}
            gradient="blue"
            size="sm"
          />
          {lastExposureUnavailable && (
            <DesignAlert
              variant="info"
              title="Exposure data not available yet"
              description="This server does not expose feature-flag exposure data yet, so the last-exposure column stays empty. Flag configuration is unaffected."
            />
          )}
          {lastExposures.status === "error" && (
            <DesignAlert
              variant="error"
              title="Failed to load exposure data"
              description={lastExposures.message}
            />
          )}
          <DataGrid
            columns={columns}
            rows={gridData.rows}
            getRowId={(row) => row.key}
            totalRowCount={gridData.totalRowCount}
            isLoading={gridData.isLoading}
            state={gridState}
            onChange={setGridState}
            onRowClick={(row) => router.push(urlString`/projects/${project.id}/feature-flags/flags/${row.key}`)}
            maxHeight={560}
          />
        </>
      )}

      {testerFlagKey != null && (
        <EvaluatorTesterDialog
          flagKey={testerFlagKey}
          open
          onOpenChange={(open) => {
            if (!open) setTesterFlagKey(null);
          }}
        />
      )}

      <FlagLifecycleConfirmDialog pending={pendingAction} onClose={() => setPendingAction(null)} />
    </PageLayout>
  );
}

function isStatusCategory(id: string): id is StatusCategory {
  return id === "all" || id === "enabled" || id === "disabled" || id === "killed" || id === "archived";
}
