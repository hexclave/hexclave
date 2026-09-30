"use client";

import { DesignButton, DesignCard, DesignListItemRow } from "@/components/design-components";
import { Card, Input, Label, Typography, useToast } from "@/components/ui";
import type { DataSourceCatalogJson, DataSourceJson, DataSourceStreamConfig } from "@hexclave/shared/dist/interface/admin-interface";
import { DatabaseIcon, LockSimpleIcon, PlugsIcon } from "@phosphor-icons/react";
import { useRouter } from "@/components/router";
import { useState } from "react";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";
import { StreamPicker } from "./stream-picker";

export default function PageClient() {
  return (
    <AppEnabledGuard appId="data-warehouse-alpha">
      <SourcesPage />
    </AppEnabledGuard>
  );
}

type View =
  | { step: "list" }
  | { step: "catalog" }
  | { step: "credentials" }
  | { step: "tables", dataSource: DataSourceJson, catalog: DataSourceCatalogJson };

function SourcesPage() {
  const adminApp = useAdminApp();
  const dataSources = adminApp.useDataSources();
  const [view, setView] = useState<View>({ step: "list" });

  switch (view.step) {
    case "catalog": {
      return <SourceCatalog onBack={() => setView({ step: "list" })} onPick={() => setView({ step: "credentials" })} />;
    }
    case "credentials": {
      return (
        <ConnectPostgres
          onBack={() => setView({ step: "catalog" })}
          onConnected={(dataSource, catalog) => setView({ step: "tables", dataSource, catalog })}
        />
      );
    }
    case "tables": {
      return <ChooseTables dataSource={view.dataSource} catalog={view.catalog} />;
    }
    default: {
      return <SourceList dataSources={dataSources} onAdd={() => setView({ step: "catalog" })} />;
    }
  }
}

function SourceList({ dataSources, onAdd }: { dataSources: DataSourceJson[], onAdd: () => void }) {
  const router = useRouter();
  const adminApp = useAdminApp();

  if (dataSources.length === 0) {
    return (
      <PageLayout title="Sources" description="Sync data from your own systems into the warehouse.">
        <Card className="flex flex-col items-center px-6 py-14 text-center">
          <div className="mb-4 grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">
            <PlugsIcon className="h-5 w-5" />
          </div>
          <Typography type="h4">No sources yet</Typography>
          <Typography type="p" variant="secondary" className="mb-5 mt-1">
            Connect a database to start syncing.
          </Typography>
          <DesignButton onClick={onAdd}>Add source</DesignButton>
        </Card>
      </PageLayout>
    );
  }

  return (
    <PageLayout
      title="Sources"
      description={`${dataSources.length} connected`}
      actions={<DesignButton onClick={onAdd}>Add source</DesignButton>}
    >
      <Card className="divide-y divide-border-in-card">
        {dataSources.map(source => {
          const failing = source.streams.filter(stream => stream.status === "failed").length;
          return (
            <DesignListItemRow
              key={source.id}
              size="sm"
              icon={DatabaseIcon}
              title={source.host}
              subtitle={`PostgreSQL · ${source.streams.length} ${source.streams.length === 1 ? "table" : "tables"}${failing > 0 ? ` · ${failing} failing` : ""}`}
              onClick={() => router.push(`/projects/${encodeURIComponent(adminApp.projectId)}/data-warehouse/sources/${encodeURIComponent(source.id)}`)}
            />
          );
        })}
      </Card>
    </PageLayout>
  );
}

/**
 * PostgreSQL is the only source today. The screen still exists because it is
 * where every future source type appears, and because "pick what you are syncing
 * from" is a different decision from "type your credentials".
 */
function SourceCatalog({ onBack, onPick }: { onBack: () => void, onPick: () => void }) {
  return (
    <PageLayout title="Add source" description="Pick what you want to sync from.">
      <DesignButton variant="ghost" className="self-start" onClick={onBack}>← Sources</DesignButton>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <button
          type="button"
          onClick={onPick}
          className="flex flex-col items-start gap-2 rounded-xl border border-border-in-card p-4 text-left transition-colors hover:border-foreground/40"
        >
          <DatabaseIcon className="h-5 w-5" />
          <span className="font-medium">PostgreSQL</span>
          <span className="text-xs text-muted-foreground">Database</span>
        </button>
      </div>
    </PageLayout>
  );
}

function ConnectPostgres(props: {
  onBack: () => void,
  onConnected: (dataSource: DataSourceJson, catalog: DataSourceCatalogJson) => void,
}) {
  const adminApp = useAdminApp();
  const { toast } = useToast();
  const [form, setForm] = useState({ host: "", port: "5432", database: "", username: "", password: "", sslMode: "require" });
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    setConnecting(true);
    try {
      const result = await adminApp.createDataSource({
        host: form.host.trim(),
        port: Number.parseInt(form.port, 10),
        database: form.database.trim(),
        username: form.username.trim(),
        password: form.password,
        sslMode: form.sslMode,
      });
      props.onConnected(result.dataSource, result.catalog);
    } catch (error) {
      toast({ variant: "destructive", title: "Could not connect", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setConnecting(false);
    }
  };

  const field = (key: keyof typeof form, label: string, type: "text" | "password" = "text") => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`data-source-${key}`}>{label}</Label>
      <Input
        id={`data-source-${key}`}
        type={type}
        value={form[key]}
        onChange={event => setForm(prev => ({ ...prev, [key]: event.target.value }))}
      />
    </div>
  );

  const complete = form.host.trim() !== "" && form.database.trim() !== "" && form.username.trim() !== "";

  return (
    <PageLayout title="Connect PostgreSQL" description="A read-only role is enough.">
      <DesignButton variant="ghost" className="self-start" onClick={props.onBack}>← Add source</DesignButton>
      <DesignCard>
        <div className="grid gap-4 sm:grid-cols-2">
          {field("host", "Host")}
          {field("port", "Port")}
          {field("database", "Database")}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="data-source-ssl">SSL mode</Label>
            <select
              id="data-source-ssl"
              className="h-9 rounded-md border border-input-in-card bg-transparent px-2 text-sm"
              value={form.sslMode}
              onChange={event => setForm(prev => ({ ...prev, sslMode: event.target.value }))}
            >
              <option value="require">require</option>
              <option value="verify-full">verify-full</option>
              <option value="no-verify">no-verify</option>
              <option value="disable">disable</option>
            </select>
          </div>
          {field("username", "Username")}
          {field("password", "Password", "password")}
        </div>
        <div className="mt-5 flex gap-2.5 border-t border-border-in-card pt-4">
          <LockSimpleIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <Typography type="p" variant="secondary" className="text-xs">
            <span className="font-medium text-foreground">Your password is encrypted at rest.</span>{" "}
            It is sealed with a key from our KMS before it is written, decrypted only in memory for the
            seconds a sync runs, and never shown again once saved.
          </Typography>
        </div>
        <div className="mt-5 flex items-center gap-3">
          <DesignButton onClick={connect} loading={connecting} disabled={!complete}>Connect</DesignButton>
          <Typography type="label" variant="secondary">We will read your table list — nothing syncs yet.</Typography>
        </div>
      </DesignCard>
    </PageLayout>
  );
}

function ChooseTables({ dataSource, catalog }: { dataSource: DataSourceJson, catalog: DataSourceCatalogJson }) {
  const adminApp = useAdminApp();
  const router = useRouter();
  const { toast } = useToast();

  const save = async (streams: DataSourceStreamConfig[]) => {
    try {
      await adminApp.setDataSourceStreams(dataSource.id, streams);
      router.push(`/projects/${encodeURIComponent(adminApp.projectId)}/data-warehouse/sources/${encodeURIComponent(dataSource.id)}`);
    } catch (error) {
      toast({ variant: "destructive", title: "Could not save", description: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <PageLayout title="Choose tables" description="We picked a mode for each table. Change any of them.">
      <StreamPicker catalog={catalog} submitLabel="Start syncing" onSubmit={save} />
    </PageLayout>
  );
}
