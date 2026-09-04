import { DEFAULT_FORMAT_KIND } from "./format";
import type {
  AnalyticsChartAnnotationsLayer,
  AnalyticsChartDataLayer,
  AnalyticsChartLayer,
  AnalyticsChartLayers,
  AnalyticsChartLayerType,
  AnalyticsChartSeries,
  AnalyticsChartState,
  AnalyticsChartStrokeStyle,
  AnalyticsChartTimeseriesState,
} from "./types";

export const STROKE_DASHARRAY: Record<AnalyticsChartStrokeStyle, string | undefined> = {
  solid: undefined,
  dashed: "5 4",
  dotted: "1 4",
};

export const EMPTY_SERIES: readonly AnalyticsChartSeries[] = [];
export const EMPTY_MATRIX: readonly (readonly number[])[] = [];

/** Generic non-segmented defaults; demos swap in segment data. */
export const ANALYTICS_CHART_DEFAULT_LAYERS: AnalyticsChartLayers = [
  {
    id: "primary",
    kind: "primary",
    label: "Current",
    visible: true,
    color: "#2563eb",
    segmented: false,
    type: "area",
    strokeStyle: "solid",
    fillOpacity: 0.22,
    inProgressFromIndex: null,
  },
  {
    id: "compare",
    kind: "compare",
    label: "Previous period",
    visible: true,
    color: "#f59e0b",
    segmented: false,
    type: "line",
    strokeStyle: "dashed",
    inProgressFromIndex: null,
  },
  { id: "annotations", kind: "annotations", label: "Annotations", visible: true, color: "#f59e0b" },
];

/**
 * Default state for `AnalyticsChart`. ALWAYS spread from this when
 * initializing state; never build the state object by hand. Ships with
 * three pre-configured layers (primary, compare, annotations) — map over
 * `layers` to override individual ones.
 *
 * ```tsx
 * const [state, setState] = React.useState({
 *   ...ANALYTICS_CHART_DEFAULT_STATE,
 *   layers: ANALYTICS_CHART_DEFAULT_STATE.layers.map(l =>
 *     l.kind === "compare" ? { ...l, visible: false } : l
 *   ),
 * });
 * ```
 *
 * See the JSDoc on `AnalyticsChart` for the full contract, examples, and
 * the segment data format.
 */
export const ANALYTICS_CHART_DEFAULT_STATE: AnalyticsChartState = {
  view: "timeseries",
  layers: ANALYTICS_CHART_DEFAULT_LAYERS,
  xFormatKind: DEFAULT_FORMAT_KIND.datetime,
  yFormatKind: DEFAULT_FORMAT_KIND.short,
  showGrid: true,
  showXAxis: true,
  showYAxis: true,
  zoomRange: null,
  pinnedIndex: null,
};

export function findPrimaryLayer(layers: AnalyticsChartLayers): AnalyticsChartDataLayer | undefined {
  const l = layers.find((x) => x.kind === "primary");
  return l as AnalyticsChartDataLayer | undefined;
}
export function findCompareLayer(layers: AnalyticsChartLayers): AnalyticsChartDataLayer | undefined {
  const l = layers.find((x) => x.kind === "compare");
  return l as AnalyticsChartDataLayer | undefined;
}
export function findAnnotationsLayer(layers: AnalyticsChartLayers): AnalyticsChartAnnotationsLayer | undefined {
  const l = layers.find((x) => x.kind === "annotations");
  return l as AnalyticsChartAnnotationsLayer | undefined;
}

export function findLayerById(
  layers: AnalyticsChartLayers,
  id: string,
): AnalyticsChartLayer | undefined {
  return layers.find((l) => l.id === id);
}

export function isAnalyticsChartDataLayer(l: AnalyticsChartLayer): l is AnalyticsChartDataLayer {
  return l.kind === "primary" || l.kind === "compare";
}

export function isTimeseriesState(
  state: AnalyticsChartState,
): state is AnalyticsChartTimeseriesState {
  return state.view === "timeseries";
}

/** Replace a single layer (looked up by id) with a new layer object. */
export function setLayerById(
  layers: AnalyticsChartLayers,
  id: string,
  next: AnalyticsChartLayer,
): AnalyticsChartLayers {
  return layers.map((l) => (l.id === id ? next : l));
}

/** Shallow-patch fields on a layer by id. The patch type is deliberately
 * loose — callers are trusted to supply only fields the layer's
 * `kind`/`type` actually owns. */
export function patchLayerById(
  layers: AnalyticsChartLayers,
  id: string,
  patch: Partial<AnalyticsChartLayer>,
): AnalyticsChartLayers {
  return layers.map((l) => (l.id === id ? ({ ...l, ...patch } as AnalyticsChartLayer) : l));
}

export type ResolvedDataLayerStyle = {
  color: string,
  type: AnalyticsChartLayerType,
  strokeStyle: AnalyticsChartStrokeStyle,
  fillOpacity: number,
};

export function resolveDataLayerStyle(
  layer: AnalyticsChartDataLayer,
): ResolvedDataLayerStyle {
  return {
    color: layer.color,
    type: layer.type,
    // Bars have no stroke pattern — default to solid for the underline.
    strokeStyle: layer.type === "bar" ? "solid" : layer.strokeStyle,
    // Lines have no fill — default to 0 so gradient overlays sit flat.
    fillOpacity: layer.type === "line" ? 0 : layer.fillOpacity,
  };
}

/** Translate a layer's absolute `inProgressFromIndex` into a local index
 * inside the visible window. Returns `null` when the marker sits beyond
 * the visible window, `0` when it sits before the window (whole window
 * is dashed), or the clamped local index otherwise. */
export function computeLocalInProgressIdx(
  absIdx: number | null | undefined,
  visibleStart: number,
  visibleEnd: number,
): number | null {
  if (absIdx == null) return null;
  const local = absIdx - visibleStart;
  if (local >= visibleEnd - visibleStart + 1) return null; // beyond window
  if (local < 0) return 0; // before window — whole window is dashed
  return local;
}
