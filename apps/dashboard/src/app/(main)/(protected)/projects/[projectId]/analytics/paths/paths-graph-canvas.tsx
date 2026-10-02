"use client";

import type React from "react";
import { DesignAlert, DesignButton, DesignInput } from "@/components/design-components";
import { cn } from "@/lib/utils";
import { ArrowCounterClockwiseIcon, ArrowsOutIcon, GitDiffIcon, PlusIcon, XCircleIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode } from "./force-layout";
import { normalizeUrlPath } from "./normalize-url";

const CARD_HEIGHT = 54;
const VIEW_PADDING = 56;
const DRAG_THRESHOLD_PX = 4;

export type PathComparisonResult = {
  path: string,
  uniqueVisitors: number,
};

type Gesture =
  | { kind: "idle" }
  | {
    kind: "panning",
    pointerId: number,
    startClient: { x: number, y: number },
    startTransform: { x: number, y: number },
  }
  | {
    kind: "dragging-node",
    pointerId: number,
    nodeId: string,
    startClient: { x: number, y: number },
    startPosition: { x: number, y: number },
    moved: boolean,
  };

type PathComparisonState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error", message: string }
  | { kind: "ready", results: PathComparisonResult[] };

type FunnelInput = {
  id: number,
  path: string,
};

function edgeOpacity(count: number, maxCount: number): number {
  if (maxCount === 0) return 0.08;
  return 0.08 + 0.52 * Math.sqrt(count / maxCount);
}

function edgeWidth(count: number, maxCount: number): number {
  if (maxCount === 0) return 0.5;
  return 0.6 + 2.4 * Math.sqrt(count / maxCount);
}

function fullNodeLabel(node: GraphNode): string {
  return `${node.domain}${node.label}`;
}

function funnelHalfHeight(uniqueVisitors: number, baseline: number): number {
  if (baseline === 0) return 7;
  return 7 + 47 * Math.max(0, Math.min(1, uniqueVisitors / baseline));
}

function horizontalFunnelPath(results: PathComparisonResult[], stageWidth: number, centerY: number): string {
  const baseline = results[0]?.uniqueVisitors ?? 0;
  const halfHeights = results.map((result) => funnelHalfHeight(result.uniqueVisitors, baseline));
  const firstHalfHeight = halfHeights[0] ?? 7;
  let path = `M 0 ${centerY - firstHalfHeight}`;

  for (let index = 0; index < results.length; index += 1) {
    const startX = index * stageWidth;
    const endX = startX + stageWidth;
    const startHalfHeight = halfHeights[index] ?? 7;
    const endHalfHeight = halfHeights[index + 1] ?? startHalfHeight;
    path += ` C ${startX + stageWidth * 0.42} ${centerY - startHalfHeight}, ${endX - stageWidth * 0.42} ${centerY - endHalfHeight}, ${endX} ${centerY - endHalfHeight}`;
  }

  const chartWidth = results.length * stageWidth;
  const lastHalfHeight = halfHeights[halfHeights.length - 1] ?? 7;
  path += ` L ${chartWidth} ${centerY + lastHalfHeight}`;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const startX = index * stageWidth;
    const endX = startX + stageWidth;
    const startHalfHeight = halfHeights[index] ?? 7;
    const endHalfHeight = halfHeights[index + 1] ?? startHalfHeight;
    path += ` C ${endX - stageWidth * 0.42} ${centerY + endHalfHeight}, ${startX + stageWidth * 0.42} ${centerY + startHalfHeight}, ${startX} ${centerY + startHalfHeight}`;
  }
  return `${path} Z`;
}

function HorizontalPathFunnel({ results }: { results: PathComparisonResult[] }) {
  const clipId = `path-funnel-${useId().replaceAll(":", "")}`;
  const chartWidth = Math.max(480, results.length * 160);
  const stageWidth = chartWidth / results.length;
  const centerY = 70;
  const baseline = results[0]?.uniqueVisitors ?? 0;
  const overallConversion = baseline === 0
    ? 0
    : Math.round((results[results.length - 1]?.uniqueVisitors ?? 0) / baseline * 100);
  const bandPath = horizontalFunnelPath(results, stageWidth, centerY);

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-border/50 bg-foreground/[0.025]">
      <div style={{ minWidth: chartWidth }}>
        <div className="relative h-36">
          <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox={`0 0 ${chartWidth} 140`} preserveAspectRatio="none">
            <defs>
              <clipPath id={clipId}>
                <path d={bandPath} />
              </clipPath>
            </defs>
            <g clipPath={`url(#${clipId})`}>
              {results.map((result, index) => (
                <rect
                  key={`${result.path}\0${index}`}
                  x={index * stageWidth}
                  y={0}
                  width={stageWidth}
                  height={140}
                  className={index % 2 === 0
                    ? "fill-zinc-400/35 dark:fill-blue-500/35"
                    : "fill-zinc-300/35 dark:fill-sky-500/30"}
                />
              ))}
            </g>
            <path d={bandPath} fill="none" className="stroke-zinc-500/40 dark:stroke-blue-500/45" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            {results.slice(1).map((result, index) => (
              <line
                key={`${result.path}\0${index + 1}`}
                x1={(index + 1) * stageWidth}
                x2={(index + 1) * stageWidth}
                y1={8}
                y2={132}
                className="stroke-border"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {results.slice(1).map((result, index) => {
            const currentIndex = index + 1;
            const previousVisitors = results[index].uniqueVisitors;
            const stepConversion = previousVisitors === 0 ? 0 : Math.round(result.uniqueVisitors / previousVisitors * 100);
            const dropOff = 100 - stepConversion;
            return (
              <span
                key={`${result.path}\0${currentIndex}`}
                aria-hidden
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-background/90 px-2 py-0.5 text-[9px] font-medium tabular-nums text-muted-foreground"
                style={{ left: `${currentIndex / results.length * 100}%` }}
              >
                −{dropOff}%
              </span>
            );
          })}
          <p className="absolute right-2 top-2 text-[10px] font-semibold tabular-nums text-foreground">{overallConversion}% conversion</p>
        </div>
        <ol
          aria-label="Path conversion funnel"
          className="grid border-t border-border/50"
          style={{ gridTemplateColumns: `repeat(${results.length}, minmax(0, 1fr))` }}
        >
          {results.map((result, index) => {
            const conversion = baseline === 0 ? 0 : Math.round(result.uniqueVisitors / baseline * 100);
            return (
              <li
                key={`${result.path}\0${index}`}
                aria-label={`Step ${index + 1}: ${result.path}, ${result.uniqueVisitors.toLocaleString()} unique visitors, ${conversion}% overall conversion`}
                className={cn("min-w-0 px-3 py-2", index > 0 && "border-l border-border/50")}
              >
                <p className="text-[11px] font-semibold tabular-nums text-foreground">{result.uniqueVisitors.toLocaleString()} visitors</p>
                <p className="truncate font-mono text-[10px] text-muted-foreground" title={result.path}>{index + 1}. {result.path}</p>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function getEdgePath(from: GraphNode, to: GraphNode, bundleOffset: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return null;
  const directionX = dx / distance;
  const directionY = dy / distance;
  const halfHeight = CARD_HEIGHT / 2;
  const fromDistance = Math.min(
    directionX !== 0 ? from.width / 2 / Math.abs(directionX) : Infinity,
    directionY !== 0 ? halfHeight / Math.abs(directionY) : Infinity,
  );
  const toDistance = Math.min(
    directionX !== 0 ? to.width / 2 / Math.abs(directionX) : Infinity,
    directionY !== 0 ? halfHeight / Math.abs(directionY) : Infinity,
  );
  const fromX = from.x + directionX * fromDistance;
  const fromY = from.y + directionY * fromDistance;
  const toX = to.x - directionX * toDistance;
  const toY = to.y - directionY * toDistance;
  const curvature = Math.min(distance * 0.08, 15) + bundleOffset * 8;
  return {
    fromX,
    fromY,
    toX,
    toY,
    controlX: (fromX + toX) / 2 - directionY * curvature,
    controlY: (fromY + toY) / 2 + directionX * curvature,
  };
}

export function PathsGraphCanvas({
  nodes,
  edges,
  weakEdges,
  totalNodeCount,
  totalEdgeCount,
  totalTransitionCount,
  visibleTransitionCount,
  initialCompareMode,
  comparePaths,
}: {
  nodes: GraphNode[],
  edges: GraphEdge[],
  weakEdges: GraphEdge[],
  totalNodeCount: number,
  totalEdgeCount: number,
  totalTransitionCount: number,
  visibleTransitionCount: number,
  initialCompareMode: boolean,
  comparePaths: (paths: string[]) => Promise<PathComparisonResult[]>,
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fittedGraphKeyRef = useRef<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [gesture, setGesture] = useState<Gesture>({ kind: "idle" });
  const [manualPositions, setManualPositions] = useState<Map<string, { x: number, y: number }>>(() => new Map());
  const [compareMode, setCompareMode] = useState(initialCompareMode);
  const nextFunnelInputIdRef = useRef(2);
  const [compareInputs, setCompareInputs] = useState<FunnelInput[]>([
    { id: 0, path: "" },
    { id: 1, path: "" },
  ]);
  const [comparison, setComparison] = useState<PathComparisonState>({ kind: "idle" });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const checkedPaths = useMemo(() => new Set(
    compareInputs
      .map((input) => input.path.trim())
      .filter((path) => path !== "")
      .map(normalizeUrlPath),
  ), [compareInputs]);

  useEffect(() => {
    const element = containerRef.current;
    if (element == null) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      setContainerSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (element == null) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      setTransform((current) => {
        const scale = Math.max(0.2, Math.min(3, current.scale * (event.deltaY > 0 ? 0.9 : 1.1)));
        const worldX = (pointerX - current.x) / current.scale;
        const worldY = (pointerY - current.y) / current.scale;
        return { scale, x: pointerX - worldX * scale, y: pointerY - worldY * scale };
      });
    };
    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => element.removeEventListener("wheel", handleWheel);
  }, []);

  const displayedNodes = useMemo(() => nodes.map((node) => {
    const position = manualPositions.get(node.id);
    return position == null ? node : { ...node, ...position };
  }), [manualPositions, nodes]);
  const nodeMap = useMemo(() => new Map(displayedNodes.map((node) => [node.id, node])), [displayedNodes]);
  const focusedNodeId = selectedNode ?? hoveredNode;
  const focusedNode = focusedNodeId == null ? null : nodeMap.get(focusedNodeId) ?? null;
  const maxCount = useMemo(() => edges.reduce((maximum, edge) => Math.max(maximum, edge.count), 0), [edges]);

  const nodeStats = useMemo(() => {
    const stats = new Map<string, { inbound: number, outbound: number }>();
    for (const node of displayedNodes) stats.set(node.id, { inbound: 0, outbound: 0 });
    for (const edge of [...edges, ...weakEdges]) {
      const from = stats.get(edge.from);
      const to = stats.get(edge.to);
      if (from != null) from.outbound += edge.count;
      if (to != null) to.inbound += edge.count;
    }
    return stats;
  }, [displayedNodes, edges, weakEdges]);

  const highlightedEdges = useMemo(() => {
    if (focusedNodeId == null) return null;
    return new Set([...edges, ...weakEdges]
      .filter((edge) => edge.from === focusedNodeId || edge.to === focusedNodeId)
      .map((edge) => `${edge.from}\0${edge.to}`));
  }, [edges, focusedNodeId, weakEdges]);
  const visibleWeakEdges = useMemo(() => focusedNodeId == null
    ? []
    : weakEdges.filter((edge) => edge.from === focusedNodeId || edge.to === focusedNodeId), [focusedNodeId, weakEdges]);
  const focusedNodeIds = useMemo(() => {
    if (focusedNodeId == null) return null;
    const ids = new Set([focusedNodeId]);
    for (const edge of [...edges, ...weakEdges]) {
      if (edge.from === focusedNodeId) ids.add(edge.to);
      if (edge.to === focusedNodeId) ids.add(edge.from);
    }
    return ids;
  }, [edges, focusedNodeId, weakEdges]);
  const focusedConnections = useMemo(() => focusedNodeId == null
    ? []
    : [...edges, ...weakEdges]
      .filter((edge) => edge.from === focusedNodeId || edge.to === focusedNodeId)
      .sort((left, right) => right.count - left.count)
      .slice(0, 8), [edges, focusedNodeId, weakEdges]);
  const edgeBundleOffsets = useMemo(() => {
    const pairCounts = new Map<string, number>();
    const offsets = new Map<string, number>();
    for (const edge of edges) {
      const pairKey = [edge.from, edge.to].sort().join("\0");
      const count = pairCounts.get(pairKey) ?? 0;
      offsets.set(`${edge.from}\0${edge.to}`, count);
      pairCounts.set(pairKey, count + 1);
    }
    return offsets;
  }, [edges]);

  const graphBounds = useMemo(() => {
    if (displayedNodes.length === 0) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const node of displayedNodes) {
      minX = Math.min(minX, node.x - node.width / 2);
      maxX = Math.max(maxX, node.x + node.width / 2);
      minY = Math.min(minY, node.y - CARD_HEIGHT / 2);
      maxY = Math.max(maxY, node.y + CARD_HEIGHT / 2);
    }
    return { minX, maxX, minY, maxY };
  }, [displayedNodes]);

  const fitView = useCallback(() => {
    if (graphBounds == null || containerSize.width === 0 || containerSize.height === 0) return;
    const graphWidth = Math.max(1, graphBounds.maxX - graphBounds.minX);
    const graphHeight = Math.max(1, graphBounds.maxY - graphBounds.minY);
    const scale = Math.min(
      1,
      Math.max(0.2, (containerSize.width - VIEW_PADDING * 2) / graphWidth),
      Math.max(0.2, (containerSize.height - VIEW_PADDING * 2) / graphHeight),
    );
    const centerX = (graphBounds.minX + graphBounds.maxX) / 2;
    const centerY = (graphBounds.minY + graphBounds.maxY) / 2;
    setTransform({
      scale,
      x: containerSize.width / 2 - centerX * scale,
      y: containerSize.height / 2 - centerY * scale,
    });
  }, [containerSize.height, containerSize.width, graphBounds]);

  const graphKey = nodes.map((node) => node.id).join("\0");
  useEffect(() => {
    if (
      fittedGraphKeyRef.current === graphKey
      || gesture.kind === "dragging-node"
      || graphBounds == null
      || containerSize.width === 0
      || containerSize.height === 0
    ) return;
    fittedGraphKeyRef.current = graphKey;
    fitView();
  }, [containerSize.height, containerSize.width, fitView, gesture.kind, graphBounds, graphKey]);

  const handleCanvasPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNode(null);
    setGesture({
      kind: "panning",
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startTransform: { x: transform.x, y: transform.y },
    });
  }, [transform.x, transform.y]);

  const handleCanvasPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.kind !== "panning" || gesture.pointerId !== event.pointerId) return;
    setTransform((current) => ({
      ...current,
      x: gesture.startTransform.x + event.clientX - gesture.startClient.x,
      y: gesture.startTransform.y + event.clientY - gesture.startClient.y,
    }));
  }, [gesture]);

  const handleCanvasPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (gesture.kind !== "panning" || gesture.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setGesture({ kind: "idle" });
  }, [gesture]);

  const activateNode = useCallback((nodeId: string) => {
    if (!compareMode) {
      setSelectedNode((current) => current === nodeId ? null : nodeId);
      return;
    }
    setCompareInputs((current) => {
      const emptyInput = current.find((input) => input.path.trim() === "");
      if (emptyInput == null) {
        const id = nextFunnelInputIdRef.current;
        nextFunnelInputIdRef.current += 1;
        return [...current, { id, path: nodeId }];
      }
      return current.map((input) => input.id === emptyInput.id ? { ...input, path: nodeId } : input);
    });
    setComparison({ kind: "idle" });
  }, [compareMode]);

  const handleNodePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>, node: GraphNode) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setGesture({
      kind: "dragging-node",
      pointerId: event.pointerId,
      nodeId: node.id,
      startClient: { x: event.clientX, y: event.clientY },
      startPosition: { x: node.x, y: node.y },
      moved: false,
    });
  }, []);

  const handleNodePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (gesture.kind !== "dragging-node" || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startClient.x;
    const dy = event.clientY - gesture.startClient.y;
    const moved = gesture.moved || Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
    if (!moved) return;
    setManualPositions((current) => {
      const next = new Map(current);
      next.set(gesture.nodeId, {
        x: gesture.startPosition.x + dx / transform.scale,
        y: gesture.startPosition.y + dy / transform.scale,
      });
      return next;
    });
    if (!gesture.moved) setGesture({ ...gesture, moved: true });
  }, [gesture, transform.scale]);

  const handleNodePointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (gesture.kind !== "dragging-node" || gesture.pointerId !== event.pointerId) return;
    event.stopPropagation();
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (!gesture.moved) activateNode(gesture.nodeId);
    setGesture({ kind: "idle" });
  }, [activateNode, gesture]);

  const resetPositions = useCallback(() => {
    setManualPositions(new Map());
    fittedGraphKeyRef.current = null;
  }, []);

  const runComparison = useCallback(async () => {
    const paths = compareInputs.map((input) => input.path.trim()).filter((path) => path !== "");
    if (paths.length < 2) {
      setComparison({ kind: "error", message: "Enter at least two exact paths." });
      return;
    }
    if (paths.some((path) => !path.startsWith("/"))) {
      setComparison({ kind: "error", message: "Each exact path must start with /." });
      return;
    }
    setComparison({ kind: "loading" });
    try {
      setComparison({ kind: "ready", results: await comparePaths(paths) });
    } catch (caught) {
      setComparison({ kind: "error", message: caught instanceof Error ? caught.message : String(caught) });
    }
  }, [compareInputs, comparePaths]);

  const addFunnelInput = useCallback(() => {
    const id = nextFunnelInputIdRef.current;
    nextFunnelInputIdRef.current += 1;
    setCompareInputs((current) => [...current, { id, path: "" }]);
    setComparison({ kind: "idle" });
  }, []);

  const clearFunnelInputs = useCallback(() => {
    const firstId = nextFunnelInputIdRef.current;
    nextFunnelInputIdRef.current += 2;
    setCompareInputs([
      { id: firstId, path: "" },
      { id: firstId + 1, path: "" },
    ]);
    setComparison({ kind: "idle" });
  }, []);

  const coverage = totalTransitionCount === 0 ? 0 : visibleTransitionCount / totalTransitionCount;

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full select-none overflow-hidden"
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handleCanvasPointerMove}
      onPointerUp={handleCanvasPointerUp}
      style={{ cursor: gesture.kind === "panning" ? "grabbing" : "grab" }}
    >
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-sm rounded-xl border border-border/50 bg-background/85 px-3 py-2 text-[10px] leading-relaxed text-muted-foreground shadow-sm backdrop-blur">
        <span className="font-semibold text-foreground">{nodes.length} of {totalNodeCount} pages</span>
        <span aria-hidden> · </span>
        <span>{Math.round(coverage * 100)}% of transitions</span>
        <span aria-hidden> · </span>
        <span>{edges.length} of {totalEdgeCount} routes</span>
      </div>

      <div className="absolute right-3 top-3 z-20 flex gap-1" onPointerDown={(event) => event.stopPropagation()}>
        <DesignButton
          onClick={() => {
            setCompareMode((current) => !current);
            setComparison({ kind: "idle" });
          }}
          variant="secondary"
          size="sm"
          className={cn(
            "gap-1.5 bg-white/95 backdrop-blur dark:bg-background/85",
            compareMode && "bg-zinc-100 text-foreground ring-1 ring-zinc-300 hover:bg-zinc-100 dark:bg-primary dark:text-primary-foreground dark:ring-primary/30 dark:hover:bg-primary/90",
          )}
          aria-pressed={compareMode}
        >
          <GitDiffIcon className="h-3.5 w-3.5" />
          Check paths
        </DesignButton>
        {manualPositions.size > 0 && (
          <DesignButton onClick={resetPositions} variant="secondary" size="sm" className="gap-1.5 bg-white/95 backdrop-blur dark:bg-background/85">
            <ArrowCounterClockwiseIcon className="h-3.5 w-3.5" />
            Reset
          </DesignButton>
        )}
        <DesignButton onClick={fitView} variant="secondary" size="sm" className="gap-1.5 bg-white/95 backdrop-blur dark:bg-background/85" aria-label="Fit navigation graph to view">
          <ArrowsOutIcon className="h-3.5 w-3.5" />
          Fit
        </DesignButton>
      </div>

      {compareMode && (
        <section className="absolute left-3 top-3 z-20 w-[min(56rem,calc(100%-1.5rem))] rounded-xl border border-zinc-200 bg-white p-3 shadow-md dark:border-border/60 dark:bg-background/95 dark:backdrop-blur" onPointerDown={(event) => event.stopPropagation()}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xs font-semibold text-foreground">Path funnel</h2>
              <p className="mt-0.5 text-[10px] text-muted-foreground">Unique visitors who reached each path in order. Select nodes or edit steps.</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <DesignButton size="icon" variant="secondary" className="h-8 w-8" onClick={clearFunnelInputs} aria-label="Clear funnel steps" title="Clear funnel steps">
                <XCircleIcon className="h-3.5 w-3.5" />
              </DesignButton>
              <DesignButton size="sm" variant="secondary" loading={comparison.kind === "loading"} onClick={runComparison}>Check</DesignButton>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-1">
            {compareInputs.map((input, index) => (
              <div key={input.id} className="relative min-w-40 flex-1">
                <DesignInput
                  aria-label={`Exact path ${index + 1}`}
                  value={input.path}
                  onChange={(event) => {
                    const value = event.target.value;
                    setCompareInputs((current) => current.map((currentInput) => currentInput.id === input.id ? { ...currentInput, path: value } : currentInput));
                    setComparison({ kind: "idle" });
                  }}
                  placeholder={index === 0 ? "/" : index === 1 ? "/pricing" : "/next-step"}
                  size="sm"
                  className={cn("min-w-0 font-mono text-[11px]", compareInputs.length > 2 && "pr-8")}
                />
                {compareInputs.length > 2 && (
                  <DesignButton
                    size="icon"
                    variant="ghost"
                    className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2"
                    onClick={() => {
                      setCompareInputs((current) => current.filter((currentInput) => currentInput.id !== input.id));
                      setComparison({ kind: "idle" });
                    }}
                    aria-label={`Remove step ${index + 1}`}
                  >
                    <XIcon className="h-3 w-3" />
                  </DesignButton>
                )}
              </div>
            ))}
            <DesignButton size="icon" variant="secondary" className="h-8 w-8 shrink-0" onClick={addFunnelInput} aria-label="Add funnel step" title="Add funnel step">
              <PlusIcon className="h-3.5 w-3.5" />
            </DesignButton>
          </div>
          {comparison.kind === "error" && (
            <DesignAlert className="mt-2" variant="error" title="Can't check paths" description={comparison.message} />
          )}
          {comparison.kind === "ready" && (
            <HorizontalPathFunnel results={comparison.results} />
          )}
        </section>
      )}

      {!compareMode && focusedNode != null && (
        <div className="pointer-events-auto absolute right-3 top-14 z-10 w-64 rounded-xl border border-border/50 bg-background/90 p-3 shadow-md backdrop-blur">
          <p className="select-text whitespace-normal break-all font-mono text-[11px] font-semibold text-foreground">
            {fullNodeLabel(focusedNode)}
          </p>
          <p className="mt-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">Connected routes</p>
          <div className="mt-2 space-y-1">
            {focusedConnections.map((edge) => {
              const outgoing = edge.from === focusedNode.id;
              const connectedNode = nodeMap.get(outgoing ? edge.to : edge.from);
              return (
                <div key={`${edge.from}\0${edge.to}`} className="flex items-center gap-2 rounded-lg bg-foreground/[0.035] px-2 py-1.5 text-[10px]">
                  <span className="w-3 shrink-0 text-center text-muted-foreground" aria-hidden>{outgoing ? "→" : "←"}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-foreground">{connectedNode == null ? outgoing ? edge.to : edge.from : fullNodeLabel(connectedNode)}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-foreground">{edge.count.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
          {selectedNode == null && <p className="mt-2 text-[9px] text-muted-foreground">Select the page to pin these routes.</p>}
        </div>
      )}

      <svg className="pointer-events-none absolute inset-0 h-full w-full" style={{ overflow: "visible" }}>
        <defs>
          <marker id="paths-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M 2 1 L 9 5 L 2 9" fill="none" className="stroke-foreground/50" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
          {[...edges, ...visibleWeakEdges].map((edge, index) => {
            const fromNode = nodeMap.get(edge.from);
            const toNode = nodeMap.get(edge.to);
            if (fromNode == null || toNode == null) return null;
            const path = getEdgePath(fromNode, toNode, edgeBundleOffsets.get(`${edge.from}\0${edge.to}`) ?? 0);
            if (path == null) return null;
            const isWeak = index >= edges.length;
            const highlighted = highlightedEdges == null || highlightedEdges.has(`${edge.from}\0${edge.to}`);
            const opacity = highlighted ? edgeOpacity(edge.count, maxCount) : focusedNodeId == null ? edgeOpacity(edge.count, maxCount) : 0.015;
            return (
              <path
                key={`${isWeak ? "weak-" : ""}${edge.from}\0${edge.to}`}
                d={`M ${path.fromX} ${path.fromY} Q ${path.controlX} ${path.controlY} ${path.toX} ${path.toY}`}
                fill="none"
                className="stroke-foreground"
                strokeWidth={edgeWidth(edge.count, maxCount)}
                strokeOpacity={isWeak ? opacity * 0.6 : opacity}
                strokeDasharray={isWeak ? "3 3" : undefined}
                markerEnd="url(#paths-arrow)"
              />
            );
          })}
        </g>
      </svg>

      <div className="pointer-events-none absolute inset-0" style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transformOrigin: "0 0" }}>
        {displayedNodes.map((node) => {
          const stats = nodeStats.get(node.id);
          const hovered = hoveredNode === node.id;
          const selected = selectedNode === node.id;
          const checked = compareMode && checkedPaths.has(node.id);
          const dimmed = focusedNodeIds != null && !focusedNodeIds.has(node.id);
          return (
            <button
              type="button"
              key={node.id}
              aria-pressed={selected || checked}
              aria-label={`${fullNodeLabel(node)}, ${node.pageViews.toLocaleString()} page views`}
              className={cn(
                "pointer-events-auto absolute cursor-move rounded-lg border px-2.5 py-1.5 text-left transition-[opacity,box-shadow,border-color] duration-150 hover:transition-none",
                "border-border bg-card text-card-foreground shadow-sm",
                (hovered || selected) && "z-10 border-blue-400/60 shadow-md ring-2 ring-blue-500/50",
                checked && !hovered && "z-10 border-zinc-400/60 bg-zinc-100/50 opacity-70 ring-1 ring-zinc-400/25 dark:border-blue-400/35 dark:bg-blue-500/5 dark:ring-blue-500/25",
                checked && hovered && "z-10 border-zinc-500 bg-zinc-100 opacity-100 shadow-md ring-2 ring-zinc-500/40 dark:border-blue-400/60 dark:bg-blue-500/10 dark:ring-blue-500/50",
                dimmed && "opacity-25",
              )}
              style={{ left: node.x - node.width / 2, top: node.y - CARD_HEIGHT / 2, width: node.width, height: CARD_HEIGHT }}
              onPointerDown={(event) => handleNodePointerDown(event, node)}
              onPointerMove={handleNodePointerMove}
              onPointerUp={handleNodePointerUp}
              onPointerCancel={() => setGesture({ kind: "idle" })}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                activateNode(node.id);
              }}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
            >
              <div className="flex items-center gap-1.5">
                {node.domain !== "" && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500/70" aria-hidden />}
                <div className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium leading-tight" title={fullNodeLabel(node)}>{node.label}</div>
              </div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span title="Page views">{node.pageViews.toLocaleString()} views</span>
                {(hovered || selected || checked) && (
                  <>
                    <span className="text-muted-foreground/50" aria-hidden>·</span>
                    <span title="Inbound transitions">←{stats?.inbound.toLocaleString() ?? 0}</span>
                    <span title="Outbound transitions">{stats?.outbound.toLocaleString() ?? 0}→</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
