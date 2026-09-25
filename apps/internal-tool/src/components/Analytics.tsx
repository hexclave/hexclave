import { useMemo } from "react";
import { clsx } from "clsx";
import type { McpCallLogRow, QaEntriesRow } from "../types";
import { toDate } from "../utils";

export function Analytics({ rows, qaEntries }: { rows: McpCallLogRow[], qaEntries: QaEntriesRow[] }) {
  const stats = useMemo(() => {
    const reviewed = rows.filter(r => r.qaOverallScore != null);
    const scores = reviewed.map(r => r.qaOverallScore ?? 0);
    const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

    const needsReview = rows.filter(r => r.qaNeedsHumanReview && !r.humanReviewedAt).length;
    const humanReviewed = rows.filter(r => r.humanReviewedAt != null).length;
    const publishedCount = qaEntries.filter(r => r.published).length;
    const draftCount = qaEntries.filter(r => !r.published).length;

    // Score buckets
    const scoreBuckets = [
      { label: "90-100", min: 90, max: 100, color: "bg-green-500" },
      { label: "70-89", min: 70, max: 89, color: "bg-green-300" },
      { label: "50-69", min: 50, max: 69, color: "bg-yellow-400" },
      { label: "30-49", min: 30, max: 49, color: "bg-orange-400" },
      { label: "0-29", min: 0, max: 29, color: "bg-red-500" },
    ].map(b => ({
      ...b,
      count: scores.filter(s => s >= b.min && s <= b.max).length,
    }));
    const maxScoreBucket = Math.max(...scoreBuckets.map(b => b.count), 1);

    // Flag types
    const flagCounts = new Map<string, number>();
    for (const row of reviewed) {
      if (!row.qaFlagsJson) continue;
      try {
        const flags = JSON.parse(row.qaFlagsJson) as Array<{ type: string }>;
        for (const flag of flags) {
          flagCounts.set(flag.type, (flagCounts.get(flag.type) ?? 0) + 1);
        }
      } catch {
        // ignore
      }
    }
    const topFlags = Array.from(flagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const maxFlagCount = Math.max(...topFlags.map(f => f[1]), 1);

    // Calls over time (last 14 days)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const daysBack = 14;
    const dayBuckets: Array<{ label: string; count: number; date: Date }> = [];
    for (let i = daysBack - 1; i >= 0; i--) {
      const d = new Date(now - i * dayMs);
      d.setHours(0, 0, 0, 0);
      dayBuckets.push({
        label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        count: 0,
        date: d,
      });
    }
    for (const row of rows) {
      const rowDate = toDate(row.createdAt);
      const dayStart = new Date(rowDate);
      dayStart.setHours(0, 0, 0, 0);
      const bucket = dayBuckets.find(b => b.date.getTime() === dayStart.getTime());
      if (bucket) bucket.count++;
    }
    const maxDayCount = Math.max(...dayBuckets.map(b => b.count), 1);

    // Duration stats
    const durations = rows.map(r => Number(r.durationMs)).filter(d => d > 0).sort((a, b) => a - b);
    const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
    const p95Duration = durations.length > 0 ? durations[Math.min(Math.floor(durations.length * 0.95), durations.length - 1)] : 0;
    const maxDuration = durations.length > 0 ? durations[durations.length - 1] : 0;

    // Tool usage
    const toolCounts = new Map<string, number>();
    for (const row of rows) {
      toolCounts.set(row.toolName, (toolCounts.get(row.toolName) ?? 0) + 1);
    }
    const toolUsage = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]);

    return {
      total: rows.length,
      reviewed: reviewed.length,
      avgScore,
      needsReview,
      humanReviewed,
      publishedCount,
      draftCount,
      scoreBuckets,
      maxScoreBucket,
      topFlags,
      maxFlagCount,
      dayBuckets,
      maxDayCount,
      avgDuration,
      p95Duration,
      maxDuration,
      toolUsage,
    };
  }, [rows, qaEntries]);

  const humanReviewRate = stats.total > 0 ? Math.round((stats.humanReviewed / stats.total) * 100) : 0;
  const reviewRate = stats.total > 0 ? Math.round((stats.reviewed / stats.total) * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Key Metrics */}
      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Total Calls" value={stats.total.toLocaleString()} />
        <MetricCard
          label="Avg QA Score"
          value={stats.avgScore.toString()}
          valueClass={
            stats.avgScore >= 80 ? "text-green-600" :
              stats.avgScore >= 50 ? "text-yellow-600" : "text-red-600"
          }
          subtitle={`${reviewRate}% reviewed`}
        />
        <MetricCard
          label="Needs Review"
          value={stats.needsReview.toString()}
          valueClass={stats.needsReview > 0 ? "text-amber-600" : "text-gray-400"}
          subtitle={`${humanReviewRate}% human-reviewed`}
        />
        <MetricCard
          label="Published Q&A"
          value={stats.publishedCount.toString()}
          subtitle={`${stats.draftCount} drafts`}
        />
      </div>

      {/* Calls Over Time */}
      <Card title="Calls Over Time (last 14 days)">
        <div className="flex items-end gap-1 h-32">
          {stats.dayBuckets.map(bucket => (
            <div key={bucket.label} className="flex-1 flex flex-col items-center gap-1" title={`${bucket.label}: ${bucket.count}`}>
              <div className="w-full flex-1 flex items-end">
                <div
                  className="w-full bg-blue-400 rounded-t"
                  style={{ height: `${(bucket.count / stats.maxDayCount) * 100}%` }}
                />
              </div>
              <span className="text-[9px] text-gray-400">{bucket.label}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        {/* QA Score Distribution */}
        <Card title="QA Score Distribution">
          {stats.reviewed === 0 ? (
            <p className="text-sm text-gray-400">No QA reviews yet</p>
          ) : (
            <div className="space-y-2">
              {stats.scoreBuckets.map(bucket => (
                <div key={bucket.label} className="flex items-center gap-2">
                  <span className="text-xs text-gray-500 w-16">{bucket.label}</span>
                  <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden">
                    <div
                      className={clsx("h-full rounded", bucket.color)}
                      style={{ width: `${(bucket.count / stats.maxScoreBucket) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-600 w-8 text-right">{bucket.count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Top Flag Types */}
        <Card title="Top Flag Types">
          {stats.topFlags.length === 0 ? (
            <p className="text-sm text-gray-400">No flags raised</p>
          ) : (
            <div className="space-y-2">
              {stats.topFlags.map(([type, count]) => (
                <div key={type} className="flex items-center gap-2">
                  <span className="text-xs text-gray-600 w-32 truncate font-mono">{type}</span>
                  <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden">
                    <div
                      className="h-full bg-orange-400 rounded"
                      style={{ width: `${(count / stats.maxFlagCount) * 100}%` }}
                    />
                  </div>
                  <span className="text-xs text-gray-600 w-8 text-right">{count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* Response Time */}
        <Card title="Response Time">
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Average</span>
              <span className="font-mono">{stats.avgDuration.toLocaleString()}ms</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">p95</span>
              <span className="font-mono">{stats.p95Duration.toLocaleString()}ms</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Max</span>
              <span className="font-mono">{stats.maxDuration.toLocaleString()}ms</span>
            </div>
          </div>
        </Card>

        {/* Tool Usage */}
        <Card title="Tool Usage">
          {stats.toolUsage.length === 0 ? (
            <p className="text-sm text-gray-400">No calls yet</p>
          ) : (
            <div className="space-y-2">
              {stats.toolUsage.map(([tool, count]) => (
                <div key={tool} className="flex items-center justify-between">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800">
                    {tool}
                  </span>
                  <span className="text-sm text-gray-600 font-mono">{count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function MetricCard({ label, value, valueClass, subtitle }: {
  label: string;
  value: string;
  valueClass?: string;
  subtitle?: string;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <p className="text-[10px] uppercase text-gray-400 font-medium tracking-wider mb-1">{label}</p>
      <p className={clsx("text-2xl font-bold", valueClass ?? "text-gray-900")}>{value}</p>
      {subtitle && (
        <p className="text-[10px] text-gray-400 mt-0.5">{subtitle}</p>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-3">{title}</h3>
      {children}
    </div>
  );
}
