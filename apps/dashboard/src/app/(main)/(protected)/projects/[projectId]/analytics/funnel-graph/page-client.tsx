"use client";

import { AppEnabledGuard } from "../../app-enabled-guard";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";
import { Button, Typography } from "@/components/ui";
import { SpinnerGapIcon, ArrowClockwiseIcon } from "@phosphor-icons/react";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeUrlPath } from "./normalize-url";
import { computeLayout, type GraphNode, type GraphEdge } from "./force-layout";
import { FunnelGraphCanvas } from "./funnel-graph-canvas";

type TransitionRow = {
  from_path: string,
  to_path: string,
  cnt: string,
};

type FunnelData = {
  nodes: GraphNode[],
  edges: GraphEdge[],
  weakEdges: GraphEdge[],
};

const NAVIGATION_QUERY = `
SELECT
  prev_path as from_path,
  path as to_path,
  count() as cnt
FROM (
  SELECT
    user_id,
    JSONExtractString(toString(data), 'path') as path,
    lagInFrame(JSONExtractString(toString(data), 'path')) OVER (
      PARTITION BY user_id
      ORDER BY event_at ASC
    ) as prev_path
  FROM default.events
  WHERE event_type = '$page-view'
    AND JSONExtractString(toString(data), 'path') != ''
    AND user_id != ''
) sub
WHERE prev_path != '' AND prev_path != path
GROUP BY from_path, to_path
ORDER BY cnt DESC
LIMIT 500
`;

const PAGE_VIEWS_QUERY = `
SELECT
  JSONExtractString(toString(data), 'path') as path,
  any(domain(JSONExtractString(toString(data), 'url'))) as page_domain,
  count() as views
FROM default.events
WHERE event_type = '$page-view'
  AND JSONExtractString(toString(data), 'path') != ''
GROUP BY path
ORDER BY views DESC
LIMIT 200
`;

const MIN_CARD_WIDTH = 100;
const MAX_CARD_WIDTH = 220;

function computeCardWidth(label: string): number {
  // ~6.5px per character in 11px monospace font, plus padding (20px)
  const textWidth = label.length * 6.5 + 20;
  return Math.max(MIN_CARD_WIDTH, Math.min(MAX_CARD_WIDTH, textWidth));
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await adminApp.queryAnalytics({
        query: NAVIGATION_QUERY,
        include_all_branches: false,
        timeout_ms: 30000,
      });

      const rows = response.result.map((r) => {
        const from_path = r.from_path;
        const to_path = r.to_path;
        const cnt = r.cnt;
        if (typeof from_path !== "string" || typeof to_path !== "string") {
          throw new Error("Unexpected navigation query result shape: from_path/to_path must be strings");
        }
        if (typeof cnt !== "string" && typeof cnt !== "number") {
          throw new Error("Unexpected navigation query result shape: cnt must be string or number");
        }
        return { from_path, to_path, cnt: String(cnt) } satisfies TransitionRow;
      });

      // Normalize paths and aggregate
      const edgeMap = new Map<string, number>();
      const nodeSet = new Set<string>();

      for (const row of rows) {
        const fromNorm = normalizeUrlPath(row.from_path);
        const toNorm = normalizeUrlPath(row.to_path);
        if (fromNorm === toNorm) continue;

        const key = `${fromNorm}\0${toNorm}`;
        const count = Number(row.cnt);
        if (!Number.isFinite(count)) {
          throw new Error(`Invalid count value: ${row.cnt}`);
        }
        edgeMap.set(key, (edgeMap.get(key) ?? 0) + count);
        nodeSet.add(fromNorm);
        nodeSet.add(toNorm);
      }

      // Query page views and domain info
      const pvResponse = await adminApp.queryAnalytics({
        query: PAGE_VIEWS_QUERY,
        include_all_branches: false,
        timeout_ms: 30000,
      });

      const pageViewsMap = new Map<string, { views: number, domain: string }>();
      for (const row of pvResponse.result) {
        const path = row.path;
        const domain = row.page_domain;
        const views = row.views;
        if (typeof path !== "string") continue;
        const normPath = normalizeUrlPath(path);
        const existing = pageViewsMap.get(normPath);
        const viewCount = Number(views) || 0;
        if (existing == null) {
          pageViewsMap.set(normPath, { views: viewCount, domain: typeof domain === "string" ? domain : "" });
        } else {
          existing.views += viewCount;
          if (existing.domain === "" && typeof domain === "string") {
            existing.domain = domain;
          }
        }
      }

      // Build nodes
      const nodeArray: GraphNode[] = Array.from(nodeSet).map((path) => {
        const pvInfo = pageViewsMap.get(path);
        return {
          id: path,
          label: path,
          domain: pvInfo?.domain ?? "",
          pageViews: pvInfo?.views ?? 0,
          width: computeCardWidth(path),
          x: 0,
          y: 0,
        };
      });

      // Build edges
      const allEdges: { from: string, to: string, count: number, weight: number }[] = [];
      for (const [key, count] of edgeMap) {
        const [from, to] = key.split("\0") as [string, string];
        allEdges.push({
          from,
          to,
          count,
          weight: count,
        });
      }

      // For each source node, find the max outgoing edge count
      const maxOutgoing = new Map<string, number>();
      for (const e of allEdges) {
        const current = maxOutgoing.get(e.from) ?? 0;
        if (e.count > current) {
          maxOutgoing.set(e.from, e.count);
        }
      }

      // Filter: keep only edges with >= 10% of the strongest edge from the same source
      const edges: GraphEdge[] = [];
      const weakEdges: GraphEdge[] = [];
      for (const e of allEdges) {
        const maxFromSource = maxOutgoing.get(e.from) ?? 1;
        if (e.count >= maxFromSource * 0.1) {
          edges.push(e);
        } else {
          weakEdges.push(e);
        }
      }

      // Only include nodes that have at least one visible edge
      const visibleNodes = new Set<string>();
      for (const e of edges) {
        visibleNodes.add(e.from);
        visibleNodes.add(e.to);
      }
      const filteredNodeArray = nodeArray.filter((n) => visibleNodes.has(n.id));

      // Compute ForceAtlas2 layout with landing page distance for x-position
      // Only strong edges are used for force calculations
      const laidOutNodes = computeLayout(filteredNodeArray, edges);

      setData({ nodes: laidOutNodes, edges, weakEdges });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [adminApp]);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    runAsynchronouslyWithAlert(loadData);
  }, [loadData]);

  return (
    <AppEnabledGuard appId="analytics">
      <PageLayout
        title="Navigation Funnel"
        description="Visualize user navigation flows between pages."
        fillWidth
        containedHeight
        actions={
          <Button
            className="gap-1.5"
            variant="secondary"
            disabled={loading}
            onClick={() => runAsynchronouslyWithAlert(loadData)}
          >
            <ArrowClockwiseIcon className="h-4 w-4" />
            Refresh
          </Button>
        }
      >
        <div className="flex-1 min-h-0 rounded-2xl border border-black/[0.06] bg-white/90 shadow-[0_2px_12px_rgba(0,0,0,0.04)] backdrop-blur-xl dark:border-white/[0.06] dark:bg-zinc-900/90 overflow-hidden">
          {loading && (
            <div className="flex items-center justify-center h-full">
              <SpinnerGapIcon className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {error != null && !loading && (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <Typography variant="secondary" className="text-sm">{error}</Typography>
              <Button variant="secondary" onClick={() => runAsynchronouslyWithAlert(loadData)}>
                Retry
              </Button>
            </div>
          )}
          {data != null && !loading && error == null && (
            <FunnelGraphCanvas nodes={data.nodes} edges={data.edges} weakEdges={data.weakEdges} />
          )}
        </div>
      </PageLayout>
    </AppEnabledGuard>
  );
}
