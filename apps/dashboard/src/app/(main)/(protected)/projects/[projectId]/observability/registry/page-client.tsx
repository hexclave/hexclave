"use client";

import { DesignAlert, DesignBadge, DesignButton, DesignCard, DesignCategoryTabs, DesignListItemRow } from "@/components/design-components";
import { sendInternalAdminRequest } from "@/lib/hexclave-app-internals";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import type { Json } from "@hexclave/shared/dist/utils/json";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { ArchiveBoxIcon, BugIcon, GitCommitIcon, PackageIcon, RocketLaunchIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as yup from "yup";
import { AppEnabledGuard } from "../../app-enabled-guard";
import { useAdminApp } from "../../use-admin-app";
import { getErrorMessage } from "../format";
import { ObservabilityPageLayout } from "../observability-page-layout";
import {
  ObservabilityEmptyState,
  ObservabilityErrorState,
  ObservabilityLoadingState,
  ObservabilityPaneBody,
  ObservabilityPaneHeader,
  ObservabilityRefreshButton,
  ObservabilitySplitLayout,
  ObservabilityToolbar,
} from "../page-chrome";

const ReleaseSummarySchema = yup.object({
  id: yup.string().defined(), version: yup.string().defined(), status: yup.string().oneOf(["open", "archived"]).defined(),
  ref: yup.string().nullable().defined(), url: yup.string().nullable().defined(), date_added: yup.string().defined(),
  date_started: yup.string().nullable().defined(), date_released: yup.string().nullable().defined(),
  created_at: yup.string().defined(), updated_at: yup.string().defined(),
}).defined();
const CommitSchema = yup.object({
  id: yup.string().defined(), repository: yup.string().defined(), commit_sha: yup.string().defined(),
  position: yup.number().integer().defined(), message: yup.string().nullable().defined(),
}).defined();
const DeploymentSchema = yup.object({
  id: yup.string().defined(), deployment_key: yup.string().defined(), environment: yup.string().defined(),
  name: yup.string().nullable().defined(), finished_at: yup.string().defined(),
}).defined();
const DebugIdSchema = yup.object({
  id: yup.string().defined(), debug_id: yup.string().defined(), code_file: yup.string().defined(),
  source_map_file: yup.string().nullable().defined(), source_map_inline: yup.boolean().defined(),
  bundle_bytes: yup.number().integer().defined(), source_map_bytes: yup.number().integer().defined(),
  source_map_gzipped_bytes: yup.number().integer().defined(),
}).defined();
const ArtifactSchema = yup.object({
  id: yup.string().defined(), manifest_sha256: yup.string().defined(), dist: yup.string().nullable().defined(),
  environment: yup.string().nullable().defined(), finalized_at: yup.string().nullable().defined(),
  debug_ids: yup.array(DebugIdSchema).defined(),
}).defined();
const ArtifactPageSchema = yup.object({ items: yup.array(ArtifactSchema).defined(), next_cursor: yup.string().nullable().defined() }).defined();
const RegistryEntrySchema = ReleaseSummarySchema.concat(yup.object({
  commits: yup.array(CommitSchema).defined(), deployments: yup.array(DeploymentSchema).defined(), artifacts: ArtifactPageSchema.defined(),
}).defined());
const RegistryPageSchema = yup.object({ items: yup.array(ReleaseSummarySchema).defined(), next_cursor: yup.string().nullable().defined() }).defined();

export type RegistryEntry = yup.InferType<typeof RegistryEntrySchema>;
type ReleaseSummary = yup.InferType<typeof ReleaseSummarySchema>;
type RegistryFilter = "all" | "open" | "archived" | "source-maps";
type RegistryDetailView = "overview" | "source-maps" | "commits" | "deployments";

async function readJsonOrThrow(response: Response, operation: string): Promise<Json> {
  if (!response.ok) throw new HexclaveAssertionError(`${operation} failed with status ${response.status}`);
  return await response.json();
}

async function fetchRegistryPage(adminApp: object, cursor: string | null) {
  const params = new URLSearchParams({ limit: "50" });
  if (cursor !== null) params.set("cursor", cursor);
  const response = await sendInternalAdminRequest(adminApp, `/releases/recent?${params.toString()}`, { method: "GET" });
  return await RegistryPageSchema.validate(await readJsonOrThrow(response, "Loading registry"));
}

async function fetchRegistryEntry(adminApp: object, version: string): Promise<RegistryEntry> {
  const params = new URLSearchParams({ version });
  const response = await sendInternalAdminRequest(adminApp, `/releases?${params.toString()}`, { method: "GET" });
  return await RegistryEntrySchema.validate(await readJsonOrThrow(response, "Loading registry entry"));
}

async function fetchArtifactPage(adminApp: object, releaseId: string, cursor: string) {
  const params = new URLSearchParams({ release_id: releaseId, limit: "50", cursor });
  const response = await sendInternalAdminRequest(adminApp, `/releases/artifacts?${params.toString()}`, { method: "GET" });
  return await ArtifactPageSchema.validate(await readJsonOrThrow(response, "Loading source-map manifests"));
}

function mergeRegistryPages(current: readonly ReleaseSummary[], incoming: readonly ReleaseSummary[]): ReleaseSummary[] {
  const byId = new Map(current.map((release) => [release.id, release]));
  for (const release of incoming) byId.set(release.id, release);
  return [...byId.values()];
}

export function selectNewestReleaseId(current: string | null, releases: readonly ReleaseSummary[]): string | null {
  return current ?? releases.at(0)?.id ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function parseRegistryFilter(value: string): RegistryFilter {
  if (value === "all" || value === "open" || value === "archived" || value === "source-maps") return value;
  throw new Error(`Unknown registry filter ${value}`);
}

function parseRegistryDetailView(value: string): RegistryDetailView {
  if (value === "overview" || value === "source-maps" || value === "commits" || value === "deployments") return value;
  throw new Error(`Unknown registry detail view ${value}`);
}

export default function RegistryPageClient({ initialView = "overview" }: { initialView?: RegistryDetailView }) {
  const adminApp = useAdminApp();
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [continuationError, setContinuationError] = useState<string | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [details, setDetails] = useState<Map<string, RegistryEntry>>(() => new Map());
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [artifactsError, setArtifactsError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RegistryFilter>("all");
  const [view, setView] = useState<RegistryDetailView>(initialView);
  const didSelectNewest = useRef(false);
  const detailSequence = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    runAsynchronously(async () => {
      try {
        const page = await fetchRegistryPage(adminApp, null);
        if (cancelled) return;
        setReleases(page.items);
        setNextCursor(page.next_cursor);
        if (!didSelectNewest.current && page.items.length > 0) {
          didSelectNewest.current = true;
          setSelectedReleaseId((current) => selectNewestReleaseId(current, page.items));
        }
      } catch (error) {
        if (!cancelled) setListError(getErrorMessage(error));
      } finally {
        if (!cancelled) setListLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [adminApp, reloadToken]);

  const selectedSummary = releases.find((release) => release.id === selectedReleaseId) ?? null;
  useEffect(() => {
    if (selectedSummary === null || details.has(selectedSummary.id)) return;
    const sequence = ++detailSequence.current;
    setDetailLoading(true);
    setDetailError(null);
    runAsynchronously(async () => {
      try {
        const detail = await fetchRegistryEntry(adminApp, selectedSummary.version);
        if (sequence === detailSequence.current) setDetails((current) => new Map(current).set(detail.id, detail));
      } catch (error) {
        if (sequence === detailSequence.current) setDetailError(getErrorMessage(error));
      } finally {
        if (sequence === detailSequence.current) setDetailLoading(false);
      }
    });
  }, [adminApp, details, selectedSummary]);

  const selectedDetail = selectedReleaseId === null ? null : details.get(selectedReleaseId) ?? null;
  const filteredReleases = useMemo(() => releases.filter((release) => {
    if (filter === "all") return true;
    if (filter === "open" || filter === "archived") return release.status === filter;
    return (details.get(release.id)?.artifacts.items.length ?? 0) > 0;
  }), [details, filter, releases]);

  const loadSourceMapAvailability = async (items: readonly ReleaseSummary[]) => {
    const missing = items.filter((release) => !details.has(release.id));
    const loaded = await Promise.all(missing.map(async (release) => await fetchRegistryEntry(adminApp, release.version)));
    if (loaded.length === 0) return;
    setDetails((current) => {
      const next = new Map(current);
      for (const detail of loaded) next.set(detail.id, detail);
      return next;
    });
  };

  const selectFilter = async (id: string) => {
    const selected = parseRegistryFilter(id);
    setFilter(selected);
    if (selected !== "source-maps") return;
    setContinuationError(null);
    try {
      await loadSourceMapAvailability(releases);
    } catch (error) {
      setContinuationError(getErrorMessage(error));
    }
  };

  const showAllVersions = async () => {
    setLoadingAll(true);
    setContinuationError(null);
    let cursor = nextCursor;
    try {
      while (cursor !== null) {
        const page = await fetchRegistryPage(adminApp, cursor);
        setReleases((current) => mergeRegistryPages(current, page.items));
        if (filter === "source-maps") await loadSourceMapAvailability(page.items);
        cursor = page.next_cursor;
        setNextCursor(cursor);
      }
    } catch (error) {
      setContinuationError(getErrorMessage(error));
    } finally {
      setLoadingAll(false);
    }
  };

  const retryDetail = () => {
    if (selectedReleaseId === null) return;
    setDetails((current) => {
      const next = new Map(current);
      next.delete(selectedReleaseId);
      return next;
    });
  };

  const showAllSourceMaps = async () => {
    if (selectedDetail === null) return;
    setArtifactsLoading(true);
    setArtifactsError(null);
    let artifactPage = selectedDetail.artifacts;
    try {
      while (artifactPage.next_cursor !== null) {
        const page = await fetchArtifactPage(adminApp, selectedDetail.id, artifactPage.next_cursor);
        const byId = new Map(artifactPage.items.map((artifact) => [artifact.id, artifact]));
        for (const artifact of page.items) byId.set(artifact.id, artifact);
        artifactPage = { items: [...byId.values()], next_cursor: page.next_cursor };
        const nextDetail = { ...selectedDetail, artifacts: artifactPage };
        setDetails((current) => new Map(current).set(selectedDetail.id, nextDetail));
      }
    } catch (error) {
      setArtifactsError(getErrorMessage(error));
    } finally {
      setArtifactsLoading(false);
    }
  };

  return (
    <AppEnabledGuard appId="observability">
      <ObservabilityPageLayout
        title="Registry"
        actions={(
          // No time-range pill here: releases are a cursor-paginated history
          // rather than a window over telemetry, so the other tabs' 1h/24h/7d/30d
          // scope has nothing to act on.
          <ObservabilityToolbar
            actions={(
              <ObservabilityRefreshButton
                loading={listLoading}
                onRefresh={() => setReloadToken((value) => value + 1)}
              />
            )}
          />
        )}
      >
        <ObservabilitySplitLayout
          sidebarLabel="Version list"
          detailLabel="Selected release"
          sidebar={(
            <>
              <ObservabilityPaneHeader className="flex-col items-stretch gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Versions</span>
                  {!listLoading && listError === null && (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{filteredReleases.length.toLocaleString()}</span>
                  )}
                </div>
                <DesignCategoryTabs
                  categories={[
                    { id: "all", label: "All" }, { id: "open", label: "Open" },
                    { id: "archived", label: "Archived" }, { id: "source-maps", label: "Source maps" },
                  ]}
                  selectedCategory={filter}
                  onSelect={selectFilter}
                  size="sm"
                  glassmorphic={false}
                />
              </ObservabilityPaneHeader>
              <ObservabilityPaneBody scroll className="space-y-2 p-2">
                {listLoading && <ObservabilityLoadingState label="Loading versions…" />}
                {!listLoading && listError !== null && (
                  <ObservabilityErrorState
                    title="Versions could not load"
                    description={listError}
                    onRetry={() => setReloadToken((value) => value + 1)}
                  />
                )}
                {!listLoading && listError === null && releases.length === 0 && (
                  <ObservabilityEmptyState
                    icon={PackageIcon}
                    title="No releases yet"
                    description="Publish a version with `hexclave sourcemaps upload ./dist --release 1.4.2`."
                  />
                )}
                {!listLoading && listError === null && releases.length > 0 && filteredReleases.length === 0 && (
                  <ObservabilityEmptyState icon={PackageIcon} title="No versions match this view" />
                )}
                <div className="space-y-1">
                  {filteredReleases.map((release) => <DesignListItemRow key={release.id} icon={release.status === "archived" ? ArchiveBoxIcon : PackageIcon} title={release.version} subtitle={release.date_released ?? release.date_added} size="sm" onClick={() => setSelectedReleaseId(release.id)} className={release.id === selectedReleaseId ? "bg-foreground/[0.06] ring-1 ring-foreground/[0.08]" : undefined} />)}
                </div>
                {nextCursor !== null && <DesignButton size="sm" variant="secondary" loading={loadingAll} onClick={showAllVersions} className="w-full">Show all versions</DesignButton>}
                {continuationError !== null && (
                  <ObservabilityErrorState
                    title="Older versions could not load"
                    description={continuationError}
                    onRetry={showAllVersions}
                  />
                )}
              </ObservabilityPaneBody>
            </>
          )}
          detail={<RegistryDetail summary={selectedSummary} detail={selectedDetail} loading={detailLoading} error={detailError} view={view} onViewChange={setView} onRetry={retryDetail} artifactsLoading={artifactsLoading} artifactsError={artifactsError} onShowAllSourceMaps={showAllSourceMaps} />}
        />
      </ObservabilityPageLayout>
    </AppEnabledGuard>
  );
}

function RegistryDetail(props: { summary: ReleaseSummary | null, detail: RegistryEntry | null, loading: boolean, error: string | null, view: RegistryDetailView, onViewChange: (view: RegistryDetailView) => void, onRetry: () => void, artifactsLoading: boolean, artifactsError: string | null, onShowAllSourceMaps: () => Promise<void> }) {
  if (props.summary === null) {
    return <DesignCard title="Release detail" icon={RocketLaunchIcon}>
      <ObservabilityEmptyState icon={PackageIcon} title="Select a version to see its release detail" />
    </DesignCard>;
  }
  return <DesignCard title={props.summary.version} subtitle="Registry" icon={RocketLaunchIcon} actions={<DesignBadge label={props.summary.status} color={props.summary.status === "open" ? "green" : "zinc"} size="sm" />}>
    <div className="space-y-4">
      <DesignCategoryTabs categories={[
        { id: "overview", label: "Overview" }, { id: "source-maps", label: "Source maps", count: props.detail?.artifacts.items.length },
        { id: "commits", label: "Commits", count: props.detail?.commits.length }, { id: "deployments", label: "Deployments", count: props.detail?.deployments.length },
      ]} selectedCategory={props.view} onSelect={(id) => props.onViewChange(parseRegistryDetailView(id))} size="sm" glassmorphic={false} />
      {props.loading && <ObservabilityLoadingState label="Loading release details…" />}
      {!props.loading && props.error !== null && (
        <ObservabilityErrorState title="Release details could not load" description={props.error} onRetry={props.onRetry} />
      )}
      {!props.loading && props.error === null && props.detail !== null && <RegistryDetailContent detail={props.detail} view={props.view} artifactsLoading={props.artifactsLoading} artifactsError={props.artifactsError} onShowAllSourceMaps={props.onShowAllSourceMaps} />}
    </div>
  </DesignCard>;
}

export function RegistryDetailContent({ detail, view, artifactsLoading = false, artifactsError = null, onShowAllSourceMaps }: { detail: RegistryEntry, view: RegistryDetailView, artifactsLoading?: boolean, artifactsError?: string | null, onShowAllSourceMaps?: () => Promise<void> }) {
  if (view === "overview") return <dl className="grid gap-3 text-sm sm:grid-cols-2">
    <div><dt className="text-xs text-muted-foreground">Version</dt><dd className="font-medium">{detail.version}</dd></div>
    <div><dt className="text-xs text-muted-foreground">Added</dt><dd>{detail.date_added}</dd></div>
    <div><dt className="text-xs text-muted-foreground">Released</dt><dd>{detail.date_released ?? "Not marked released"}</dd></div>
    <div><dt className="text-xs text-muted-foreground">Ref</dt><dd>{detail.ref ?? "None"}</dd></div>
  </dl>;
  if (view === "source-maps") {
    if (detail.artifacts.items.length === 0) return <DesignAlert variant="info" title="No source maps for this version" description={`Upload them with \`hexclave sourcemaps upload ./dist --release ${detail.version}\`.`} />;
    return <div className="space-y-3">{detail.artifacts.items.map((artifact) => <DesignCard key={artifact.id} title={artifact.environment ?? "Source-map manifest"} subtitle={artifact.dist ?? "Default distribution"} icon={UploadSimpleIcon} gradient="default">
      <div className="space-y-3"><p className="break-all font-mono text-[11px] text-muted-foreground">Manifest {artifact.manifest_sha256}</p>{artifact.debug_ids.map((item) => <div key={item.id} className="rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-foreground/[0.08]">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs">{item.code_file}</span><DesignBadge label={item.source_map_inline ? "Inline map" : "External map"} color="zinc" size="sm" /></div>
        <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Debug ID {item.debug_id}</p>
        <p className="mt-1 text-xs text-muted-foreground">Bundle {formatBytes(item.bundle_bytes)}. Source map {formatBytes(item.source_map_bytes)}. Compressed {formatBytes(item.source_map_gzipped_bytes)}.</p>
      </div>)}</div>
    </DesignCard>)}{detail.artifacts.next_cursor !== null && onShowAllSourceMaps !== undefined && <DesignButton size="sm" variant="secondary" loading={artifactsLoading} onClick={onShowAllSourceMaps}>Show all source maps</DesignButton>}{artifactsError !== null && <DesignAlert variant="error" title="More source maps could not load" description={artifactsError} />}</div>;
  }
  if (view === "commits") {
    if (detail.commits.length === 0) return <DesignAlert variant="info" title="No commits" description="No commits are attached to this release." />;
    return <div className="space-y-1">{detail.commits.map((commit) => <DesignListItemRow key={commit.id} icon={GitCommitIcon} title={commit.message ?? commit.commit_sha} subtitle={`${commit.repository} · ${commit.commit_sha}`} size="sm" />)}</div>;
  }
  if (detail.deployments.length === 0) return <DesignAlert variant="info" title="No deployments" description="No deployments are attached to this release." />;
  return <div className="space-y-1">{detail.deployments.map((deployment) => <DesignListItemRow key={deployment.id} icon={BugIcon} title={deployment.name ?? deployment.deployment_key} subtitle={`${deployment.environment} · ${deployment.finished_at}`} size="sm" />)}</div>;
}
