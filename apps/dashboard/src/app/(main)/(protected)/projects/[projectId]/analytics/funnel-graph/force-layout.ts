/**
 * Graph layout using ForceAtlas2-style simulation with:
 * 1. Landing page detection → average distance for soft x-position
 * 2. ForceAtlas2 forces with collision avoidance
 * 3. Spring strength proportional to log(clicks)
 * 4. Edge bundling for parallel edges
 */

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
  /** Weight (linear): raw transition count */
  weight: number,
};

// Layout constants
const CARD_HEIGHT = 60;
const ITERATIONS = 500;
const GRAVITY = 0.005;
const REPULSION_SCALE = 8000;
const X_CONSTRAINT_STRENGTH = 0.25;
const DAMPING = 0.85;
const MIN_DIST = 50;

/**
 * Detect landing pages: pages with high outbound relative to inbound,
 * or common root paths like "/", "/home", etc.
 */
function findLandingPages(nodes: GraphNode[], edges: GraphEdge[]): Set<string> {
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const n of nodes) {
    inbound.set(n.id, 0);
    outbound.set(n.id, 0);
  }
  for (const e of edges) {
    outbound.set(e.from, (outbound.get(e.from) ?? 0) + e.count);
    inbound.set(e.to, (inbound.get(e.to) ?? 0) + e.count);
  }

  const rootPatterns = ["/", "/index", "/home", "/landing"];
  const landings = new Set<string>();

  for (const n of nodes) {
    const out = outbound.get(n.id) ?? 0;
    const inn = inbound.get(n.id) ?? 0;
    if (rootPatterns.some((p) => n.id === p || (n.id.endsWith("/") && n.id.slice(0, -1) === p))) {
      landings.add(n.id);
      continue;
    }
    if (out > inn * 1.3 && out > 30) {
      landings.add(n.id);
    }
  }

  if (landings.size === 0) {
    const sorted = [...nodes].sort((a, b) => (outbound.get(b.id) ?? 0) - (outbound.get(a.id) ?? 0));
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
      landings.add(sorted[i]!.id);
    }
  }

  return landings;
}

/**
 * Compute average shortest-path distance from landing pages using BFS.
 */
function computeDistanceFromLandings(
  nodes: GraphNode[],
  edges: GraphEdge[],
  landings: Set<string>,
): Map<string, number> {
  const adj = new Map<string, { to: string }[]>();
  for (const n of nodes) {
    adj.set(n.id, []);
  }
  for (const e of edges) {
    adj.get(e.from)?.push({ to: e.to });
  }

  const distances = new Map<string, number[]>();
  for (const n of nodes) {
    distances.set(n.id, []);
  }

  for (const landing of landings) {
    const dist = new Map<string, number>();
    const queue: string[] = [landing];
    dist.set(landing, 0);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentDist = dist.get(current)!;
      const neighbors = adj.get(current) ?? [];
      for (const { to } of neighbors) {
        if (!dist.has(to)) {
          dist.set(to, currentDist + 1);
          queue.push(to);
        }
      }
    }

    for (const [nodeId, d] of dist) {
      distances.get(nodeId)?.push(d);
    }
  }

  const avgDist = new Map<string, number>();
  let maxDist = 0;
  for (const [nodeId, dists] of distances) {
    if (dists.length > 0) {
      const avg = dists.reduce((a, b) => a + b, 0) / dists.length;
      avgDist.set(nodeId, avg);
      maxDist = Math.max(maxDist, avg);
    } else {
      avgDist.set(nodeId, maxDist + 1);
    }
  }

  // Normalize unreachable nodes
  for (const [nodeId, d] of avgDist) {
    if (d > maxDist) {
      avgDist.set(nodeId, maxDist + 1);
    }
  }

  return avgDist;
}

type SimNode = {
  id: string,
  label: string,
  width: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  targetX: number,
};

/**
 * ForceAtlas2-style layout with:
 * - Soft x-constraint from landing page distance
 * - Repulsion inversely proportional to distance
 * - Spring attraction proportional to log(clicks)
 * - Collision avoidance based on card dimensions
 */
export function computeLayout(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  if (nodes.length === 0) return [];

  // Find landing pages and compute distances
  const landings = findLandingPages(nodes, edges);
  const distFromLanding = computeDistanceFromLandings(nodes, edges, landings);

  // Normalize distances to x-range
  const maxDist = Math.max(...distFromLanding.values(), 1);
  const xSpread = nodes.length * 50;

  // Initialize simulation nodes
  const simNodes: SimNode[] = nodes.map((n, i) => {
    const dist = distFromLanding.get(n.id) ?? 0;
    const targetX = (dist / maxDist) * xSpread;
    const ySpread = nodes.length * 60;
    return {
      id: n.id,
      label: n.label,
      width: n.width,
      x: targetX + (Math.random() - 0.5) * 80,
      y: (i / nodes.length - 0.5) * ySpread,
      vx: 0,
      vy: 0,
      targetX,
    };
  });

  const nodeIndex = new Map<string, number>();
  for (let i = 0; i < simNodes.length; i++) {
    nodeIndex.set(simNodes[i]!.id, i);
  }

  const maxWeight = edges.reduce((m, e) => Math.max(m, e.weight), 1);

  // Collision padding
  const collisionPadX = 30;
  const collisionPadY = 25;
  const collisionH = CARD_HEIGHT / 2 + collisionPadY;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const alpha = 1 - iter / ITERATIONS;
    const cool = 0.1 + 0.9 * alpha;

    // Repulsion between all pairs + collision avoidance
    for (let i = 0; i < simNodes.length; i++) {
      for (let j = i + 1; j < simNodes.length; j++) {
        const a = simNodes[i]!;
        const b = simNodes[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MIN_DIST) dist = MIN_DIST;

        // Repulsion
        const repForce = REPULSION_SCALE * cool / (dist * dist);
        const fx = (dx / dist) * repForce;
        const fy = (dy / dist) * repForce;

        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;

        // Collision avoidance: push apart if rectangular bounds overlap
        // Use per-node width for accurate collision detection
        const collisionW = (a.width + b.width) / 2 + collisionPadX;
        const overlapX = collisionW - Math.abs(dx);
        const overlapY = collisionH * 2 - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          const pushX = (overlapX / 2) * Math.sign(dx || 1) * 0.8;
          const pushY = (overlapY / 2) * Math.sign(dy || 1) * 0.8;
          a.x -= pushX;
          b.x += pushX;
          a.y -= pushY;
          b.y += pushY;
        }
      }
    }

    // Spring attraction along edges, strength ∝ log(clicks)
    // Reverse x-force when arrow points left to bias left-to-right flow
    for (const edge of edges) {
      const ai = nodeIndex.get(edge.from);
      const bi = nodeIndex.get(edge.to);
      if (ai == null || bi == null) continue;

      const a = simNodes[ai]!;
      const b = simNodes[bi]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1) continue;

      const strength = 0.008 * (edge.weight / maxWeight) * cool;
      const fy = dy * strength;
      // Reverse x-component when edge points left (to.x < from.x)
      // This makes backward edges repulsive on x, reinforcing left-to-right flow
      const fx = dx < 0 ? -(dx * strength) : dx * strength;

      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Horizontal alignment bias: strong edges pull nodes toward same y-level
    // Weak edges don't care about vertical alignment
    for (const edge of edges) {
      const ai = nodeIndex.get(edge.from);
      const bi = nodeIndex.get(edge.to);
      if (ai == null || bi == null) continue;

      const a = simNodes[ai]!;
      const b = simNodes[bi]!;
      const dy = b.y - a.y;

      // Strength proportional to normalized edge weight (squared for emphasis)
      const relWeight = edge.weight / maxWeight;
      const alignStrength = 0.012 * relWeight * relWeight * cool;
      const fy = dy * alignStrength;

      // Pull both nodes toward their shared y-midpoint
      a.vy += fy;
      b.vy -= fy;
    }

    // Soft x-constraint: pull toward target x based on distance from landings
    for (const node of simNodes) {
      const xDiff = node.targetX - node.x;
      node.vx += xDiff * X_CONSTRAINT_STRENGTH * cool;
    }

    // Gravity toward center (y-axis only)
    for (const node of simNodes) {
      node.vy -= node.y * GRAVITY * cool;
    }

    // Apply velocity with damping
    for (const node of simNodes) {
      node.vx *= DAMPING;
      node.vy *= DAMPING;
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  // Restore full node data with updated positions
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  return simNodes.map((n) => ({
    ...nodeById.get(n.id)!,
    x: n.x,
    y: n.y,
  }));
}
