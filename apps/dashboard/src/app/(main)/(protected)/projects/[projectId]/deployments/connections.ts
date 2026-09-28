// Connection env vars and the connection lines they imply.
//
// A connection env var stores `serviceId.outputKey` (with `type: "connection"`
// in the config). Data flows from the referenced service (the source of the
// output) into the service that owns the env var (the target), so a
// connection line is drawn source → target.

import { parseConnectionValue } from "@hexclave/shared/dist/deployments";
import { NODE_HEIGHT, NODE_WIDTH, type BoardService, type EnvVar } from "./board-model";

export type ParsedConnection = {
  serviceId: string,
  outputKey: string,
  /** The port named by an `internalUrl:<port>` reference, or null. */
  port: number | null,
  raw: string,
};

// Returns the target of a connection env var, or null for other env var types
// (or a malformed connection value). Uses the backend's exact regex so a value
// the deploy would reject (e.g. dots in the output key, stored via a raw
// config edit) never draws a connection line.
export function parseConnection(envVar: EnvVar): ParsedConnection | null {
  if (envVar.type !== "connection" || envVar.value == null) return null;
  // The SHARED parser, not a local split: a reference may carry a `:<port>`
  // suffix (`api.internalUrl:9090`), and splitting on the dot alone would put
  // "internalUrl:9090" in outputKey and fail every known-output lookup.
  const parsed = parseConnectionValue(envVar.value);
  if (parsed === null) return null;
  return { serviceId: parsed.serviceId, outputKey: parsed.outputKey, port: parsed.port, raw: envVar.value };
}

export type Connection = {
  id: string,
  fromId: string,
  toId: string,
  // Number of distinct env vars on the target that reference the source; drives
  // the little count pill on the connection line.
  count: number,
};

// Derive the set of connections from every connection env var on the board.
// Deduplicated per (source, target) pair; self-references are ignored.
// Keyed by service ID (not display name): the stored connection value is a
// server-side id reference, so this keeps working if nodes ever get
// user-facing display names.
export function deriveConnections(services: BoardService[]): Connection[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const counts = new Map<string, Connection>();

  for (const target of services) {
    for (const envVar of target.envVars) {
      const ref = parseConnection(envVar);
      if (ref == null) continue;
      const source = byId.get(ref.serviceId);
      if (!source || source.id === target.id) continue;
      const id = `${source.id}->${target.id}`;
      const existing = counts.get(id);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(id, { id, fromId: source.id, toId: target.id, count: 1 });
      }
    }
  }

  return [...counts.values()];
}

export type Point = { x: number, y: number };

export type EdgeAnchors = {
  start: Point,
  end: Point,
  // True when the target sits to the left of the source, so the edge leaves the
  // source from its left side and enters the target on its right.
  reversed: boolean,
};

// Anchor points on the node edges. Nodes have a fixed footprint (NODE_WIDTH x
// NODE_HEIGHT), so anchors are pure geometry — no DOM measurement needed, which
// keeps drag updates cheap and jitter-free.
export function getEdgeAnchors(from: BoardService, to: BoardService): EdgeAnchors {
  const fromCenterX = from.x + NODE_WIDTH / 2;
  const toCenterX = to.x + NODE_WIDTH / 2;
  const reversed = toCenterX < fromCenterX;
  const midY = NODE_HEIGHT / 2;
  const start: Point = { x: reversed ? from.x : from.x + NODE_WIDTH, y: from.y + midY };
  const end: Point = { x: reversed ? to.x + NODE_WIDTH : to.x, y: to.y + midY };
  return { start, end, reversed };
}

export type ConnectorStyle = "curved" | "orthogonal" | "straight";

// Build the SVG path `d` for an edge given the visual variant's connector style.
export function buildEdgePath(anchors: EdgeAnchors, style: ConnectorStyle): string {
  const { start, end, reversed } = anchors;
  switch (style) {
    case "straight": {
      return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
    }
    case "orthogonal": {
      // Stepped H → V → H routing with the vertical leg at the midpoint.
      const midX = (start.x + end.x) / 2;
      return `M ${start.x} ${start.y} L ${midX} ${start.y} L ${midX} ${end.y} L ${end.x} ${end.y}`;
    }
    case "curved":
    default: {
      // Horizontal-tangent cubic bezier, like Railway's service graph. The
      // control-point reach grows with horizontal distance and is nudged out
      // when the edge doubles back on itself.
      const dx = Math.abs(end.x - start.x);
      const reach = Math.max(48, dx * 0.5);
      const dir = reversed ? -1 : 1;
      const c1: Point = { x: start.x + reach * dir, y: start.y };
      const c2: Point = { x: end.x - reach * dir, y: end.y };
      return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;
    }
  }
}
