import { stringCompare } from "@hexclave/shared/dist/utils/strings";

export type GraphNode = {
  id: string,
  label: string,
  domain: string,
  pageViews: number,
  width: number,
  x: number,
  y: number,
};

export type GraphEdge = {
  from: string,
  to: string,
  count: number,
  weight: number,
};

type LayoutEdge = {
  from: string,
  to: string,
  weight: number,
};

const CARD_HEIGHT = 54;
const COLUMN_GAP = 150;
const ROW_GAP = 34;
const SWEEP_COUNT = 6;
const FORCE_ITERATIONS = 80;
const FORCE_DAMPING = 0.72;
const EDGE_SPRING_STRENGTH = 0.045;
const NODE_REPULSION_STRENGTH = 1800;
const CENTERING_STRENGTH = 0.012;

function relaxVerticalPositions(
  layers: readonly string[][],
  edges: readonly LayoutEdge[],
): Map<string, number> {
  const minimumGap = CARD_HEIGHT + ROW_GAP;
  const positions = new Map<string, number>();
  const velocities = new Map<string, number>();

  for (const layer of layers) {
    const layerHeight = layer.length * CARD_HEIGHT + Math.max(0, layer.length - 1) * ROW_GAP;
    layer.forEach((id, index) => {
      positions.set(id, -layerHeight / 2 + CARD_HEIGHT / 2 + index * minimumGap);
      velocities.set(id, 0);
    });
  }

  const maxWeight = Math.max(...edges.map((edge) => edge.weight), 1);
  const layerById = new Map(layers.flatMap((layer, rank) => layer.map((id) => [id, rank] as const)));

  for (let iteration = 0; iteration < FORCE_ITERATIONS; iteration++) {
    const forces = new Map<string, number>([...positions.keys()].map((id) => [id, 0]));

    for (const edge of edges) {
      const fromRank = layerById.get(edge.from);
      const toRank = layerById.get(edge.to);
      const fromY = positions.get(edge.from);
      const toY = positions.get(edge.to);
      if (fromRank == null || toRank == null || fromY == null || toY == null || fromRank === toRank) continue;
      const force = (toY - fromY) * EDGE_SPRING_STRENGTH * Math.min(edge.weight / maxWeight, 1);
      forces.set(edge.from, (forces.get(edge.from) ?? 0) + force);
      forces.set(edge.to, (forces.get(edge.to) ?? 0) - force);
    }

    for (const layer of layers) {
      for (let leftIndex = 0; leftIndex < layer.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < layer.length; rightIndex++) {
          const leftId = layer[leftIndex];
          const rightId = layer[rightIndex];
          const leftY = positions.get(leftId);
          const rightY = positions.get(rightId);
          if (leftY == null || rightY == null) continue;
          const distance = Math.max(Math.abs(rightY - leftY), 1);
          const direction = rightY >= leftY ? 1 : -1;
          const force = NODE_REPULSION_STRENGTH / (distance * distance) * direction;
          forces.set(leftId, (forces.get(leftId) ?? 0) - force);
          forces.set(rightId, (forces.get(rightId) ?? 0) + force);
        }
      }
    }

    for (const layer of layers) {
      for (const id of layer) {
        const position = positions.get(id);
        if (position == null) continue;
        const velocity = (velocities.get(id) ?? 0) * FORCE_DAMPING
          + (forces.get(id) ?? 0)
          - position * CENTERING_STRENGTH;
        velocities.set(id, velocity);
        positions.set(id, position + velocity);
      }

      for (let index = 1; index < layer.length; index++) {
        const previousId = layer[index - 1];
        const currentId = layer[index];
        const previousY = positions.get(previousId);
        const currentY = positions.get(currentId);
        if (previousY == null || currentY == null || currentY - previousY >= minimumGap) continue;
        const correction = (minimumGap - (currentY - previousY)) / 2;
        positions.set(previousId, previousY - correction);
        positions.set(currentId, currentY + correction);
      }
    }
  }

  return positions;
}

function canonicalEdges(edges: readonly GraphEdge[], nodeIds: ReadonlySet<string>): GraphEdge[] {
  return edges
    .filter((edge) => edge.from !== edge.to && nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .toSorted((left, right) => (
      stringCompare(left.from, right.from)
      || stringCompare(left.to, right.to)
      || right.weight - left.weight
      || right.count - left.count
    ));
}

function trafficOrder(nodeIds: readonly string[], edges: readonly GraphEdge[]): string[] {
  const remaining = new Set(nodeIds);
  const left: string[] = [];
  const right: string[] = [];

  while (remaining.size > 0) {
    const scores = new Map<string, { incoming: number, outgoing: number }>();
    for (const id of remaining) scores.set(id, { incoming: 0, outgoing: 0 });
    for (const edge of edges) {
      const from = scores.get(edge.from);
      const to = scores.get(edge.to);
      if (from != null && to != null) {
        from.outgoing += edge.weight;
        to.incoming += edge.weight;
      }
    }

    const sinks = [...remaining].filter((id) => scores.get(id)?.outgoing === 0).sort(stringCompare);
    if (sinks.length > 0) {
      const sink = sinks[0];
      right.unshift(sink);
      remaining.delete(sink);
      continue;
    }

    const sources = [...remaining].filter((id) => scores.get(id)?.incoming === 0).sort(stringCompare);
    if (sources.length > 0) {
      const source = sources[0];
      left.push(source);
      remaining.delete(source);
      continue;
    }

    const candidate = [...remaining].sort((leftId, rightId) => {
      const leftScore = scores.get(leftId);
      const rightScore = scores.get(rightId);
      const leftDifference = (leftScore?.outgoing ?? 0) - (leftScore?.incoming ?? 0);
      const rightDifference = (rightScore?.outgoing ?? 0) - (rightScore?.incoming ?? 0);
      return rightDifference - leftDifference || stringCompare(leftId, rightId);
    })[0];
    left.push(candidate);
    remaining.delete(candidate);
  }

  return [...left, ...right];
}

function orientForLayout(edges: readonly GraphEdge[], order: readonly string[]): LayoutEdge[] {
  const index = new Map(order.map((id, position) => [id, position]));
  return edges.map((edge) => {
    const fromIndex = index.get(edge.from);
    const toIndex = index.get(edge.to);
    if (fromIndex == null || toIndex == null) {
      throw new Error("Canonical graph order must contain every edge endpoint");
    }
    return fromIndex < toIndex
      ? { from: edge.from, to: edge.to, weight: edge.weight }
      : { from: edge.to, to: edge.from, weight: edge.weight };
  });
}

function assignRanks(order: readonly string[], edges: readonly LayoutEdge[]): Map<string, number> {
  const incoming = new Map<string, LayoutEdge[]>();
  for (const id of order) incoming.set(id, []);
  for (const edge of edges) incoming.get(edge.to)?.push(edge);

  const ranks = new Map<string, number>();
  for (const id of order) {
    const rank = (incoming.get(id) ?? []).reduce(
      (maximum, edge) => Math.max(maximum, (ranks.get(edge.from) ?? 0) + 1),
      0,
    );
    ranks.set(id, rank);
  }
  return ranks;
}

function compactRanks(ranks: ReadonlyMap<string, number>, nodeCount: number): Map<string, number> {
  const maxRank = Math.max(...ranks.values());
  const layerCount = Math.min(maxRank + 1, Math.max(Math.min(nodeCount, 3), Math.ceil(Math.sqrt(nodeCount))));
  if (maxRank === 0 || layerCount === maxRank + 1) return new Map(ranks);
  return new Map([...ranks].map(([id, rank]) => [id, Math.round(rank / maxRank * (layerCount - 1))]));
}

function weightedMedian(neighbors: readonly { position: number, weight: number }[]): number {
  if (neighbors.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = neighbors.toSorted((left, right) => left.position - right.position);
  const totalWeight = sorted.reduce((sum, neighbor) => sum + neighbor.weight, 0);
  let seenWeight = 0;
  for (const neighbor of sorted) {
    seenWeight += neighbor.weight;
    if (seenWeight * 2 >= totalWeight) return neighbor.position;
  }
  return sorted[sorted.length - 1].position;
}

function reorderLayer(
  layer: readonly string[],
  rank: number,
  layers: readonly string[][],
  ranks: ReadonlyMap<string, number>,
  edges: readonly LayoutEdge[],
  downward: boolean,
): string[] {
  const positions = new Map(layers.flatMap((candidateLayer) => candidateLayer.map((id, position) => [
    id,
    (position + 0.5) / candidateLayer.length,
  ] as const)));
  const neighbors = (id: string) => edges.flatMap((edge) => {
    const neighbor = edge.to === id ? edge.from : edge.from === id ? edge.to : null;
    const neighborRank = neighbor == null ? null : ranks.get(neighbor);
    if (
      neighbor == null
      || neighborRank == null
      || (downward ? neighborRank >= rank : neighborRank <= rank)
    ) return [];
    const position = positions.get(neighbor);
    return position == null ? [] : [{ position, weight: edge.weight }];
  });
  return [...layer].sort((left, right) => {
    return weightedMedian(neighbors(left)) - weightedMedian(neighbors(right)) || stringCompare(left, right);
  });
}

function crossingScore(
  layers: readonly string[][],
  edges: readonly LayoutEdge[],
  affectedNodeIds?: ReadonlySet<string>,
): number {
  const positions = new Map(layers.flatMap((layer, rank) => layer.map((id, position) => [
    id,
    { x: rank, y: position },
  ] as const)));
  const segments = edges.flatMap((edge) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from == null || to == null || from.x === to.x) return [];
    return [{ edge, from, to }];
  });
  const direction = (
    from: { x: number, y: number },
    to: { x: number, y: number },
    point: { x: number, y: number },
  ) => (to.x - from.x) * (point.y - from.y) - (to.y - from.y) * (point.x - from.x);
  const affectedSegmentIndexes = affectedNodeIds == null
    ? null
    : new Set(segments.flatMap((segment, index) => (
      affectedNodeIds.has(segment.edge.from) || affectedNodeIds.has(segment.edge.to) ? [index] : []
    )));
  let crossings = 0;
  for (let first = 0; first < segments.length; first++) {
    if (affectedSegmentIndexes != null && !affectedSegmentIndexes.has(first)) continue;
    const secondStart = affectedSegmentIndexes == null ? first + 1 : 0;
    for (let second = secondStart; second < segments.length; second++) {
      if (
        first === second
        || (
          affectedSegmentIndexes != null
          && affectedSegmentIndexes.has(second)
          && second < first
        )
      ) continue;
      const left = segments[first];
      const right = segments[second];
      if (
        left.edge.from === right.edge.from
        || left.edge.from === right.edge.to
        || left.edge.to === right.edge.from
        || left.edge.to === right.edge.to
      ) continue;
      const leftSide = direction(left.from, left.to, right.from) * direction(left.from, left.to, right.to);
      const rightSide = direction(right.from, right.to, left.from) * direction(right.from, right.to, left.to);
      if (leftSide < 0 && rightSide < 0) crossings += left.edge.weight * right.edge.weight;
    }
  }
  return crossings;
}

function improveAdjacentCrossings(layers: string[][], edges: readonly LayoutEdge[]): void {
  for (let rank = 0; rank < layers.length; rank++) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let position = 0; position < layers[rank].length - 1; position++) {
        const affectedNodeIds = new Set([layers[rank][position], layers[rank][position + 1]]);
        const before = crossingScore(layers, edges, affectedNodeIds);
        const swapped = [...layers[rank]];
        [swapped[position], swapped[position + 1]] = [swapped[position + 1], swapped[position]];
        const candidateLayers = layers.map((layer, candidateRank) => candidateRank === rank ? swapped : layer);
        const after = crossingScore(candidateLayers, edges, affectedNodeIds);
        if (after < before) {
          layers[rank] = swapped;
          improved = true;
        }
      }
    }
  }
}

export function computeLayout(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  if (nodes.length === 0) return [];
  const canonicalNodes = [...nodes].sort((left, right) => stringCompare(left.id, right.id));
  const nodeById = new Map(canonicalNodes.map((node) => [node.id, node]));
  const canonical = canonicalEdges(edges, new Set(nodeById.keys()));
  const order = trafficOrder(canonicalNodes.map((node) => node.id), canonical);
  const layoutEdges = orientForLayout(canonical, order);
  const ranks = compactRanks(assignRanks(order, layoutEdges), canonicalNodes.length);
  const maxRank = Math.max(...ranks.values());
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const id of order) layers[ranks.get(id) ?? 0].push(id);

  for (let sweep = 0; sweep < SWEEP_COUNT; sweep++) {
    const downward = sweep % 2 === 0;
    if (downward) {
      for (let rank = 1; rank < layers.length; rank++) {
        layers[rank] = reorderLayer(layers[rank], rank, layers, ranks, layoutEdges, true);
      }
    } else {
      for (let rank = layers.length - 2; rank >= 0; rank--) {
        layers[rank] = reorderLayer(layers[rank], rank, layers, ranks, layoutEdges, false);
      }
    }
  }
  improveAdjacentCrossings(layers, layoutEdges);
  const verticalPositions = relaxVerticalPositions(layers, layoutEdges);

  const columnWidths = layers.map((layer) => Math.max(...layer.map((id) => nodeById.get(id)?.width ?? 0), 0));
  const columnCenters: number[] = [];
  for (let rank = 0; rank < layers.length; rank++) {
    const previousCenter = columnCenters[rank - 1];
    columnCenters.push(rank === 0
      ? columnWidths[rank] / 2
      : previousCenter + columnWidths[rank - 1] / 2 + COLUMN_GAP + columnWidths[rank] / 2);
  }

  const positions = new Map<string, { x: number, y: number }>();
  for (let rank = 0; rank < layers.length; rank++) {
    const layerHeight = layers[rank].length * CARD_HEIGHT + Math.max(0, layers[rank].length - 1) * ROW_GAP;
    for (let position = 0; position < layers[rank].length; position++) {
      positions.set(layers[rank][position], {
        x: columnCenters[rank],
        y: verticalPositions.get(layers[rank][position])
          ?? (-layerHeight / 2 + CARD_HEIGHT / 2 + position * (CARD_HEIGHT + ROW_GAP)),
      });
    }
  }

  return canonicalNodes.map((node) => {
    const position = positions.get(node.id);
    if (position == null) throw new Error(`Layout position missing for node ${node.id}`);
    return { ...node, ...position };
  });
}
