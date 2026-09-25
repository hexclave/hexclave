"use client";

import { Spinner, cn } from "@/components/ui";
import { getPublicEnvVar } from "@/lib/env";
import type { AdminDeploymentJson, AdminDeploymentServiceJson } from "@hexclave/next";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { FileTsIcon, MinusIcon, PlusIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdminApp } from "../use-admin-app";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  buildBoardServices,
  buildDeploymentScope,
  type BoardService,
} from "./board-model";
import { buildEdgePath, deriveConnections, getEdgeAnchors } from "./connections";
import { ServiceDetailPane } from "./service-detail-pane";
import { ServiceNode } from "./service-node";
import { BLUEPRINT_VARIANT, getAccentClasses, type Accent } from "./variants";

// Below this pointer travel a press counts as a click (select / deselect),
// not a drag or pan.
const DRAG_THRESHOLD = 4;

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;

// Breathing room left around the node cluster when fitting it to the viewport,
// so nodes don't sit flush against the edges (or under the floating chrome).
const FIT_PADDING = 96;

// The board data is cheap to fetch, so a simple always-on poll keeps deploy
// statuses fresh without a websocket.
const REFRESH_INTERVAL_MS = 15_000;

function clampZoom(z: number): number {
  return Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);
}

// Viewport transform: world→screen is `screen = world * zoom + {x, y}`.
type View = { x: number, y: number, zoom: number };

type Interaction =
  | { mode: "node", id: string, startClientX: number, startClientY: number, startWorldX: number, startWorldY: number, moved: boolean }
  | { mode: "pan", startClientX: number, startClientY: number, startViewX: number, startViewY: number, moved: boolean };

/**
 * The project's service map as of the moment one deployment completed.
 *
 * Deliberately NOT scoped to the services that deploy shipped. A project deployed from
 * several repositories has a deployment source per repository, deploying independently, and
 * a map showing only one source's services would hide every cross-source connection —
 * `service("api").url(8080)` in the frontend repo would draw an edge to a node that isn't
 * there. So each OTHER source contributes its own newest deployment at or before this one
 * (see buildDeploymentScope), and the nodes are coloured by source so the reader can still
 * tell whose is whose.
 *
 * Node STATE comes from those deployments' outcomes, not from the services' current rows: a
 * board opened on an older deploy shows what was running then, including the failures. The
 * topology and build settings still come from the current definitions — a Deployment records
 * what it shipped, not a copy of the graph — so a service reconfigured since will draw with
 * today's ports and env.
 */
export function BoardCanvas({ deployment, deployments, linkedServiceId, linkedPanel }: {
  deployment: AdminDeploymentJson,
  // Every deployment the list has loaded, of every source. What the other
  // sources had running at `deployment`'s moment is read from these.
  deployments: AdminDeploymentJson[],
  // The service and panel a `hexclave deploy` link named, or null. Props rather
  // than read from the URL here: page-client strips the params as soon as it has
  // them, and this component mounts after that.
  linkedServiceId: string | null,
  linkedPanel: string | null,
}) {
  const variant = BLUEPRINT_VARIANT;
  const adminApp = useAdminApp();
  const project = adminApp.useProject();

  const [apiServices, setApiServices] = useState<AdminDeploymentServiceJson[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const scope = useMemo(
    () => apiServices == null ? null : buildDeploymentScope({ openDeployment: deployment, deployments, apiServices }),
    [deployment, deployments, apiServices],
  );
  const outcomeByServiceId = scope?.outcomeByServiceId ?? new Map();

  const refresh = useCallback(async () => {
    try {
      const services = await project.listDeploymentServices();
      setApiServices(services);
      setLoadError(null);
    } catch (error) {
      // Keep whatever data we have; the board shows the error banner.
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [project]);

  useEffect(() => {
    runAsynchronously(refresh());
    const interval = setInterval(() => runAsynchronously(refresh()), REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The service a `hexclave deploy` link names, opened once the board knows its
  // services. Applied once: after that the board is the user's to navigate.
  const appliedLink = useRef(false);
  // The linked panel, held until the user navigates away from the linked node.
  // Cleared rather than re-derived, so that closing the pane and reopening the
  // same service is a fresh look at it — not a replay of the link.
  const [pendingPanel, setPendingPanel] = useState<string | null>(linkedPanel);
  const selectService = useCallback((id: string | null) => {
    setSelectedId(id);
    setPendingPanel(null);
  }, []);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  // In-session drag positions, keyed by service id, on top of the
  // deterministic layout. Not persisted — a refresh resets the layout.
  const [positionOverrides, setPositionOverrides] = useState<Map<string, { x: number, y: number }>>(new Map());

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const hexclaveApiHost = useMemo(() => {
    const apiUrl = getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL");
    if (apiUrl == null || apiUrl === "") return "api.hexclave.com";
    try {
      return new URL(apiUrl).host;
    } catch {
      return "api.hexclave.com";
    }
  }, []);

  const services = useMemo(() => {
    if (apiServices == null || scope == null) return null;
    // Filtered BEFORE the layout runs, so positions have no holes where a
    // hidden service would have been.
    const visible = apiServices.filter((apiService) => scope.visibleServiceIds.has(apiService.id));
    return buildBoardServices(visible, hexclaveApiHost, scope.statusByServiceId)
      .map((service) => {
        const override = positionOverrides.get(service.id);
        return override != null ? { ...service, x: override.x, y: override.y } : service;
      });
  }, [apiServices, hexclaveApiHost, positionOverrides, scope]);

  useEffect(() => {
    if (appliedLink.current || linkedServiceId === null || services === null) return;
    const match = services.find((service) => service.id === linkedServiceId);
    appliedLink.current = true;
    // A link to a service this deployment does not have leaves the map open,
    // which is the right place to be when the named one is gone.
    if (match !== undefined) setSelectedId(match.id);
    else setPendingPanel(null);
  }, [linkedServiceId, services]);

  const selected = services?.find((s) => s.id === selectedId) ?? null;
  const connections = useMemo(() => deriveConnections(services ?? []), [services]);

  // One entry per source actually on the map, in the order the nodes are laid
  // out, so the legend reads left-to-right with the board.
  const legend = useMemo(() => {
    const entries = new Map<string, { sourceId: string, accent: Accent, deployment: AdminDeploymentJson | null }>();
    for (const service of services ?? []) {
      if (service.sourceId == null || entries.has(service.sourceId)) continue;
      entries.set(service.sourceId, {
        sourceId: service.sourceId,
        accent: service.accent,
        deployment: scope?.deploymentBySourceId.get(service.sourceId) ?? null,
      });
    }
    return [...entries.values()];
  }, [services, scope]);

  const linkedIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const ids = new Set<string>();
    for (const c of connections) {
      if (c.fromId === selectedId) ids.add(c.toId);
      if (c.toId === selectedId) ids.add(c.fromId);
    }
    return ids;
  }, [connections, selectedId]);

  // Fit the board to the viewport once it has a size and the services are known.
  const centeredRef = useRef(false);
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || services == null || centeredRef.current) return;
    const center = () => {
      if (centeredRef.current) return;
      const width = vp.clientWidth;
      const height = vp.clientHeight;
      if (width === 0 || height === 0 || services.length === 0) return;
      centeredRef.current = true;
      const xs = services.map((s) => s.x + NODE_WIDTH / 2);
      const ys = services.map((s) => s.y + NODE_HEIGHT / 2);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      // Scale DOWN to fit, never up: a two-node map at 250% would look broken.
      // Without this the view stays at 1:1 and anything past four services (or
      // any map at all in a laptop-height window) opens with nodes off-screen —
      // and the board has no scrollbars, so they read as missing entirely.
      const contentWidth = Math.max(...xs) - Math.min(...xs) + NODE_WIDTH + FIT_PADDING;
      const contentHeight = Math.max(...ys) - Math.min(...ys) + NODE_HEIGHT + FIT_PADDING;
      const zoom = clampZoom(Math.min(1, width / contentWidth, height / contentHeight));
      setView({ x: width / 2 - cx * zoom, y: height / 2 - cy * zoom, zoom });
      observer.disconnect();
    };
    const observer = new ResizeObserver(center);
    observer.observe(vp);
    center();
    return () => observer.disconnect();
  }, [services]);

  const zoomTowards = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const nz = clampZoom(v.zoom * factor);
      const worldX = (cx - v.x) / v.zoom;
      const worldY = (cy - v.y) / v.zoom;
      return { x: cx - worldX * nz, y: cy - worldY * nz, zoom: nz };
    });
  }, []);

  const zoomByButton = useCallback((factor: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    zoomTowards(factor, rect.width / 2, rect.height / 2);
  }, [zoomTowards]);

  // Native, non-passive wheel handler: cmd/ctrl + wheel zooms towards the
  // cursor, plain wheel pans. preventDefault stops the page from scrolling.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      // Let the detail pane / controls scroll normally; only the empty canvas
      // pans and zooms.
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-board-chrome]")) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = vp.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * 0.002);
        zoomTowards(factor, e.clientX - rect.left, e.clientY - rect.top);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [zoomTowards]);

  const handleNodePointerDown = useCallback((e: React.PointerEvent, serviceId: string) => {
    if (e.button !== 0) return;
    // Keep the viewport pan handler from also firing.
    e.stopPropagation();
    const service = services?.find((s) => s.id === serviceId);
    if (!service) return;
    interactionRef.current = {
      mode: "node",
      id: serviceId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWorldX: service.x,
      startWorldY: service.y,
      moved: false,
    };
  }, [services]);

  const handleViewportPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    interactionRef.current = {
      mode: "pan",
      startClientX: e.clientX,
      startClientY: e.clientY,
      startViewX: viewRef.current.x,
      startViewY: viewRef.current.y,
      moved: false,
    };
  }, []);

  // Window-level move/up so drags and pans keep tracking outside the element.
  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const it = interactionRef.current;
      if (!it) return;
      const dist = Math.hypot(e.clientX - it.startClientX, e.clientY - it.startClientY);
      if (!it.moved && dist < DRAG_THRESHOLD) return;
      if (it.mode === "node") {
        if (!it.moved) {
          it.moved = true;
          setDraggingId(it.id);
        }
        const zoom = viewRef.current.zoom;
        const x = it.startWorldX + (e.clientX - it.startClientX) / zoom;
        const y = it.startWorldY + (e.clientY - it.startClientY) / zoom;
        setPositionOverrides((prev) => new Map(prev).set(it.id, { x, y }));
      } else {
        it.moved = true;
        setView((v) => ({ ...v, x: it.startViewX + (e.clientX - it.startClientX), y: it.startViewY + (e.clientY - it.startClientY) }));
      }
    };
    const handleUp = () => {
      const it = interactionRef.current;
      if (it && !it.moved) {
        // A click without meaningful movement: select a node, or deselect on
        // empty canvas.
        selectService(it.mode === "node" ? it.id : null);
      }
      interactionRef.current = null;
      setDraggingId(null);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
    // `selectService` is useCallback([]), so listing it re-subscribes nothing.
  }, [selectService]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") selectService(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectService]);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-2xl ring-1 ring-black/[0.06] dark:ring-white/[0.06]">
      {/* Infinite pan/zoom viewport. The blueprint grid is a CSS background so it
          tiles infinitely as the user pans, and scales with zoom. */}
      <div
        ref={viewportRef}
        onPointerDown={handleViewportPointerDown}
        className={cn(
          "absolute inset-0 touch-none select-none overflow-hidden",
          "bg-[#f7f8fa] dark:bg-[#0b1220]",
          "[--grid-minor:rgba(37,99,235,0.10)] [--grid-major:rgba(37,99,235,0.20)] dark:[--grid-minor:rgba(103,232,249,0.07)] dark:[--grid-major:rgba(103,232,249,0.13)]",
          draggingId ? "cursor-grabbing" : "cursor-grab",
        )}
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--grid-minor) 1px, transparent 1px)," +
            "linear-gradient(to bottom, var(--grid-minor) 1px, transparent 1px)," +
            "linear-gradient(to right, var(--grid-major) 1px, transparent 1px)," +
            "linear-gradient(to bottom, var(--grid-major) 1px, transparent 1px)",
          backgroundSize:
            `${24 * view.zoom}px ${24 * view.zoom}px, ${24 * view.zoom}px ${24 * view.zoom}px, ` +
            `${120 * view.zoom}px ${120 * view.zoom}px, ${120 * view.zoom}px ${120 * view.zoom}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        {services == null ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : (
          // Transformed world layer.
          <div className="absolute left-0 top-0" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: "0 0" }}>
            <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
              {connections.map((connection) => {
                const from = services.find((s) => s.id === connection.fromId);
                const to = services.find((s) => s.id === connection.toId);
                if (!from || !to) return null;
                const anchors = getEdgeAnchors(from, to);
                const path = buildEdgePath(anchors, variant.connectorStyle);
                // The edge takes the colour of the service that DECLARES the
                // reference, so a cross-source connection visibly leaves its
                // repository's colour and lands on another's.
                const accent = getAccentClasses(from.accent);
                const active = selectedId === from.id || selectedId === to.id;
                const dimmed = selectedId != null && !active;
                return (
                  <g key={connection.id} className={cn(accent.stroke, "transition-opacity duration-150")} opacity={dimmed ? 0.25 : 1}>
                    <path d={path} fill="none" stroke="currentColor" strokeWidth={active ? 2.5 : 1.75} strokeDasharray={variant.connectorDashed ? "5 5" : undefined} strokeLinecap="round" />
                    <circle cx={anchors.end.x} cy={anchors.end.y} r={active ? 4 : 3} fill="currentColor" />
                  </g>
                );
              })}
            </svg>

            {services.map((service) => (
              <ServiceNode
                key={service.id}
                service={service}
                variant={variant}
                selected={selectedId === service.id}
                dragging={draggingId === service.id}
                linked={linkedIds.has(service.id)}
                onPointerDown={handleNodePointerDown}
              />
            ))}
          </div>
        )}
      </div>

      {/* Config-as-code hint / source legend / error banners — top-left. */}
      <div data-board-chrome onPointerDown={(e) => e.stopPropagation()} className="absolute left-3 top-3 z-20 flex max-w-[60%] flex-col gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-white/80 px-3 py-2 text-xs text-muted-foreground ring-1 ring-black/[0.08] backdrop-blur-md dark:bg-background/70 dark:ring-white/[0.08]">
          <FileTsIcon className="h-4 w-4 shrink-0" />
          <span>
            Everything running when deployment #{deployment.number} finished. Services are defined by the <span className="font-mono">services</span> member of the <span className="font-mono">deploy</span> export of your <span className="font-mono">hexclave.deploy.ts</span> and synced by <span className="font-mono">hexclave deploy</span>.
          </span>
        </div>
        {/* Legend. Only earns its space once a second source is on the map —
            with one source the node colour distinguishes nothing. Each entry
            names the deployment its source's state was read from, since only
            one of them is the deployment the reader opened. */}
        {legend.length > 1 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-white/80 px-3 py-2 text-xs ring-1 ring-black/[0.08] backdrop-blur-md dark:bg-background/70 dark:ring-white/[0.08]">
            {legend.map((entry) => (
              <span key={entry.sourceId} className="flex items-center gap-1.5">
                <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", getAccentClasses(entry.accent).bar)} />
                <span className="font-mono text-foreground/80">{entry.sourceId}</span>
                <span className="text-muted-foreground">
                  {entry.deployment == null
                    ? "current"
                    : entry.deployment.id === deployment.id ? `#${entry.deployment.number}` : `#${entry.deployment.number} (then latest)`}
                </span>
              </span>
            ))}
          </div>
        )}
        {loadError != null && (
          <div className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 ring-1 ring-red-500/30 backdrop-blur-md dark:text-red-300">
            <WarningCircleIcon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">Failed to load deployments: {loadError}</span>
          </div>
        )}
      </div>

      {/* Zoom controls — bottom-left. */}
      <div data-board-chrome onPointerDown={(e) => e.stopPropagation()} className="absolute bottom-3 left-3 z-20 flex items-center overflow-hidden rounded-xl bg-white/80 shadow-sm ring-1 ring-black/[0.08] backdrop-blur-md dark:bg-background/70 dark:ring-white/[0.08]">
        <button onClick={() => zoomByButton(1 / 1.2)} aria-label="Zoom out" className="flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground hover:transition-none">
          <MinusIcon className="h-4 w-4" />
        </button>
        <span className="w-12 select-none text-center text-[11px] tabular-nums text-muted-foreground">{Math.round(view.zoom * 100)}%</span>
        <button onClick={() => zoomByButton(1.2)} aria-label="Zoom in" className="flex h-8 w-8 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground hover:transition-none">
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Detail pane — slides over the right edge. */}
      <div
        data-board-chrome
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          "absolute inset-y-0 right-0 z-30 w-[560px] max-w-[94vw] border-l border-border/60 bg-background/95 shadow-[-8px_0_32px_rgba(0,0,0,0.08)] backdrop-blur-xl transition-transform duration-200 ease-out",
          selected ? "translate-x-0" : "pointer-events-none translate-x-full",
        )}
      >
        {selected && services != null && (
          <ServiceDetailPane
            service={selected}
            services={services}
            project={project}
            // The deploy's own id and this service's outcome in it: the build
            // log belongs to the DEPLOYMENT (one builder machine builds every
            // service), and the outcome is what that deploy did with this one.
            // `?? null` covers the managed hexclave node, which is in no deploy.
            deploymentId={deployment.id}
            // False when no builder ever started, because every service of the
            // deploy ran an already-built image. Distinct from "not deployed
            // yet", so the Build logs tab can say which it is.
            hasBuildLogs={deployment.has_build_logs}
            initialTab={selected.id === linkedServiceId ? pendingPanel : null}
            outcome={outcomeByServiceId.get(selected.id) ?? null}
            onClose={() => selectService(null)}
            refresh={refresh}
          />
        )}
      </div>
    </div>
  );
}
