"use client";

import { DesignBadge, DesignButton, DesignInput } from "@/components/design-components";
import { CopyButton, Label, Spinner, cn } from "@/components/ui";
import type { AdminDeploymentDomainJson, AdminDeploymentServiceJson, AdminDeploymentServiceLogLineJson, AdminDeploymentServiceOutcomeJson, AdminProject } from "@hexclave/next";
import { deploymentPortOwnsStandardPorts, parseConnectionValue, sourceManifestEntriesForService, type DeploymentSourceManifest } from "@hexclave/shared/dist/deployments";
import { runAsynchronously, runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  ClockIcon,
  FileIcon,
  FolderIcon,
  LinkSimpleIcon,
  LockSimpleIcon,
  PlusIcon,
  ProhibitIcon,
  RocketLaunchIcon,
  StarIcon,
  TerminalWindowIcon,
  TrashIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getServiceOutputs, portEntriesOf, type BoardService, type EnvVar } from "./board-model";
import { allDirectoryPaths, buildSourceTree, visibleRows, type SourceTreeNode } from "./source-tree";

type DesignBadgeColor = "blue" | "cyan" | "purple" | "green" | "orange" | "red";

// -- shared bits ------------------------------------------------------------

export function serviceStatusMeta(status: Exclude<AdminDeploymentServiceJson["status"], "not_deployed">): { label: string, color: DesignBadgeColor, icon: React.ElementType, spin: boolean } {
  switch (status) {
    case "queued": { return { label: "Queued", color: "blue", icon: ClockIcon, spin: false }; }
    case "building": { return { label: "Building", color: "cyan", icon: CircleNotchIcon, spin: true }; }
    case "deploying": { return { label: "Deploying", color: "cyan", icon: CircleNotchIcon, spin: true }; }
    case "deployed": { return { label: "Deployed", color: "green", icon: CheckCircleIcon, spin: false }; }
    case "failed": { return { label: "Failed", color: "red", icon: XCircleIcon, spin: false }; }
    case "canceled": { return { label: "Cancelled", color: "orange", icon: ProhibitIcon, spin: false }; }
  }
}

export function serviceOutcomeMeta(status: AdminDeploymentServiceOutcomeJson["status"]): { label: string, color: DesignBadgeColor, icon: React.ElementType, spin: boolean } {
  switch (status) {
    // `spin` marks the non-terminal states so the CircleNotch icon animates (via
    // `animate-spin`) instead of sitting frozen mid-notch.
    case "pending": { return { label: "Pending", color: "blue", icon: ClockIcon, spin: false }; }
    case "building": { return { label: "Building", color: "cyan", icon: CircleNotchIcon, spin: true }; }
    case "deploying": { return { label: "Deploying", color: "cyan", icon: CircleNotchIcon, spin: true }; }
    case "deployed": { return { label: "Deployed", color: "green", icon: CheckCircleIcon, spin: false }; }
    case "failed": { return { label: "Failed", color: "red", icon: XCircleIcon, spin: false }; }
    // The deploy never reached it — its build failed, or something it depends
    // on did. Named after the cause ("Build failed") rather than the effect
    // ("Skipped"), which told a reader nothing about why nothing shipped.
    case "skipped": { return { label: "Build failed", color: "orange", icon: ProhibitIcon, spin: false }; }
  }
}

function formatDeployTime(millis: number): string {
  return new Date(millis).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function ExternalLink({ hostname, className }: { hostname: string, className?: string }) {
  return (
    <a
      href={`https://${hostname}`}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group/link inline-flex min-w-0 items-center gap-1 font-mono text-sm text-primary hover:underline",
        className,
      )}
    >
      <span className="truncate">{hostname}</span>
      <ArrowSquareOutIcon className="h-3.5 w-3.5 shrink-0 opacity-60 transition-opacity duration-150 group-hover/link:opacity-100 group-hover/link:transition-none" />
    </a>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Label className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</Label>;
}

function InlineError({ message, detail }: { message: string, detail?: string }) {
  return (
    <div className="rounded-xl bg-red-500/[0.06] px-3 py-2 text-xs text-red-600 ring-1 ring-red-500/20 dark:text-red-400">
      {message}
      {detail != null && (
        <div className="mt-1 break-words font-mono text-[10px] text-red-600/70 dark:text-red-400/70">{detail}</div>
      )}
    </div>
  );
}

function CenteredSpinner() {
  return (
    <div className="flex h-24 items-center justify-center">
      <Spinner />
    </div>
  );
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A terminal-style log viewer. Always dark (conventional for logs) so it reads
// the same in light and dark theme.
function LogViewer({ text }: { text: string }) {
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-xl bg-[#0b0f19] p-3 font-mono text-[11px] leading-relaxed ring-1 ring-white/[0.08]">
      {lines.map((line, index) => (
        <div key={index} className="min-w-0 whitespace-pre-wrap break-words text-white/80">
          {line === "" ? " " : line}
        </div>
      ))}
    </div>
  );
}

// -- Deploy-your-code CLI hint ----------------------------------------------

function CodeSnippet({ code }: { code: string }) {
  return (
    <div className="relative rounded-xl bg-[#0b0f19] p-3 pr-10 font-mono text-[11px] leading-relaxed text-white/85 ring-1 ring-white/[0.08]">
      <pre className="overflow-x-auto whitespace-pre">{code}</pre>
      <div className="absolute right-2 top-2">
        <CopyButton content={code} size="sm" />
      </div>
    </div>
  );
}

function DeployCodeHint({ service, project }: { service: BoardService, project: AdminProject }) {
  const deployCommands = [
    "# from the directory containing your hexclave.deploy.ts",
    "npx @hexclave/cli@latest login",
    `npx @hexclave/cli@latest deploy --service-id ${service.id} --cloud-project-id ${project.id}`,
  ].join("\n");

  return (
    <div className="space-y-2.5 rounded-xl bg-cyan-500/[0.05] p-3 ring-1 ring-cyan-500/20">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <RocketLaunchIcon className="h-4 w-4 text-cyan-500" weight="fill" />
        Deploy your code
      </div>
      <p className="text-xs text-muted-foreground">
        This service has no deployment yet. Deploy it with the Hexclave CLI — its configuration comes from the <span className="font-mono">services</span> member of the <span className="font-mono">deploy</span> export of your <span className="font-mono">hexclave.deploy.ts</span> (omit <span className="font-mono">--service-id</span> to deploy every service):
      </p>
      <CodeSnippet code={deployCommands} />
    </div>
  );
}

// -- Overview ---------------------------------------------------------------

export function OverviewContent({ service, project, isHexclave }: {
  service: BoardService,
  project: AdminProject,
  isHexclave: boolean,
}) {
  const serviceStatus = service.api?.status ?? null;
  const latestMeta = serviceStatus == null || serviceStatus === "not_deployed" ? null : serviceStatusMeta(serviceStatus);
  const LatestIcon = latestMeta?.icon ?? ClockIcon;

  return (
    <div className="h-full space-y-5 overflow-y-auto p-4">
      <div className="space-y-2">
        <SectionLabel>Service name</SectionLabel>
        <DesignInput value={service.name} size="sm" disabled readOnly />
        {isHexclave && (
          <p className="text-[11px] text-muted-foreground">The Hexclave service is managed for you and can&apos;t be renamed or removed.</p>
        )}
      </div>

      {service.domain != null && (
        <div className="space-y-1.5">
          <SectionLabel>Domain</SectionLabel>
          <div>
            <ExternalLink hostname={service.domain} />
          </div>
        </div>
      )}

      {!isHexclave && service.api != null && !service.api.has_successful_deploy && (
        <DeployCodeHint service={service} project={project} />
      )}

      {latestMeta != null && (
        <div className="space-y-1.5">
          <SectionLabel>Latest deployment</SectionLabel>
          <div className="rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-black/[0.04] dark:ring-white/[0.04]">
            <div className="flex items-center gap-2">
              <DesignBadge label={latestMeta.label} color={latestMeta.color} size="sm" icon={LatestIcon} iconClassName={latestMeta.spin ? "animate-spin" : undefined} />
              {/* Which deploy file this service came from: with several
                  repositories deploying into one project, that is the first
                  thing a reader needs in order to know where to change it. */}
              {service.api?.deployment_source_id != null && (
                <span className="font-mono text-[11px] text-muted-foreground">{service.api.deployment_source_id}</span>
              )}
            </div>
            {service.api?.url != null && (
              <div className="mt-2">
                <ExternalLink hostname={new URL(service.api.url).host} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// -- Variables --------------------------------------------------------------

const ENV_VAR_TYPE_LABELS = new Map<EnvVar["type"], string>([
  ["plain", "Value"],
  ["secret", "Secret"],
  ["connection", "Connection"],
]);

// Read-only on purpose: env var definitions come from the `services` export of
// hexclave.deploy.ts and are synced by `hexclave deploy` — the dashboard only
// displays them. Secret VALUES are entered under Project Settings > Secrets.
export function VariablesContent({ service, services, isHexclave }: {
  service: BoardService,
  services: BoardService[],
  isHexclave: boolean,
}) {
  if (isHexclave) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          The Hexclave service&apos;s environment is managed for you.
        </div>
      </div>
    );
  }

  return (
    <div className="h-full space-y-3 overflow-y-auto p-4">
      <p className="text-[11px] text-muted-foreground">
        Variables are defined in the <span className="font-mono">services</span> member of the <span className="font-mono">deploy</span> export of your <span className="font-mono">hexclave.deploy.ts</span> and synced when you run <span className="font-mono">hexclave deploy</span>. Secret values are entered under Project Settings &gt; Secrets. A build also sees <span className="font-mono">CI=true</span>, and a deploy run in CI passes its <span className="font-mono">CI_COMMIT_*</span> variables through to the services it builds.
      </p>

      {service.envVars.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          No variables. Add them to the service&apos;s <span className="font-mono">env</span> in your deploy file, then deploy.
        </div>
      )}

      {service.envVars.map((envVar) => (
        <div key={envVar.key} className="space-y-1.5 rounded-xl bg-foreground/[0.02] p-2.5 ring-1 ring-black/[0.04] dark:ring-white/[0.04]">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">{envVar.key}</span>
            <span className="shrink-0 rounded-md bg-foreground/[0.05] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {ENV_VAR_TYPE_LABELS.get(envVar.type) ?? envVar.type}
            </span>
          </div>

          {envVar.type === "plain" && (
            <div className="truncate rounded-lg bg-foreground/[0.03] px-2 py-1 font-mono text-[11px] text-muted-foreground">{envVar.value}</div>
          )}

          {envVar.type === "secret" && (
            <div className="flex items-center gap-1.5 rounded-lg bg-amber-500/[0.06] px-2 py-1 text-[11px] text-muted-foreground ring-1 ring-amber-500/20">
              <LockSimpleIcon className="h-3 w-3 shrink-0 text-amber-500" weight="fill" />
              <span className="min-w-0 truncate">
                Secret <span className="font-mono text-foreground">{envVar.secretKey}</span> · value set under Project Settings &gt; Secrets
              </span>
            </div>
          )}

          {envVar.type === "connection" && envVar.value != null && (
            <ConnectionTarget value={envVar.value} services={services} />
          )}
        </div>
      ))}
    </div>
  );
}

function ConnectionTarget({ value, services }: { value: string, services: BoardService[] }) {
  // The SHARED parser: a reference may carry a `:<port>` suffix
  // (`api.internalUrl:9090`), and splitting on the dot alone would leave
  // "internalUrl:9090" as the output key and render every such value as unknown.
  const parsed = parseConnectionValue(value);
  const serviceId = parsed?.serviceId ?? value;
  const outputKey = parsed?.outputKey ?? "";
  const source = services.find((s) => s.id === serviceId);
  const output = source ? getServiceOutputs(source.type).find((o) => o.key === outputKey) : undefined;
  const resolved = source != null && output != null;

  return (
    <div className={cn(
      "flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px]",
      resolved ? "bg-primary/[0.06] text-muted-foreground ring-1 ring-primary/15" : "bg-red-500/[0.06] text-red-600 ring-1 ring-red-500/20 dark:text-red-400",
    )}>
      <LinkSimpleIcon className="h-3 w-3 shrink-0" />
      {resolved ? (
        <span className="min-w-0 truncate">
          Linked to <span className="font-mono font-medium text-foreground">{serviceId}.{outputKey}{parsed?.port == null ? "" : `:${parsed.port}`}</span>
          {output.secret ? " · secret, resolved at deploy time" : " · resolved at deploy time"}
        </span>
      ) : (
        <span className="min-w-0 truncate">Unknown output <span className="font-mono">{value}</span></span>
      )}
    </div>
  );
}

// -- Build logs -------------------------------------------------------------
//
// A tab in the service detail pane. The page is scoped to one deployment, so the run shown

function useDeploymentBuildLogs(project: AdminProject, deploymentId: string | null) {
  const [logs, setLogs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);

  useEffect(() => {
    if (deploymentId == null) return;
    let cancelled = false;
    const abortController = new AbortController();
    setLogs(null);
    setError(null);
    runAsynchronously(async () => {
      try {
        // The request follows a running build server-side, so it can take a
        // while to resolve — the spinner stays up until the logs are complete.
        // Abort on cleanup so an abandoned view doesn't keep the server
        // following the build for minutes.
        const text = await project.getDeploymentBuildLogs(deploymentId, { signal: abortController.signal });
        if (!cancelled) setLogs(text);
      } catch (loadError) {
        if (!cancelled) setError(errorMessageOf(loadError));
      }
    });
    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [project, deploymentId, reloadCounter]);

  return { logs, error, reload: () => setReloadCounter((c) => c + 1) };
}

// ---------------------------------------------------------------------------
// Source

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function EmptyPanel({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

/**
 * What this deploy PACKAGED and sent, for this service's subtree.
 *
 * Paths and sizes, never contents: the uploaded tarball is consumed by the build
 * and deleted, so a listing is what survives it. It exists to answer the two
 * questions a large or surprising upload provokes — which files are big, and did
 * my .gitignore/.dockerignore actually exclude what I meant.
 */
/** One deployment's source manifest, fetched on demand. See SourceContent. */
function useSourceManifest(project: AdminProject, deploymentId: string | null) {
  const [manifest, setManifest] = useState<DeploymentSourceManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (deploymentId == null) {
      setManifest(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setManifest(null);
    setError(null);
    setLoading(true);
    runAsynchronously(async () => {
      try {
        const deployment = await project.getDeployment(deploymentId);
        if (!cancelled) setManifest(deployment.source_manifest);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project, deploymentId]);

  return { manifest, error, loading };
}

function SourceTreeRow({ node, depth, expanded, onToggle }: {
  node: SourceTreeNode,
  depth: number,
  expanded: boolean,
  onToggle: (path: string) => void,
}) {
  // Rows are indented by depth rather than nested in the DOM: the list scrolls
  // as one column of equal rows, and a nested tree would indent the size column
  // along with the name.
  const indent = { paddingLeft: 10 + depth * 14 };
  const rowClassName = "flex w-full items-center gap-1.5 border-b border-border/40 bg-foreground/[0.02] py-1.5 pr-2.5 text-left last:border-b-0";

  if (node.kind === "file") {
    return (
      <div className={rowClassName} style={indent}>
        {/* Occupies the caret's width so filenames line up with the folder
            names they sit under, rather than with their carets. */}
        <span className="size-3 shrink-0" />
        <FileIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
        {/* The row shows the name; the full path is on the title, since the
            folders above it are on screen anyway. */}
        <span className="truncate font-mono text-[11px]" title={node.path}>{node.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{formatFileSize(node.bytes)}</span>
      </div>
    );
  }

  return (
    <button type="button" onClick={() => onToggle(node.path)} className={cn(rowClassName, "hover:bg-foreground/[0.06]")} style={indent} aria-expanded={expanded}>
      <CaretRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} weight="bold" />
      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" weight={expanded ? "regular" : "fill"} />
      <span className="truncate font-mono text-[11px]" title={node.path}>{node.name}</span>
      <span className="shrink-0 text-[10px] text-muted-foreground/70">{node.fileCount.toLocaleString()}</span>
      {/* A folder's size is its subtree's, which is the number that makes a
          collapsed row worth reading at all. */}
      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{formatFileSize(node.bytes)}</span>
    </button>
  );
}

/**
 * The manifest slice as a folder tree.
 *
 * Takes the manifest rather than the sliced entries: the slice is a fresh array
 * on every render, and the tree — which the expand/collapse set is keyed on —
 * has to stay the same object across renders or every click would be undone by
 * the re-render it causes.
 */
function SourceFileTree({ manifest, rootDirectory }: { manifest: DeploymentSourceManifest, rootDirectory: string | null }) {
  const tree = useMemo(() => {
    const { entries, prefix } = sourceManifestEntriesForService(manifest, rootDirectory);
    const nodes = buildSourceTree(entries, prefix);
    return { nodes, fileCount: entries.length, directories: allDirectoryPaths(nodes) };
  }, [manifest, rootDirectory]);

  // Every folder starts closed, so the tab opens as the shape of the upload —
  // one screen of top-level folders with their sizes — rather than a wall of
  // files. Expand all is one click away for a reader who wants the whole thing.
  //
  // Reset on a new tree (the reader switched service or deployment) rather than
  // in an effect, so the first render of the new tree is already the right one.
  const [state, setState] = useState(() => ({ nodes: tree.nodes, expanded: new Set<string>() }));
  if (state.nodes !== tree.nodes) {
    setState({ nodes: tree.nodes, expanded: new Set<string>() });
  }

  const toggle = useCallback((path: string) => {
    setState((previous) => {
      const expanded = new Set(previous.expanded);
      if (!expanded.delete(path)) expanded.add(path);
      return { nodes: previous.nodes, expanded };
    });
  }, []);

  const allExpanded = tree.directories.length > 0 && tree.directories.every((path) => state.expanded.has(path));
  const rows = visibleRows(state.nodes, state.expanded);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 items-center justify-between gap-3">
        {/* Largest first is worth saying out loud: it is what makes the top row
            of every level the answer to "why is this upload so big", and it is
            not the order a file tree is usually read in. */}
        <p className="text-[11px] text-muted-foreground">
          {tree.fileCount.toLocaleString()} file{tree.fileCount === 1 ? "" : "s"}, largest first.
        </p>
        {tree.directories.length > 0 && (
          <button
            type="button"
            className="shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setState((previous) => ({ nodes: previous.nodes, expanded: allExpanded ? new Set<string>() : new Set(tree.directories) }))}
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-xl ring-1 ring-black/[0.04] dark:ring-white/[0.04]">
        {rows.map(({ node, depth }) => (
          <SourceTreeRow
            key={`${node.kind}:${node.path}`}
            node={node}
            depth={depth}
            expanded={node.kind === "directory" && state.expanded.has(node.path)}
            onToggle={toggle}
          />
        ))}
      </div>
    </div>
  );
}

export function SourceContent({ deploymentId, project, service, isHexclave }: {
  // Read on demand rather than taken from the open deployment: the listing the
  // board is built from is polled every few seconds and deliberately omits the
  // manifest, which is per-deployment and can hold thousands of files. Fetched
  // HERE, so only a reader who opens this tab pays for it.
  deploymentId: string | null,
  project: AdminProject,
  service: BoardService,
  isHexclave: boolean,
}) {
  // An image with a BUILD COMMAND is built from the upload like anything else,
  // so it has a source listing; only a service that merely runs one has none.
  const isSourceBuilt = service.api != null && (service.api.image == null || service.api.build_command != null);
  const skip = isHexclave || !isSourceBuilt || deploymentId == null;
  const { manifest, error, loading } = useSourceManifest(project, skip ? null : deploymentId);

  if (isHexclave) {
    return <EmptyPanel>The Hexclave service is deployed for you from no source of yours, so this deploy packaged nothing for it.</EmptyPanel>;
  }
  // A service that only runs an image is not built from the upload at all. Said
  // before the manifest is checked, because "nothing was packaged" and "this
  // service has no source" are different facts and only one is about this
  // service.
  if (service.api != null && !isSourceBuilt) {
    return <EmptyPanel>This service runs an already-built image with no build command, so no source is packaged or uploaded for it.</EmptyPanel>;
  }
  if (deploymentId == null) {
    return <EmptyPanel>This service has not been deployed yet, so nothing has been packaged for it.</EmptyPanel>;
  }
  if (loading) {
    return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  }
  if (error != null) {
    return <EmptyPanel>Could not load the source listing: {error}</EmptyPanel>;
  }
  if (manifest === null) {
    return <EmptyPanel>This deploy recorded no source listing. Deploys made before the CLI started reporting one, and deploys that built nothing, have none.</EmptyPanel>;
  }

  const rootDirectory = service.api?.root_directory ?? null;
  const { entries, truncated } = sourceManifestEntriesForService(manifest, rootDirectory);
  const scopeLabel = rootDirectory == null || rootDirectory === "" || rootDirectory === "." ? "the deploy file's directory" : rootDirectory;

  return (
    // A column rather than one scrolling block, so the file list can take every
    // pixel the totals and the footnote do not and scroll inside itself. The
    // listing is the point of this tab; it should not be a short window under a
    // header that scrolls away with it.
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="shrink-0 space-y-2">
        <SectionLabel>Uploaded for this deploy</SectionLabel>
        {/* The deployment's totals, not this service's: one deploy uploads ONE
            tree and every source-built service is built from it, so the number
            that explains a slow or rejected upload belongs to the deploy. */}
        <div className="rounded-xl bg-foreground/[0.03] p-3 text-xs ring-1 ring-black/[0.04] dark:ring-white/[0.04]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{manifest.file_count.toLocaleString()} file{manifest.file_count === 1 ? "" : "s"}</span>
            <span className="font-mono">{formatFileSize(manifest.compressed_bytes)} sent</span>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {formatFileSize(manifest.total_bytes)} on disk, compressed to {formatFileSize(manifest.compressed_bytes)}. Every service of this deploy is built from this one upload.
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="shrink-0">
          <SectionLabel>Files under {scopeLabel}</SectionLabel>
        </div>
        {entries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
            {truncated
              ? <>None of the {manifest.entries.length.toLocaleString()} files this listing kept are under {scopeLabel}.</>
              : <>Nothing was packaged under {scopeLabel}.</>}
          </div>
        ) : (
          <SourceFileTree manifest={manifest} rootDirectory={rootDirectory} />
        )}
        {truncated && (
          // Only ever shown for a tree past the cap, which is far larger than
          // any ordinary source. Said anyway: a listing that silently stopped
          // short would be read as "these are the files".
          <p className="shrink-0 text-[11px] text-muted-foreground">
            This deploy packaged {manifest.file_count.toLocaleString()} files, more than the listing can hold. The {manifest.entries.length.toLocaleString()} largest are kept; the rest are smaller than every file shown.
          </p>
        )}
      </div>

      <p className="shrink-0 text-[11px] text-muted-foreground">
        This is what <span className="font-mono">hexclave deploy</span> packaged after your <span className="font-mono">.gitignore</span> and <span className="font-mono">.dockerignore</span> rules. Anything here that shouldn&apos;t be uploaded belongs in one of them.
      </p>
    </div>
  );
}

export function BuildLogsContent({ deploymentId, hasBuildLogs, outcome, project, isHexclave }: {
  // The deployment whose build produced this service's image. One deploy is one
  // build — every service of the deployment source is built by the same machine
  // — so the log below is that build's, not this service's alone.
  deploymentId: string | null,
  // Whether that deploy built anything. A deploy whose every service runs an
  // already-built image starts no builder, so there is no log to fetch — and
  // fetching anyway would render an empty stream that looks like a failure.
  hasBuildLogs: boolean,
  outcome: AdminDeploymentServiceOutcomeJson | null,
  project: AdminProject,
  isHexclave: boolean,
}) {
  // Hooks first: useDeploymentBuildLogs has to run on every render, so the
  // "nothing to show" cases below are returned after it rather than
  // short-circuiting above it.
  const { logs, error, reload } = useDeploymentBuildLogs(project, isHexclave || !hasBuildLogs ? null : deploymentId);

  if (isHexclave) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          The Hexclave service is deployed and updated for you, so it has no build of its own.
        </div>
      </div>
    );
  }

  if (deploymentId != null && !hasBuildLogs) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          <div>Nothing was built for this deploy — every service in it runs an already-built image with no build command.</div>
          {/* The digest still belongs here. It is the only place the exact bytes
              this deploy ran are shown — the Settings panel names the tag the
              author wrote, which is a different fact — and returning early
              without it would hide that from precisely the deploys where the
              tag alone does not identify what is running. */}
          {outcome?.image != null && (
            <div className="mt-2 truncate font-mono text-[11px]" title={outcome.image}>{outcome.image}</div>
          )}
        </div>
      </div>
    );
  }

  if (deploymentId == null) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          This service has not been deployed yet, so there are no build logs.
        </div>
      </div>
    );
  }

  const meta = outcome === null ? null : serviceOutcomeMeta(outcome.status);
  const Icon = meta?.icon ?? ClockIcon;

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 space-y-2">
        {meta !== null && (
          <div className="flex items-center gap-2">
            <DesignBadge label={meta.label} color={meta.color} size="sm" icon={Icon} iconClassName={meta.spin ? "animate-spin" : undefined} />
            {outcome?.revision != null && <span className="font-mono text-[11px] text-muted-foreground">{outcome.revision}</span>}
          </div>
        )}
        {/* What this deploy actually ran, digest-pinned. The tag an author wrote
            and the bytes that ran are different facts, and only this one explains
            a deploy that behaved unexpectedly. */}
        {outcome?.image != null && (
          <div className="truncate font-mono text-[11px] text-muted-foreground" title={outcome.image}>{outcome.image}</div>
        )}
        {outcome?.url != null && <ExternalLink hostname={new URL(outcome.url).host} />}
        {outcome?.error != null && <div className="text-xs text-red-600 dark:text-red-400">{outcome.error}</div>}
      </div>

      <div className="mb-1.5 flex items-center justify-between">
        {/* One log for the whole deploy: say so, or a reader looking for this
            service's lines will think the others leaked in. */}
        <SectionLabel>Build logs (all services of this deploy)</SectionLabel>
        <DesignButton variant="ghost" size="icon" className="h-6 w-6" onClick={reload} aria-label="Reload logs">
          <ArrowClockwiseIcon className="h-3.5 w-3.5" />
        </DesignButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {error != null && <InlineError message={error} />}
        {logs == null && error == null && <CenteredSpinner />}
        {logs != null && <LogViewer text={logs === "" ? "(no build logs)" : logs} />}
      </div>
    </div>
  );
}

// -- Runtime logs -----------------------------------------------------------
//
// What the container printed while RUNNING, as opposed to what its build
// printed. Unlike the build log this has no end, so the view follows: the
// endpoint streams for a few minutes and closes, and this reconnects from the
// last timestamp it saw for as long as the tab is open.

// Held in memory. A chatty service can print faster than anyone can read, and
// an unbounded array is a tab that grows until the browser gives up.
const MAX_RUNTIME_LOG_LINES = 5_000;
// Lines arrive one callback at a time; re-rendering per line would make a busy
// service unusable. They are buffered and flushed on this interval instead.
const RUNTIME_LOG_FLUSH_MS = 250;
// Between a stream closing (server-side follow cap, or a transport blip) and
// reconnecting. Short enough to read as continuous, long enough that a route
// that keeps failing is not hammered.
const RUNTIME_LOG_RECONNECT_MS = 1_000;

function formatLogTime(millis: number): string {
  const date = new Date(millis);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * Follows a service's runtime logs for as long as the component is mounted.
 *
 * The server stops following after a few minutes and closes the stream, so this
 * loops: each pass resumes from the largest `at_millis` already seen, which is
 * why a reconnect neither repeats nor skips. `sinceMillis` lives in a ref rather
 * than state because the loop reads it across awaits — as state it would close
 * over the value from the render that started the loop.
 */
function useServiceRuntimeLogs(project: AdminProject, serviceId: string | null) {
  const [lines, setLines] = useState<AdminDeploymentServiceLogLineJson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);

  useEffect(() => {
    if (serviceId == null) return;
    const view = { cancelled: false };
    // Read through a call, never by touching the flag directly. The follow loop
    // tests it again after awaits, and TypeScript's control-flow analysis — which
    // cannot see the cleanup below run — would otherwise keep it narrowed to
    // whatever the loop condition implied and report those checks as unreachable.
    const isCancelled = () => view.cancelled;
    const abortController = new AbortController();
    setLines([]);
    setError(null);
    setStarted(false);

    // Newest timestamp handed to us so far — the cursor a reconnect resumes at.
    const sinceMillis = { current: undefined as number | undefined };
    let buffered: AdminDeploymentServiceLogLineJson[] = [];
    const flush = () => {
      if (buffered.length === 0) return;
      const batch = buffered;
      buffered = [];
      setLines((previous) => {
        const next = [...previous, ...batch];
        return next.length > MAX_RUNTIME_LOG_LINES ? next.slice(next.length - MAX_RUNTIME_LOG_LINES) : next;
      });
    };
    const flushTimer = setInterval(flush, RUNTIME_LOG_FLUSH_MS);

    runAsynchronously(async () => {
      while (!isCancelled()) {
        try {
          await project.getDeploymentServiceLogs(serviceId, {
            sinceMillis: sinceMillis.current,
            signal: abortController.signal,
            onLine: (line) => {
              // Strictly increasing, so an out-of-order timestamp cannot rewind
              // the cursor and make the next pass replay what we already have.
              if (sinceMillis.current === undefined || line.at_millis + 1 > sinceMillis.current) {
                sinceMillis.current = line.at_millis + 1;
              }
              buffered.push(line);
            },
          });
          if (isCancelled()) return;
          // A clean close is the server's follow cap, not an end: reconnect.
          setError(null);
        } catch (streamError) {
          if (isCancelled()) return;
          // Lines delivered before the failure are real output and stay on
          // screen; the message sits above them and clears on the next good pass.
          setError(errorMessageOf(streamError));
        } finally {
          if (!isCancelled()) {
            flush();
            setStarted(true);
          }
        }
        if (isCancelled()) return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, RUNTIME_LOG_RECONNECT_MS));
      }
    });

    return () => {
      view.cancelled = true;
      clearInterval(flushTimer);
      abortController.abort();
    };
  }, [project, serviceId, reloadCounter]);

  return { lines, error, started, reload: () => setReloadCounter((c) => c + 1) };
}

/** A runtime log line, with its time, instance and stream. */
function RuntimeLogViewer({ lines, showInstance }: { lines: AdminDeploymentServiceLogLineJson[], showInstance: boolean }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Follow the tail, but only while the reader is already at the bottom —
  // yanking the view down while someone is scrolled up reading is worse than
  // not following at all.
  const pinnedToBottom = useRef(true);
  const handleScroll = () => {
    const element = scrollRef.current;
    if (element == null) return;
    pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  };
  useEffect(() => {
    const element = scrollRef.current;
    if (element == null || !pinnedToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-auto rounded-xl bg-[#0b0f19] p-3 font-mono text-[11px] leading-relaxed ring-1 ring-white/[0.08]"
    >
      {lines.map((line, index) => (
        <div key={index} className="flex min-w-0 gap-2">
          <span className="shrink-0 text-white/30">{formatLogTime(line.at_millis)}</span>
          {showInstance && <span className="shrink-0 text-white/30">{line.instance ?? "—"}</span>}
          <span
            className={cn(
              "min-w-0 whitespace-pre-wrap break-words",
              // "system" is the runtime's own lifecycle chatter (machine started,
              // health check failed), not the service's output — dimmed so it
              // reads as a frame around the log rather than part of it.
              line.stream === "system" ? "text-cyan-300/60" : line.stream === "stderr" ? "text-red-300/90" : "text-white/80",
            )}
          >
            {line.text === "" ? " " : line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

export function RuntimeLogsContent({ service, project, isHexclave }: {
  service: BoardService,
  project: AdminProject,
  isHexclave: boolean,
}) {
  const [instanceFilter, setInstanceFilter] = useState<string | null>(null);
  // A service the runtime has never applied has no app to read logs from, and
  // the endpoint 400s on it — don't open a stream that can only fail.
  const provisioned = service.api?.provisioned ?? false;
  const { lines, error, started, reload } = useServiceRuntimeLogs(project, isHexclave || !provisioned ? null : service.id);

  // Built from what has actually arrived: the API reports how MANY instances a
  // service has, never which, so the lines themselves are the only source of
  // machine ids available here.
  const instances = useMemo(() => {
    const seen = new Set<string>();
    for (const line of lines) {
      if (line.instance != null && line.instance !== "") seen.add(line.instance);
    }
    return [...seen].sort();
  }, [lines]);

  const visibleLines = useMemo(
    () => (instanceFilter === null ? lines : lines.filter((line) => line.instance === instanceFilter)),
    [lines, instanceFilter],
  );

  if (isHexclave) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          The Hexclave service is run for you, so its runtime logs are not part of this project.
        </div>
      </div>
    );
  }

  if (!provisioned) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          This service has not been deployed yet, so it has no runtime logs.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        {/* Named against the Build logs tab next door: one is what the builder
            printed, this is what the service prints while running. */}
        <SectionLabel>Runtime logs (live)</SectionLabel>
        <div className="flex items-center gap-1.5">
          {instances.length > 1 && (
            <select
              value={instanceFilter ?? ""}
              onChange={(event) => setInstanceFilter(event.target.value === "" ? null : event.target.value)}
              className="h-6 rounded-md border border-border bg-background px-1.5 font-mono text-[11px] text-muted-foreground"
              aria-label="Filter by instance"
            >
              <option value="">All instances</option>
              {instances.map((instance) => <option key={instance} value={instance}>{instance}</option>)}
            </select>
          )}
          <DesignButton variant="ghost" size="icon" className="h-6 w-6" onClick={reload} aria-label="Reload logs">
            <ArrowClockwiseIcon className="h-3.5 w-3.5" />
          </DesignButton>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        {error != null && <InlineError message={error} />}
        {!started && lines.length === 0 && error == null && <CenteredSpinner />}
        {(started || lines.length > 0) && (
          visibleLines.length === 0
            ? (
              <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
                {lines.length === 0
                  ? "This service has not printed anything recently. New output appears here as it arrives."
                  : "No lines from this instance."}
              </div>
            )
            : <RuntimeLogViewer lines={visibleLines} showInstance={instanceFilter === null && instances.length > 1} />
        )}
      </div>
    </div>
  );
}

// -- Domains ----------------------------------------------------------------

// Refresh a pending domain's verification periodically while its details are
// expanded — verification flips when the user creates the DNS records.
const DOMAIN_POLL_INTERVAL_MS = 10_000;

function DomainDetails({ project, serviceId, hostname, onVerifiedChange }: {
  project: AdminProject,
  serviceId: string,
  hostname: string,
  onVerifiedChange: () => Promise<void>,
}) {
  const [details, setDetails] = useState<AdminDeploymentDomainJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasVerifiedRef = useRef<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await project.getDeploymentServiceDomain(serviceId, hostname);
        if (cancelled) return;
        setDetails(result);
        setError(null);
        if (wasVerifiedRef.current === false && result.verified) {
          // Freshly verified: let the board refresh so badges update.
          runAsynchronouslyWithAlert(onVerifiedChange());
        }
        wasVerifiedRef.current = result.verified;
        if (!result.verified) {
          timeout = setTimeout(() => runAsynchronously(load()), DOMAIN_POLL_INTERVAL_MS);
        }
      } catch (loadError) {
        if (cancelled) return;
        setError(errorMessageOf(loadError));
      }
    };
    runAsynchronously(load());
    return () => {
      cancelled = true;
      if (timeout !== undefined) clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, serviceId, hostname]);

  if (error != null) {
    return (
      <InlineError
        message="We couldn't check this domain's status. Make sure it's a real domain name — you can remove it and add it again."
        detail={error}
      />
    );
  }
  if (details == null) return <CenteredSpinner />;

  return (
    <div className="space-y-2">
      {details.pending_first_deploy && (
        <p className="text-[11px] text-muted-foreground">
          This service hasn&apos;t been deployed yet — the domain will be registered with the deployment target on the first deploy. You can already create these DNS records:
        </p>
      )}
      {details.verified ? (
        <p className="text-[11px] text-muted-foreground">DNS is configured correctly — no records needed.</p>
      ) : (
        <div className="overflow-hidden rounded-lg ring-1 ring-black/[0.06] dark:ring-white/[0.06]">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="bg-foreground/[0.04] text-muted-foreground">
                <th className="px-2 py-1.5 font-medium">Type</th>
                <th className="px-2 py-1.5 font-medium">Name</th>
                <th className="px-2 py-1.5 font-medium">Value</th>
                <th className="w-8 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {details.dns_records.map((record, index) => (
                <tr key={index} className="border-t border-border/40 font-mono">
                  <td className="px-2 py-1.5 text-foreground">{record.type}</td>
                  <td className="max-w-32 truncate px-2 py-1.5 text-foreground">{record.name}</td>
                  <td className="max-w-40 truncate px-2 py-1.5 text-foreground">{record.value}</td>
                  <td className="px-1 py-1">
                    <CopyButton content={`${record.type} ${record.name} ${record.value}`} size="sm" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!details.verified && (
        <p className="text-[11px] text-muted-foreground">
          Checking automatically — verification usually completes within a few minutes of creating the records.
        </p>
      )}
    </div>
  );
}

export function DomainsContent({ service, project, isHexclave, refresh }: {
  service: BoardService,
  project: AdminProject,
  isHexclave: boolean,
  refresh: () => Promise<void>,
}) {
  const [newDomain, setNewDomain] = useState("");
  const [expandedHostname, setExpandedHostname] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ message: string, detail?: string } | null>(null);

  const domains = service.api?.domains ?? [];
  // Domains are operational state (not part of the config-managed definition),
  // so they stay editable even when the config comes from a file or GitHub.
  const canEdit = !isHexclave;

  const handleAdd = useCallback(async () => {
    const trimmed = newDomain.trim().toLowerCase();
    if (trimmed.length === 0) return;
    setActionError(null);
    try {
      await project.addDeploymentServiceDomain(service.id, trimmed);
      setNewDomain("");
      await refresh();
      setExpandedHostname(trimmed);
    } catch (error) {
      setActionError({
        message: `We couldn't add "${trimmed}". Check that it's a real domain name you own (like app.example.com) and try again.`,
        detail: errorMessageOf(error),
      });
    }
  }, [newDomain, project, service.id, refresh]);

  return (
    <div className="h-full space-y-3 overflow-y-auto p-4">
      {canEdit && (
        <div className="flex items-center gap-1.5">
          <DesignInput
            value={newDomain}
            size="sm"
            placeholder="app.yourdomain.com"
            className="font-mono"
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runAsynchronouslyWithAlert(handleAdd()); }}
          />
          <DesignButton size="sm" variant="outline" className="shrink-0" onClick={handleAdd}>
            <PlusIcon className="mr-1.5 h-4 w-4" /> Add
          </DesignButton>
        </div>
      )}
      {actionError != null && <InlineError message={actionError.message} detail={actionError.detail} />}

      <div className="space-y-2">
        {domains.map((domain) => {
          const expanded = expandedHostname === domain.hostname;
          return (
            <div key={domain.hostname} className="rounded-xl bg-foreground/[0.02] ring-1 ring-black/[0.04] dark:ring-white/[0.04]">
              <div className="flex items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <ExternalLink hostname={domain.hostname} />
                  <div className="mt-1 flex items-center gap-1.5">
                    {domain.is_primary && <DesignBadge label="Primary" color="purple" size="sm" icon={StarIcon} />}
                    {domain.verified
                      ? <DesignBadge label="Verified" color="green" size="sm" icon={CheckCircleIcon} />
                      : <DesignBadge label="Pending verification" color="orange" size="sm" icon={WarningIcon} />}
                  </div>
                </div>
                <DesignButton
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
                  onClick={() => setExpandedHostname(expanded ? null : domain.hostname)}
                >
                  DNS
                  <CaretDownIcon className={cn("ml-1 h-3 w-3 transition-transform duration-150", expanded && "rotate-180")} />
                </DesignButton>
                {canEdit && (
                  <DesignButton
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-red-500"
                    aria-label="Remove domain"
                    onClick={async () => {
                      setActionError(null);
                      try {
                        await project.deleteDeploymentServiceDomain(service.id, domain.hostname);
                        await refresh();
                      } catch (error) {
                        setActionError({
                          message: `We couldn't remove "${domain.hostname}" right now. Please try again.`,
                          detail: errorMessageOf(error),
                        });
                      }
                    }}
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </DesignButton>
                )}
              </div>
              {expanded && (
                <div className="border-t border-border/40 px-3 py-2.5">
                  <DomainDetails project={project} serviceId={service.id} hostname={domain.hostname} onVerifiedChange={refresh} />
                </div>
              )}
            </div>
          );
        })}
        {domains.length === 0 && !isHexclave && (
          <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
            No custom domains yet.
          </div>
        )}
      </div>

      {isHexclave && (
        <p className="text-[11px] text-muted-foreground">The Hexclave service&apos;s domain is managed for you.</p>
      )}
    </div>
  );
}

// -- Settings (build config + danger zone) ----------------------------------

// Read-only on purpose (like the Variables tab): build settings come from the
// `services` export of hexclave.deploy.ts and are synced by `hexclave deploy`.
export function SettingsContent({ service, isHexclave }: {
  service: BoardService,
  isHexclave: boolean,
}) {
  if (isHexclave) {
    return (
      <div className="h-full overflow-y-auto p-4">
        <div className="rounded-xl border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          Container settings are managed by Hexclave for this service.
        </div>
      </div>
    );
  }

  const servicePorts = portEntriesOf(service.api?.ports ?? {});
  const isPublic = service.api?.public === true;
  // An `image` is the whole story only when nothing is built on top of it: with a
  // build command it is the BASE, the source IS uploaded, and the root directory
  // is where the build runs. So the source rows are hidden for the first and kept
  // for the second — on a plain image service they would read "./" and "None
  // (Railpack auto-detected build)", both false and the second misleading.
  const image = service.api?.image ?? null;
  const buildCommand = service.api?.build_command ?? null;
  const isBuilt = image === null || buildCommand !== null;
  // `fallback` is optional: the rows that only exist when they have a value have
  // no unreachable fallback.
  const fields: { label: string, value: string | null | undefined, fallback?: string }[] = [
    ...(image !== null ? [{ label: buildCommand !== null ? "Base image" : "Image", value: image }] : []),
    ...(isBuilt ? [
      { label: "Root directory", value: service.api?.root_directory, fallback: "./" },
      // The row exists when there IS a Dockerfile, and — when there is not — only
      // for the auto-detected build, where "no Dockerfile" is the fact worth
      // stating. A base-image build has nothing being detected, so the row would
      // describe a build this service does not have.
      ...(service.api?.dockerfile_path != null
        ? [{ label: "Dockerfile", value: service.api.dockerfile_path }]
        : image === null && buildCommand === null
          // A missing dockerfile_path means "Railpack build" only once a definition was
          // actually synced — before that (there are no ports either) it just means "not
          // synced yet".
          ? [{ label: "Dockerfile", value: undefined, fallback: servicePorts.length > 0 ? "None (Railpack auto-detected build)" : "Not synced yet" }]
          : []),
    ] : []),
    ...(buildCommand !== null ? [{ label: "Build command", value: buildCommand }] : []),
    // Shown for every service that has one, built or not: it is applied by the
    // runtime, so even a service that only runs an image can carry one.
    ...(service.api?.start_command != null ? [{ label: "Start command", value: service.api.start_command }] : []),
    // Visibility is the SERVICE's, so it gets a row of its own rather than being
    // repeated on every port.
    { label: "Visibility", value: service.api == null ? undefined : service.api.public ? "Public" : "Private", fallback: "Not synced yet" },
    // Every port the container listens on. On a public service with SEVERAL
    // ports the one owning 80/443 is called out, since it is the port the
    // service's URL points at and the only one a custom domain can front — not
    // something a reader can work out from a list of numbers.
    {
      label: servicePorts.length === 1 ? "Container port" : "Container ports",
      value: servicePorts.length > 0
        ? servicePorts.map((entry) => `${entry.port}${isPublic && servicePorts.length > 1 && deploymentPortOwnsStandardPorts(service.api?.ports ?? {}, isPublic, entry.port) ? " · 80/443" : ""}${entry.protocol === "tcp" ? " · tcp" : ""}`).join(", ")
        : undefined,
      fallback: "Not synced yet",
    },
    { label: "Min instances", value: service.api?.min_instances?.toString(), fallback: "0 (scale to zero)" },
    // Mirrors the deploy-time default (`max_instances ?? Math.max(min_instances, 1)`): a
    // service that declares only `minInstances: 3` really does run with a max of 3, so a
    // flat "1" here would contradict the fleet the user gets.
    { label: "Max instances", value: service.api?.max_instances?.toString(), fallback: Math.max(service.api?.min_instances ?? 0, 1).toString() },
    // The size the service RUNS at, which the API resolves — unlike the two
    // bounds above there is no "not set" to show, because a service that names
    // no size is running its type's default rather than running nothing.
    { label: "Memory", value: service.api?.memory, fallback: "Not synced yet" },
    // Stated because it is DERIVED from memory rather than chosen, and because
    // on the smaller server sizes it is a burstable fraction of a core: a 4GB
    // server that turns out to have one shared CPU is worth saying out loud
    // here rather than leaving to be discovered under load.
    {
      label: "CPU",
      value: service.api?.cpu == null
        ? undefined
        : `${service.api.cpu.count} vCPU${service.api.cpu.shared ? " · shared, burstable" : ""}`,
      fallback: "Not synced yet",
    },
    // No "Dev command" row: `devCommand` is consumed locally by `hexclave dev`
    // and never sent to the server, so there is nothing here to show.
  ];

  return (
    <div className="h-full space-y-5 overflow-y-auto p-4">
      <div className="space-y-3">
        <SectionLabel>Container</SectionLabel>
        <p className="text-[11px] text-muted-foreground">
          Container settings are defined in the <span className="font-mono">services</span> member of the <span className="font-mono">deploy</span> export of your <span className="font-mono">hexclave.deploy.ts</span> and synced when you run <span className="font-mono">hexclave deploy</span>. {!isBuilt
            ? <>This service runs an already-built image, so nothing is built for it. A tag is resolved when the image is pulled, so pin it by digest if a deploy must always run the same bytes.</>
            // The Dockerfile comes FIRST: it describes a complete build, so a
            // build command alongside it is appended to it rather than deciding
            // what the service is built on.
            : service.api?.dockerfile_path != null
              ? buildCommand !== null
                ? <>This service is built from its own Dockerfile, with the build command appended to it as a final <span className="font-mono">RUN</span>.</>
                : <>This service is built from its own Dockerfile.</>
              : image !== null
                ? <>This service is built on <span className="font-mono">{image}</span>: your source is copied in and the build command runs in the root directory above.</>
                : buildCommand !== null
                  ? <>This service is built on the Hexclave base image (Debian-based, with node, npm, pnpm, yarn and git) rather than being auto-detected, because it declares a <span className="font-mono">buildCommand</span>.</>
                  : <>The image is auto-detected with Railpack. Set <span className="font-mono">dockerfilePath</span> to build from your own Dockerfile instead, or a <span className="font-mono">buildCommand</span> to say how to build it yourself.</>}
          {service.api?.start_command != null && <> The start command replaces whatever the image would have started, and is applied when the container starts — changing it never rebuilds anything.</>}
        </p>
        {fields.map((field) => (
          <div key={field.label} className="space-y-1.5">
            <Label className="block text-xs font-medium text-muted-foreground">{field.label}</Label>
            <div className={cn(
              "truncate rounded-lg bg-foreground/[0.03] px-2.5 py-1.5 font-mono text-xs ring-1 ring-black/[0.04] dark:ring-white/[0.04]",
              field.value != null && field.value !== "" ? "text-foreground" : "text-muted-foreground",
            )}>
              {field.value != null && field.value !== "" ? field.value : field.fallback ?? ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
