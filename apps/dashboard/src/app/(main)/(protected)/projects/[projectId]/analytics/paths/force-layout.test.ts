import { describe, expect, it } from "vitest";
import { computeLayout, type GraphEdge, type GraphNode } from "./force-layout";

function node(id: string, width = 120): GraphNode {
  return { id, label: id, domain: "example.com", pageViews: 10, width, x: 0, y: 0 };
}

function edge(from: string, to: string, count = 10): GraphEdge {
  return { from, to, count, weight: count };
}

function positions(nodes: GraphNode[]): Map<string, { x: number, y: number }> {
  return new Map(nodes.map((candidate) => [candidate.id, { x: candidate.x, y: candidate.y }]));
}

function overlaps(left: GraphNode, right: GraphNode): boolean {
  return Math.abs(left.x - right.x) < (left.width + right.width) / 2
    && Math.abs(left.y - right.y) < 54;
}

describe("paths layered layout", () => {
  it("is invariant to node and edge input order", () => {
    const nodes = [node("/c"), node("/a"), node("/d"), node("/b")];
    const edges = [edge("/a", "/c", 20), edge("/b", "/c", 10), edge("/c", "/d", 15)];

    expect(positions(computeLayout(nodes, edges))).toEqual(
      positions(computeLayout([...nodes].reverse(), [...edges].reverse())),
    );
  });

  it("lays a chain out from left to right", () => {
    const result = positions(computeLayout(
      [node("/start"), node("/middle"), node("/finish")],
      [edge("/start", "/middle"), edge("/middle", "/finish")],
    ));

    expect(result.get("/start")?.x).toBeLessThan(result.get("/middle")?.x ?? 0);
    expect(result.get("/middle")?.x).toBeLessThan(result.get("/finish")?.x ?? 0);
  });

  it("compacts long paths into a readable number of columns", () => {
    const chainNodes = Array.from({ length: 16 }, (_, index) => node(`/step-${index}`));
    const chainEdges = chainNodes.slice(1).map((candidate, index) => edge(chainNodes[index].id, candidate.id));
    const result = computeLayout(chainNodes, chainEdges);
    const resultById = positions(result);

    expect(new Set(result.map((candidate) => candidate.x)).size).toBeLessThanOrEqual(4);
    for (let index = 1; index < chainNodes.length; index++) {
      expect(resultById.get(chainNodes[index].id)?.x).toBeGreaterThanOrEqual(
        resultById.get(chainNodes[index - 1].id)?.x ?? Number.POSITIVE_INFINITY,
      );
    }
  });

  it("does not overlap cards in a cyclic branching graph", () => {
    const result = computeLayout(
      [node("/a", 180), node("/b"), node("/c", 200), node("/d"), node("/e")],
      [
        edge("/a", "/b", 50),
        edge("/a", "/c", 40),
        edge("/b", "/d", 30),
        edge("/c", "/d", 20),
        edge("/d", "/a", 5),
        edge("/d", "/e", 10),
      ],
    );

    for (let leftIndex = 0; leftIndex < result.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < result.length; rightIndex++) {
        expect(overlaps(result[leftIndex], result[rightIndex])).toBe(false);
      }
    }
  });

  it("places a crossing-free two-layer graph without crossings", () => {
    const result = positions(computeLayout(
      [node("/left-a"), node("/left-b"), node("/right-a"), node("/right-b")],
      [edge("/left-a", "/right-b"), edge("/left-b", "/right-a")],
    ));
    const leftA = result.get("/left-a")?.y;
    const leftB = result.get("/left-b")?.y;
    const rightA = result.get("/right-a")?.y;
    const rightB = result.get("/right-b")?.y;
    if (leftA == null || leftB == null || rightA == null || rightB == null) {
      throw new Error("Every fixture node must have a layout position");
    }

    expect(Math.sign(leftA - leftB)).toBe(Math.sign(rightB - rightA));
  });
});
