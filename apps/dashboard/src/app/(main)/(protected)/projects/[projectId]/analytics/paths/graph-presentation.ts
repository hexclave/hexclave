import type { GraphEdge, GraphNode } from "./force-layout";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

const DEFAULT_MAX_BACKBONE_EDGES = 36;
const DEFAULT_MIN_BACKBONE_EDGES = 12;
const DEFAULT_TARGET_TRANSITION_COVERAGE = 0.8;

export type PathsGraphPresentation = {
  nodes: GraphNode[],
  edges: GraphEdge[],
  contextualEdges: GraphEdge[],
  totalNodeCount: number,
  totalEdgeCount: number,
  totalTransitionCount: number,
  visibleTransitionCount: number,
};

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return right.count - left.count
    || stringCompare(left.from, right.from)
    || stringCompare(left.to, right.to);
}

export function buildPathsGraphPresentation(
  nodes: readonly GraphNode[],
  allEdges: readonly GraphEdge[],
  options: {
    maxBackboneEdges?: number,
    minBackboneEdges?: number,
    targetTransitionCoverage?: number,
  } = {},
): PathsGraphPresentation {
  const maxBackboneEdges = options.maxBackboneEdges ?? DEFAULT_MAX_BACKBONE_EDGES;
  const minBackboneEdges = Math.min(
    options.minBackboneEdges ?? DEFAULT_MIN_BACKBONE_EDGES,
    maxBackboneEdges,
  );
  const targetTransitionCoverage = options.targetTransitionCoverage ?? DEFAULT_TARGET_TRANSITION_COVERAGE;
  if (!Number.isInteger(maxBackboneEdges) || maxBackboneEdges < 1) {
    throw new Error("maxBackboneEdges must be a positive integer");
  }
  if (!Number.isInteger(minBackboneEdges) || minBackboneEdges < 0) {
    throw new Error("minBackboneEdges must be a non-negative integer");
  }
  if (targetTransitionCoverage <= 0 || targetTransitionCoverage > 1) {
    throw new Error("targetTransitionCoverage must be greater than 0 and at most 1");
  }

  const sortedEdges = [...allEdges].sort(compareEdges);
  const totalTransitionCount = sortedEdges.reduce((sum, edge) => sum + edge.count, 0);
  const targetTransitionCount = totalTransitionCount * targetTransitionCoverage;
  const edges: GraphEdge[] = [];
  let visibleTransitionCount = 0;
  for (const edge of sortedEdges) {
    if (
      edges.length >= maxBackboneEdges
      || (edges.length >= minBackboneEdges && visibleTransitionCount >= targetTransitionCount)
    ) break;
    edges.push(edge);
    visibleTransitionCount += edge.count;
  }

  const visibleNodeIds = new Set<string>();
  for (const edge of edges) {
    visibleNodeIds.add(edge.from);
    visibleNodeIds.add(edge.to);
  }
  const visibleNodes = nodes.filter((node) => visibleNodeIds.has(node.id));
  const selectedEdgeIds = new Set(edges.map((edge) => `${edge.from}\0${edge.to}`));
  const contextualEdges = sortedEdges.filter((edge) => (
    !selectedEdgeIds.has(`${edge.from}\0${edge.to}`)
    && visibleNodeIds.has(edge.from)
    && visibleNodeIds.has(edge.to)
  ));

  return {
    nodes: visibleNodes,
    edges,
    contextualEdges,
    totalNodeCount: nodes.length,
    totalEdgeCount: allEdges.length,
    totalTransitionCount,
    visibleTransitionCount,
  };
}
