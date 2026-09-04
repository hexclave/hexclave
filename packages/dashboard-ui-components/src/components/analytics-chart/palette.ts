import type {
  AnalyticsChartPalette,
  AnalyticsChartSegmentRamp,
  AnalyticsChartSeries,
} from "./types";

type AnalyticsChartSegmentThemeMap = Record<string, { light: string, dark: string }>;

export const ANALYTICS_CHART_DEFAULT_PALETTE: AnalyticsChartPalette = {
  primary: {
    kind: "procedural",
    hue: 220,
    sat: 78,
    shadeRangeLight: [28, 62],
    shadeRangeDark: [52, 82],
  },
  compare: {
    kind: "procedural",
    hue: 38,
    sat: 92,
    shadeRangeLight: [28, 62],
    shadeRangeDark: [52, 82],
  },
};

export function resolveAnalyticsChartPalette(
  override: Partial<AnalyticsChartPalette> | undefined,
): AnalyticsChartPalette {
  if (!override) return ANALYTICS_CHART_DEFAULT_PALETTE;
  return {
    primary: override.primary ?? ANALYTICS_CHART_DEFAULT_PALETTE.primary,
    compare: override.compare ?? ANALYTICS_CHART_DEFAULT_PALETTE.compare,
  };
}

/** Expand a ramp into N colors for a given theme. */
export function buildRampColors(
  ramp: AnalyticsChartSegmentRamp,
  count: number,
  theme: "light" | "dark",
): string[] {
  if (ramp.kind === "explicit") {
    const list = theme === "light" ? ramp.light : ramp.dark;
    if (list.length === 0) return Array.from({ length: count }, () => "#888");
    return Array.from(
      { length: count },
      (_, i) => list[i < list.length ? i : list.length - 1]!,
    );
  }
  const range = theme === "light" ? ramp.shadeRangeLight : ramp.shadeRangeDark;
  return Array.from({ length: count }, (_, i) => {
    const t = count <= 1 ? 0.5 : i / (count - 1);
    const l = range[0] + t * (range[1] - range[0]);
    return `hsl(${ramp.hue} ${ramp.sat}% ${l.toFixed(1)}%)`;
  });
}

/** Per-segment light/dark colors for `ChartConfig.theme` (SVG only; siblings use inline vars). */
export function buildSegmentThemeMap(
	series: readonly AnalyticsChartSeries[],
	ramp: AnalyticsChartSegmentRamp,
): AnalyticsChartSegmentThemeMap {
  const light = buildRampColors(ramp, series.length, "light");
  const dark = buildRampColors(ramp, series.length, "dark");
  const out: Record<string, { light: string, dark: string }> = {};
  series.forEach((s, i) => {
    out[s.key] = { light: light[i]!, dark: dark[i]! };
  });
  return out;
}
