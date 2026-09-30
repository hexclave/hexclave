"use client";

import { DesignAlert, DesignButton } from "@/components/design-components";
import { ActionDialog, Card, Typography, useToast } from "@/components/ui";
import type { DataSourceCatalogJson, DataSourceJson, DataSourceStreamConfig, DataSourceStreamJson } from "@hexclave/shared/dist/interface/admin-interface";
import { useRouter } from "@/components/router";
import { useParams } from "next/navigation";
import { useState } from "react";
import { AppEnabledGuard } from "../../../app-enabled-guard";
import { PageLayout } from "../../../page-layout";
import { useAdminApp } from "../../../use-admin-app";
import { StreamPicker, formatRowCount } from "../stream-picker";

const MODE_LABEL: Record<string, string> = { cdc: "CDC", cursor: "Cursor" };

export default function PageClient() {
  return (
    <AppEnabledGuard appId="data-warehouse-alpha">
      <DataSourcePage />
    </AppEnabledGuard>
  );
}

function DataSourcePage() {
  const adminApp = useAdminApp();
  const params = useParams<{ dataSourceId: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const dataSources = adminApp.useDataSources();
  const dataSource = dataSources.find(source => source.id === params.dataSourceId);

  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<DataSourceCatalogJson | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const sourcesHref = `/projects/${encodeURIComponent(adminApp.projectId)}/data-warehouse/sources`;

  if (dataSource == null) {
    return (
      <PageLayout title="Source not found">
        <DesignButton variant="secondary" onClick={() => router.push(sourcesHref)}>Back to sources</DesignButton>
      </PageLayout>
    );
  }

  const syncNow = async () => {
    setSyncing(true);
    try {
      await adminApp.syncDataSource(dataSource.id);
    } catch (error) {
      toast({ variant: "destructive", title: "Sync failed", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setSyncing(false);
    }
  };

  const startEditing = async () => {
    setLoadingCatalog(true);
    try {
      // Re-probed rather than cached: capabilities drift, and a customer who has
      // since enabled logical replication should see CDC offered here.
      setEditing(await adminApp.getDataSourceCatalog(dataSource.id));
    } catch (error) {
      toast({ variant: "destructive", title: "Could not read the source", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoadingCatalog(false);
    }
  };

  const saveStreams = async (streams: DataSourceStreamConfig[]) => {
    try {
      await adminApp.setDataSourceStreams(dataSource.id, streams);
      setEditing(null);
    } catch (error) {
      toast({ variant: "destructive", title: "Could not save", description: error instanceof Error ? error.message : String(error) });
    }
  };

  if (editing != null) {
    return (
      <PageLayout title="Edit tables" description={dataSource.host}>
        <StreamPicker
          catalog={editing}
          existingStreams={dataSource.streams.map(stream => ({
            schema_name: stream.schema_name,
            table_name: stream.table_name,
            mode: stream.mode,
            cursor_column: stream.cursor_column,
          }))}
          submitLabel="Save"
          onCancel={() => setEditing(null)}
          onSubmit={saveStreams}
        />
      </PageLayout>
    );
  }

  // A stream waiting on a rebuild stays pending when its sync fails, so the
  // error, not the status, is what says it is failing.
  const failing = dataSource.streams.filter(stream => stream.status === "failed" || stream.error != null).length;

  return (
    <PageLayout
      title={dataSource.host}
      description={`PostgreSQL · ${dataSource.streams.length} ${dataSource.streams.length === 1 ? "table" : "tables"}${failing > 0 ? ` · ${failing} failing` : ""}`}
      actions={
        <div className="flex gap-2">
          <DesignButton variant="secondary" onClick={startEditing} loading={loadingCatalog}>Edit tables</DesignButton>
          <DesignButton variant="secondary" onClick={syncNow} loading={syncing}>Sync now</DesignButton>
          <DesignButton variant="ghost" onClick={() => setConfirmingDelete(true)}>Disconnect</DesignButton>
        </div>
      }
    >
      <DesignButton variant="ghost" className="self-start" onClick={() => router.push(sourcesHref)}>← Sources</DesignButton>

      {dataSource.error != null && (
        <Card className="border-destructive/40 bg-destructive/5 p-4">
          <Typography type="p" className="text-destructive">{dataSource.error}</Typography>
        </Card>
      )}

      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 pb-2 pt-4 text-left font-medium">Table</th>
              <th className="px-4 pb-2 pt-4 text-left font-medium">Mode</th>
              <th className="px-4 pb-2 pt-4 text-left font-medium">Status</th>
              <th className="px-4 pb-2 pt-4 text-left font-medium">Rows synced</th>
              <th className="px-4 pb-2 pt-4 text-left font-medium">Last sync</th>
            </tr>
          </thead>
          <tbody>
            {dataSource.streams.map(stream => (
              <tr key={stream.id} className="border-t border-border-in-card">
                <td className="px-4 py-2.5 font-medium">
                  <span className="font-normal text-muted-foreground">{stream.schema_name}.</span>{stream.table_name}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {MODE_LABEL[stream.mode] ?? stream.mode}
                  {stream.mode === "cursor" && stream.cursor_column != null ? ` · ${stream.cursor_column}` : ""}
                </td>
                <td className="px-4 py-2.5"><StreamStatus stream={stream} /></td>
                <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{formatRowCount(stream.rows_synced)}</td>
                <td className="px-4 py-2.5 text-muted-foreground">{formatRelativeTime(stream.last_synced_at_millis)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <ActionDialog
        open={confirmingDelete}
        onOpenChange={(open) => {
          setConfirmingDelete(open);
          if (!open) setDisconnectError(null);
        }}
        title="Disconnect this source?"
        danger
        okButton={{
          label: "Disconnect",
          onClick: async () => {
            setDisconnectError(null);
            try {
              await adminApp.deleteDataSource(dataSource.id);
              router.push(sourcesHref);
            } catch (error) {
              setDisconnectError(error instanceof Error ? error.message : "The source could not be disconnected. Please try again.");
              return "prevent-close";
            }
          },
        }}
        cancelButton
      >
        {disconnectError != null && (
          <DesignAlert variant="error" title="Could not disconnect" description={disconnectError} />
        )}
        <Typography type="p" variant="secondary">
          We stop syncing and drop the replication slot on your database. Tables already synced into
          your warehouse are left where they are — delete them yourself if you no longer want them.
        </Typography>
      </ActionDialog>
    </PageLayout>
  );
}

function StreamStatus({ stream }: { stream: DataSourceStreamJson }) {
  const colors: Record<string, string> = {
    active: "bg-green-500",
    snapshotting: "bg-blue-500",
    pending: "bg-muted-foreground",
    failed: "bg-destructive",
  };
  const labels: Record<string, string> = {
    active: stream.mode === "cdc" ? "Live" : "Synced",
    snapshotting: "Snapshotting",
    pending: "Waiting for first sync",
    failed: "Failing",
  };
  return (
    <span className="flex items-center gap-2">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${colors[stream.status]}`} />
      <span>{labels[stream.status]}</span>
      {stream.error != null && <span className="text-xs text-muted-foreground">{stream.error}</span>}
    </span>
  );
}

function formatRelativeTime(millis: number | null): string {
  if (millis == null) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - millis) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}
