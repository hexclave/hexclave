import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "./force-layout";
import { buildPathsGraphPresentation } from "./graph-presentation";

function node(id: string): GraphNode {
  return { id, label: id, domain: "example.com", pageViews: 10, width: 100, x: 0, y: 0 };
}

function edge(from: string, to: string, count: number): GraphEdge {
  return { from, to, count, weight: count };
}

describe("paths graph presentation", () => {
  it("reduces a dense long-tail graph to a deterministic traffic backbone", () => {
    const nodes = Array.from({ length: 14 }, (_, index) => node(`/page-${index}`));
    const edges = [
      edge("/page-0", "/page-1", 500),
      edge("/page-1", "/page-2", 300),
      edge("/page-2", "/page-3", 120),
      edge("/page-3", "/page-4", 60),
      edge("/page-4", "/page-5", 20),
      edge("/page-5", "/page-6", 10),
      edge("/page-6", "/page-7", 5),
      edge("/page-7", "/page-8", 4),
      edge("/page-8", "/page-9", 3),
      edge("/page-9", "/page-10", 2),
      edge("/page-10", "/page-11", 1),
      edge("/page-11", "/page-12", 1),
      edge("/page-12", "/page-13", 1),
    ];

    const result = buildPathsGraphPresentation(nodes, edges, {
      maxBackboneEdges: 6,
      minBackboneEdges: 2,
      targetTransitionCoverage: 0.75,
    });

    expect(result.edges.map((candidate) => candidate.count)).toEqual([500, 300]);
    expect(result.nodes.map((candidate) => candidate.id)).toEqual(["/page-0", "/page-1", "/page-2"]);
    expect(result.visibleTransitionCount).toBe(800);
    expect(result.totalTransitionCount).toBe(1027);
    expect(result.totalNodeCount).toBe(14);
    expect(result.totalEdgeCount).toBe(13);
  });

  it("keeps secondary relationships between visible pages available on focus", () => {
    const nodes = [node("/a"), node("/b"), node("/c"), node("/hidden")];
    const result = buildPathsGraphPresentation(nodes, [
      edge("/a", "/b", 100),
      edge("/b", "/c", 80),
      edge("/c", "/a", 2),
      edge("/hidden", "/a", 1),
    ], {
      maxBackboneEdges: 2,
      minBackboneEdges: 2,
      targetTransitionCoverage: 1,
    });

    expect(result.edges).toHaveLength(2);
    expect(result.contextualEdges).toEqual([edge("/c", "/a", 2)]);
  });
});
