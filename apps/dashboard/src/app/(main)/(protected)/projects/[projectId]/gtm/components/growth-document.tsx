"use client";

import { DesignAnalyticsCard, DesignAnalyticsCardHeader, DesignBadge } from "@/components/design-components";
import { Link } from "@/components/link";
import { cn } from "@/lib/utils";
import type { GrowthDocument, GrowthDocumentBlock, GrowthDocumentComponentName, GrowthDocumentInline, GrowthEvidenceDatum, GrowthEvidencePoint } from "@/lib/growth/growth-document";
import { formatGrowthAdSpend, formatGrowthMetricValue } from "@/lib/growth/growth-format";
import type { GrowthActionItem } from "@/lib/growth/growth-types";
import { urlString } from "@hexclave/shared/dist/utils/urls";
import { ArrowRightIcon, ChartLineUpIcon, DatabaseIcon, FlaskIcon, LightbulbIcon, LightningIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { createContext, useContext, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { GROWTH_ACTION_TYPE_META, GrowthActionStatusBadge, GrowthWatchedMetricChips, useGrowthHref } from "./action-card";
import { GrowthActionMutationControls } from "./action-controls";

const SERIES_COLORS = ["hsl(199 68% 47%)", "hsl(258 54% 58%)", "hsl(153 44% 43%)"] as const;

function formatEvidenceValue(value: number, datum: GrowthEvidenceDatum): string {
  if (datum.unit === "minor_units") return formatGrowthAdSpend(value, datum.currency ?? "");
  return formatGrowthMetricValue(value, datum.unit);
}

function InlineContent(props: { children: GrowthDocumentInline[] }): ReactNode {
  return props.children.map((node, index) => {
    const key = `${node.type}-${index}`;
    switch (node.type) {
      case "text": { return <span key={key}>{node.value}</span>; }
      case "strong": { return <strong key={key} className="font-semibold text-foreground"><InlineContent>{node.children}</InlineContent></strong>; }
      case "emphasis": { return <em key={key}><InlineContent>{node.children}</InlineContent></em>; }
      case "delete": { return <del key={key}><InlineContent>{node.children}</InlineContent></del>; }
      case "code": { return <code key={key} className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[0.85em] text-foreground">{node.value}</code>; }
      case "break": { return <br key={key} />; }
      case "link": { return <a key={key} href={node.url} target="_blank" rel="noreferrer" className="font-medium text-foreground underline decoration-foreground/30 underline-offset-4 transition-colors duration-150 hover:decoration-foreground hover:transition-none"><InlineContent>{node.children}</InlineContent></a>; }
    }
  });
}

function EvidenceTable(props: { datum: GrowthEvidenceDatum }) {
  const rows: GrowthEvidencePoint[] = props.datum.kind === "metric"
    ? [{ label: props.datum.title, value: props.datum.value }]
    : props.datum.kind === "time_series"
      ? props.datum.series.flatMap((series) => series.points.map((point) => ({ label: `${series.label}, ${point.label}`, value: point.value })))
      : props.datum.items;
  return (
    <table className="sr-only">
      <caption>{props.datum.title}. {props.datum.takeaway}</caption>
      <thead><tr><th>Label</th><th>Value</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.label}><td>{row.label}</td><td>{formatEvidenceValue(row.value, props.datum)}</td></tr>)}</tbody>
    </table>
  );
}

function EvidenceFooter(props: { datum: GrowthEvidenceDatum }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-foreground/[0.06] px-5 py-3 text-xs text-muted-foreground">
      <span>{props.datum.takeaway}</span>
      <span className="shrink-0">{props.datum.source}{props.datum.timezone == null ? "" : ` · ${props.datum.timezone}`}</span>
    </div>
  );
}

function MetricBlock(props: { datum: Extract<GrowthEvidenceDatum, { kind: "metric" }> }) {
  const delta = props.datum.comparisonValue == null ? null : props.datum.value - props.datum.comparisonValue;
  return (
    <DesignAnalyticsCard gradient="cyan" className="my-5 max-w-xl">
      <div className="p-5">
        <p className="text-sm font-medium text-muted-foreground">{props.datum.title}</p>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-3xl font-semibold tracking-tight tabular-nums">{formatEvidenceValue(props.datum.value, props.datum)}</span>
          {delta != null && <span className={cn("font-mono text-sm tabular-nums", delta > 0 ? "text-emerald-600 dark:text-emerald-400" : delta < 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground")}>{delta > 0 ? "+" : ""}{formatEvidenceValue(delta, props.datum)} {props.datum.comparisonLabel}</span>}
        </div>
      </div>
      <EvidenceFooter datum={props.datum} />
      <EvidenceTable datum={props.datum} />
    </DesignAnalyticsCard>
  );
}

type TrendRow = { label: string, values: Map<string, number> };

function TrendChartBlock(props: { datum: Extract<GrowthEvidenceDatum, { kind: "time_series" }> }) {
  const rowsByLabel = new Map<string, TrendRow>();
  for (const series of props.datum.series) {
    for (const point of series.points) {
      const row = rowsByLabel.get(point.label) ?? { label: point.label, values: new Map<string, number>() };
      row.values.set(series.label, point.value);
      rowsByLabel.set(point.label, row);
    }
  }
  const rows = [...rowsByLabel.values()];
  return (
    <DesignAnalyticsCard gradient="cyan" className="my-6" chart={{ type: "line", tooltipType: "default", highlightMode: "series-hover" }}>
      <DesignAnalyticsCardHeader label={props.datum.title} right={<ChartLineUpIcon className="size-4 text-muted-foreground" />} />
      <div className="h-64 px-3 pb-2 pt-5" role="img" aria-label={`${props.datum.title}. ${props.datum.takeaway}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 4, right: 14, left: -8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" opacity={0.35} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={24} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <YAxis tickLine={false} axisLine={false} width={48} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickFormatter={(value: number) => formatEvidenceValue(value, props.datum)} />
            <Tooltip formatter={(value: number) => formatEvidenceValue(value, props.datum)} contentStyle={{ borderRadius: 12, border: "1px solid hsl(var(--border))", background: "hsl(var(--background))" }} />
            {props.datum.series.length > 1 && <Legend />}
            {props.datum.series.map((series, index) => <Line key={series.label} name={series.label} dataKey={(row: TrendRow) => row.values.get(series.label)} type="monotone" stroke={SERIES_COLORS[index] ?? SERIES_COLORS[0]} strokeWidth={2} dot={false} activeDot={{ r: 3 }} connectNulls={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <EvidenceFooter datum={props.datum} />
      <EvidenceTable datum={props.datum} />
    </DesignAnalyticsCard>
  );
}

function BarChartBlock(props: { datum: Extract<GrowthEvidenceDatum, { kind: "comparison" | "breakdown" }> }) {
  return (
    <DesignAnalyticsCard gradient={props.datum.kind === "comparison" ? "purple" : "green"} className="my-6" chart={{ type: "bar", tooltipType: "default", highlightMode: "bar-segment" }}>
      <DesignAnalyticsCardHeader label={props.datum.title} />
      <div className="h-64 px-3 pb-2 pt-5" role="img" aria-label={`${props.datum.title}. ${props.datum.takeaway}`}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={props.datum.items} margin={{ top: 4, right: 14, left: -8, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" opacity={0.35} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval={0} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} />
            <YAxis tickLine={false} axisLine={false} width={48} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickFormatter={(value: number) => formatEvidenceValue(value, props.datum)} />
            <Tooltip formatter={(value: number) => formatEvidenceValue(value, props.datum)} contentStyle={{ borderRadius: 12, border: "1px solid hsl(var(--border))", background: "hsl(var(--background))" }} />
            <Bar dataKey="value" fill="hsl(199 68% 47%)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <EvidenceFooter datum={props.datum} />
      <EvidenceTable datum={props.datum} />
    </DesignAnalyticsCard>
  );
}

const CALLOUT_META = new Map<GrowthDocumentComponentName, { label: string, icon: typeof DatabaseIcon, className: string }>([
  ["Evidence", { label: "Evidence", icon: DatabaseIcon, className: "bg-cyan-500/[0.06] ring-cyan-500/15" }],
  ["Hypothesis", { label: "Hypothesis", icon: LightbulbIcon, className: "bg-purple-500/[0.06] ring-purple-500/15" }],
  ["Experiment", { label: "Experiment", icon: FlaskIcon, className: "bg-emerald-500/[0.06] ring-emerald-500/15" }],
  ["DataGap", { label: "Data gap", icon: WarningCircleIcon, className: "bg-orange-500/[0.06] ring-orange-500/15" }],
]);

/**
 * The actions an `<ActionButton>` in the surrounding document may resolve to.
 *
 * A document never carries an action's data, only its id, so whoever renders a document that can
 * contain `<ActionButton>` has to say which actions the reader is allowed to see — and how to reload
 * them once one is activated or dismissed. Documents rendered without this provider (findings,
 * reports, action narratives) simply have no action buttons in them.
 */
const GrowthDocumentActionsContext = createContext<{
  actions: GrowthActionItem[],
  onChanged: () => Promise<void>,
  demo: boolean,
  /**
   * The project whose workspace the reader is in, or null when the document is rendered outside it.
   *
   * Both the activate/dismiss endpoints and an action's own page are addressed by the project in the
   * URL, and the internal admin page previews a *customer's* page from the internal project's URL —
   * so there the only correct thing to do is show the card without controls that would act on the
   * wrong project.
   */
  projectId: string | null,
} | null>(null);

/**
 * `demo` and `projectId` travel with the actions rather than being read from the growth status
 * context and the URL, because the internal admin page renders authored pages (as a preview) outside
 * the customer frame both of those describe. Whoever supplies the actions knows where they came from.
 */
export function GrowthDocumentActionsProvider(props: { actions: GrowthActionItem[], onChanged: () => Promise<void>, demo: boolean, projectId: string | null, children: ReactNode }) {
  return <GrowthDocumentActionsContext.Provider value={{ actions: props.actions, onChanged: props.onChanged, demo: props.demo, projectId: props.projectId }}>{props.children}</GrowthDocumentActionsContext.Provider>;
}

/**
 * An action referenced from inside an authored page, rendered as the same kind of card the rest of
 * the workspace uses so a page reads as one page rather than as a page with an embedded widget.
 *
 * The reference can dangle: staff wrote the page against an action that has since been deleted, or
 * the reader's overview no longer includes it (dismissed items drop out of the live lists). That is
 * a normal state, not an error — the card says so and offers nothing to click, because the
 * alternative is a button that fails when pressed.
 */
function ActionButtonBlock(props: { actionId: string }) {
  const context = useContext(GrowthDocumentActionsContext);
  const withQuery = useGrowthHref();
  const action = context?.actions.find((candidate) => candidate.id === props.actionId) ?? null;

  if (context == null || action == null) {
    return (
      <div className="my-5 rounded-xl border border-dashed border-foreground/[0.12] bg-foreground/[0.02] px-4 py-3">
        <p className="text-sm text-muted-foreground">This suggestion is no longer available in your workspace.</p>
      </div>
    );
  }

  const typeMeta = GROWTH_ACTION_TYPE_META.get(action.typeId) ?? { label: action.typeId, icon: LightningIcon };
  const TypeIcon = typeMeta.icon;
  return (
    <div className="my-5 rounded-xl border border-foreground/[0.1] bg-background p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-6 tracking-tight text-foreground">{action.title}</p>
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><TypeIcon className="size-3.5" />{typeMeta.label}</p>
        </div>
        <GrowthActionStatusBadge status={action.status} />
      </div>
      <div className="mt-3"><GrowthWatchedMetricChips action={action} /></div>
      {context.projectId == null
        ? <p className="mt-4 text-xs text-muted-foreground">The customer sees activate and dismiss controls here.</p>
        : (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <GrowthActionMutationControls action={action} onChanged={context.onChanged} demo={context.demo} className="flex flex-wrap items-center gap-2" />
            <Link href={withQuery(urlString`/projects/${context.projectId}/gtm/actions/${action.id}`)} className="inline-flex items-center gap-1.5 rounded-xl text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2">
              Review action<ArrowRightIcon className="size-3.5" />
            </Link>
          </div>
        )}
    </div>
  );
}

function ComponentBlock(props: { block: Extract<GrowthDocumentBlock, { type: "component" }>, data: Map<string, GrowthEvidenceDatum> }) {
  const datum = props.block.dataId == null ? null : props.data.get(props.block.dataId) ?? null;
  if (props.block.name === "ActionButton") {
    // The compiler rejects an ActionButton without an action id, so a null one here can only mean a
    // document from some other source; rendering nothing is better than an empty card.
    return props.block.actionId == null ? null : <ActionButtonBlock actionId={props.block.actionId} />;
  }
  if (props.block.name === "Metric" && datum?.kind === "metric") return <MetricBlock datum={datum} />;
  if (props.block.name === "TrendChart" && datum?.kind === "time_series") return <TrendChartBlock datum={datum} />;
  if ((props.block.name === "ComparisonChart" && datum?.kind === "comparison") || (props.block.name === "BreakdownChart" && datum?.kind === "breakdown")) return <BarChartBlock datum={datum} />;
  if (props.block.name === "Metric" || props.block.name === "TrendChart" || props.block.name === "ComparisonChart" || props.block.name === "BreakdownChart") return null;
  if (props.block.name === "Finding" || props.block.name === "Recommendation") {
    return (
      <section className="my-6 border-t border-foreground/[0.08] pt-5">
        <h2 className="mb-3 text-base font-semibold tracking-tight">
          {props.block.name === "Finding" ? "What we found" : "What we suggest"}
        </h2>
        <Blocks blocks={props.block.children} data={props.data} />
      </section>
    );
  }
  if (props.block.name === "MeasurementPlan") {
    return (
      <section className="my-6 border-t border-foreground/[0.08] pt-5">
        <h2 className="text-base font-semibold tracking-tight">What we&apos;ll track</h2>
        <p className="mt-2 text-sm text-muted-foreground">This section uses the action&apos;s live tracked metrics.</p>
      </section>
    );
  }
  const meta = CALLOUT_META.get(props.block.name);
  if (meta == null) return null;
  const Icon = meta.icon;
  return (
    <aside className={cn("my-5 rounded-xl p-4 ring-1", meta.className)}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
        <Icon className="size-4" />
        <span>{meta.label}</span>
        {props.block.name === "Hypothesis" && props.block.confidence != null && <DesignBadge label={`${props.block.confidence} confidence`} color="purple" size="sm" />}
      </div>
      <Blocks blocks={props.block.children} data={props.data} compact />
      {datum != null && <p className="mt-3 text-xs text-muted-foreground">Source: {datum.source}</p>}
    </aside>
  );
}

function Blocks(props: { blocks: GrowthDocumentBlock[], data: Map<string, GrowthEvidenceDatum>, compact?: boolean }) {
  return props.blocks.map((block, index) => {
    const key = `${block.type}-${index}`;
    switch (block.type) {
      case "heading": {
        return block.level === 2
          ? <h2 key={key} className="mb-3 mt-10 text-balance text-xl font-semibold tracking-tight first:mt-0"><InlineContent>{block.children}</InlineContent></h2>
          : <h3 key={key} className="mb-2 mt-7 text-balance text-base font-semibold tracking-tight first:mt-0"><InlineContent>{block.children}</InlineContent></h3>;
      }
      case "paragraph": {
        return <p key={key} className={cn("text-pretty leading-7 text-muted-foreground", props.compact ? "mb-2 text-sm last:mb-0" : "mb-4 text-sm sm:text-[15px]")}><InlineContent>{block.children}</InlineContent></p>;
      }
      case "list": {
        const List = block.ordered ? "ol" : "ul";
        return <List key={key} className={cn("mb-5 space-y-2 pl-5 text-sm leading-6 text-muted-foreground", block.ordered ? "list-decimal" : "list-disc")}>
          {block.items.map((item, itemIndex) => <li key={itemIndex}><Blocks blocks={item} data={props.data} compact /></li>)}
        </List>;
      }
      case "table": {
        return <div key={key} className="my-5 overflow-x-auto rounded-xl ring-1 ring-foreground/[0.08]">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <tbody>
              {block.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-b border-foreground/[0.07] last:border-0">
                {row.map((cell, cellIndex) => {
                  const Cell = rowIndex === 0 ? "th" : "td";
                  return <Cell key={cellIndex} className={cn("px-4 py-3", rowIndex === 0 ? "font-semibold text-foreground" : "text-muted-foreground")}><InlineContent>{cell}</InlineContent></Cell>;
                })}
              </tr>)}
            </tbody>
          </table>
        </div>;
      }
      case "code": { return <pre key={key} className="my-5 overflow-x-auto rounded-xl bg-foreground/[0.05] p-4 text-xs leading-6"><code>{block.value}</code></pre>; }
      case "rule": { return <hr key={key} className="my-8 border-foreground/[0.08]" />; }
      case "component": { return <ComponentBlock key={key} block={block} data={props.data} />; }
    }
  });
}

export function GrowthDocumentFragment(props: { document: GrowthDocument, blocks: GrowthDocumentBlock[], className?: string }) {
  const data = new Map(props.document.data.map((datum) => [datum.id, datum]));
  return <div className={props.className}><Blocks blocks={props.blocks} data={data} /></div>;
}

export function GrowthDocumentRenderer(props: { document: GrowthDocument, className?: string }) {
  return <article className={cn("mx-auto w-full max-w-4xl", props.className)}><GrowthDocumentFragment document={props.document} blocks={props.document.blocks} /></article>;
}
