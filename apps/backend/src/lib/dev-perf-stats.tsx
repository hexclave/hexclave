/**
 * Development Performance Stats
 *
 * This module tracks performance metrics for development debugging:
 * - PostgreSQL connection pool stats
 * - Event loop delay (p50, p99)
 * - Event loop utilization
 * - Memory usage (heap, RSS, external, array buffers)
 *
 * All metrics are only collected in development mode.
 */

import { getNextRuntime, getNodeEnvironment } from "@hexclave/shared/dist/utils/env";
import { createGlobal } from "@hexclave/shared/dist/utils/globals";

// ============================================================================
// Types
// ============================================================================

export type PgPoolStats = {
  /** Stats per labeled pool */
  pools: Record<string, {
    /** Total number of connections in the pool (active + idle) */
    total: number,
    /** Number of idle connections available for queries */
    idle: number,
    /** Number of queries waiting for a connection */
    waiting: number,
  }>,
  /** Aggregated stats across all pools */
  total: number,
  idle: number,
  waiting: number,
};

export type EventLoopDelayStats = {
  /** Minimum delay in milliseconds */
  minMs: number,
  /** Maximum delay in milliseconds */
  maxMs: number,
  /** Mean delay in milliseconds */
  meanMs: number,
  /** 50th percentile (median) delay in milliseconds */
  p50Ms: number,
  /** 95th percentile delay in milliseconds */
  p95Ms: number,
  /** 99th percentile delay in milliseconds */
  p99Ms: number,
};

export type EventLoopUtilizationStats = {
  /** Event loop utilization (0-1). How much time the event loop is busy vs idle */
  utilization: number,
  /** Time spent idle in milliseconds */
  idle: number,
  /** Time spent active in milliseconds */
  active: number,
};

export type MemoryStats = {
  /** Heap memory used in megabytes */
  heapUsedMB: number,
  /** Total heap memory allocated in megabytes */
  heapTotalMB: number,
  /** Resident Set Size - total memory allocated for the process in megabytes */
  rssMB: number,
  /** Memory used by C++ objects bound to JavaScript objects in megabytes */
  externalMB: number,
  /** Memory allocated for ArrayBuffers and SharedArrayBuffers in megabytes */
  arrayBuffersMB: number,
};

export type PerformanceSnapshot = {
  timestamp: number,
  pgPool: PgPoolStats | null,
  eventLoopDelay: EventLoopDelayStats | null,
  eventLoopUtilization: EventLoopUtilizationStats | null,
  memory: MemoryStats,
};

export type PerformanceHistory = {
  snapshots: PerformanceSnapshot[],
  maxSnapshots: number,
};

// ============================================================================
// Global State
// ============================================================================

const perfHistory = createGlobal<PerformanceHistory>("dev-perf-history", () => ({
  snapshots: [],
  maxSnapshots: 120, // Keep last 2 minutes at 1-second intervals
}));

// Store for pg pool instances to track, with labels
// Using "dev-pg-pools-v2" to invalidate old cached Set from previous version
const pgPools = createGlobal<Map<string, import("pg").Pool>>("dev-pg-pools-v2", () => new Map());

// Store event loop delay histogram
let eventLoopHistogram: import("node:perf_hooks").IntervalHistogram | null = null;

// Store last ELU reading for delta calculation
let lastELU: ReturnType<typeof import("node:perf_hooks").performance.eventLoopUtilization> | null = null;

// ============================================================================
// Pool Registration
// ============================================================================

/**
 * Register a pg Pool instance to be tracked for stats.
 * Call this when creating a new pool connection.
 *
 * @param pool - The pg Pool instance
 * @param label - A label to identify this pool (e.g., "primary", "replica")
 */
export function registerPgPool(pool: import("pg").Pool, label: string = "default"): void {
  if (getNodeEnvironment() !== "development") return;
  pgPools.set(label, pool);
}

/**
 * Unregister a pg Pool instance.
 * Call this when a pool is destroyed.
 */
export function unregisterPgPool(label: string): void {
  pgPools.delete(label);
}

// ============================================================================
// Stats Collection
// ============================================================================

function getPgPoolStats(): PgPoolStats | null {
  if (pgPools.size === 0) return null;

  // Stats per pool and aggregated totals
  const pools: PgPoolStats["pools"] = {};
  let total = 0;
  let idle = 0;
  let waiting = 0;

  for (const [label, pool] of pgPools) {
    const poolStats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };
    pools[label] = poolStats;
    total += poolStats.total;
    idle += poolStats.idle;
    waiting += poolStats.waiting;
  }

  return { pools, total, idle, waiting };
}

function getEventLoopDelayStats(): EventLoopDelayStats | null {
  if (!eventLoopHistogram) return null;

  // Clone values before reset
  const min = eventLoopHistogram.min;
  const max = eventLoopHistogram.max;
  const mean = eventLoopHistogram.mean;
  const p50 = eventLoopHistogram.percentile(50);
  const p95 = eventLoopHistogram.percentile(95);
  const p99 = eventLoopHistogram.percentile(99);

  // Reset for next interval
  eventLoopHistogram.reset();

  const hasInvalidValues = [min, max, mean, p50, p95, p99].some(value => !Number.isFinite(value));
  if (hasInvalidValues) {
    return null;
  }

  return {
    minMs: min / 1e6,
    maxMs: max / 1e6,
    meanMs: mean / 1e6,
    p50Ms: p50 / 1e6,
    p95Ms: p95 / 1e6,
    p99Ms: p99 / 1e6,
  };
}

function getEventLoopUtilizationStats(): EventLoopUtilizationStats | null {
  // Only available in Node.js runtime
  if (getNextRuntime() !== "nodejs") return null;

  try {
    const { performance } = require("node:perf_hooks") as typeof import("node:perf_hooks");

    if (!lastELU) {
      lastELU = performance.eventLoopUtilization();
      return null; // Need previous reading to calculate delta
    }

    const elu = performance.eventLoopUtilization(lastELU);
    lastELU = performance.eventLoopUtilization();

    return {
      utilization: elu.utilization,
      idle: elu.idle,
      active: elu.active,
    };
  } catch {
    return null;
  }
}

function getMemoryStats(): MemoryStats {
  // Only available in Node.js runtime
  if (getNextRuntime() !== "nodejs") {
    return {
      heapUsedMB: 0,
      heapTotalMB: 0,
      rssMB: 0,
      externalMB: 0,
      arrayBuffersMB: 0,
    };
  }

  try {
    // Use dynamic access to avoid Edge runtime static analysis error
    const memoryUsage = (globalThis as any).process?.memoryUsage;
    if (!memoryUsage) {
      return { heapUsedMB: 0, heapTotalMB: 0, rssMB: 0, externalMB: 0, arrayBuffersMB: 0 };
    }
    const mem = memoryUsage();
    return {
      heapUsedMB: mem.heapUsed / 1e6,
      heapTotalMB: mem.heapTotal / 1e6,
      rssMB: mem.rss / 1e6,
      externalMB: mem.external / 1e6,
      arrayBuffersMB: mem.arrayBuffers / 1e6,
    };
  } catch {
    return { heapUsedMB: 0, heapTotalMB: 0, rssMB: 0, externalMB: 0, arrayBuffersMB: 0 };
  }
}

function captureSnapshot(): PerformanceSnapshot {
  return {
    timestamp: Date.now(),
    pgPool: getPgPoolStats(),
    eventLoopDelay: getEventLoopDelayStats(),
    eventLoopUtilization: getEventLoopUtilizationStats(),
    memory: getMemoryStats(),
  };
}

// ============================================================================
// Initialization
// ============================================================================

let isInitialized = false;
let captureInterval: ReturnType<typeof setInterval> | null = null;

export function initPerfStats(): void {
  if (isInitialized) return;
  if (getNodeEnvironment() !== "development") return;
  if (getNextRuntime() !== "nodejs") return;

  isInitialized = true;

  try {
    // SAFETY: The runtime guard above restricts this require to Node.js, whose
    // perf_hooks module exposes monitorEventLoopDelay with this signature.
    const { monitorEventLoopDelay } = require("node:perf_hooks") as typeof import("node:perf_hooks");
    eventLoopHistogram = monitorEventLoopDelay({ resolution: 5 });
    eventLoopHistogram.enable();
  } catch {
    // Event loop delay monitoring not available
  }

  // Capture snapshots every second
  captureInterval = setInterval(() => {
    const snapshot = captureSnapshot();
    perfHistory.snapshots.push(snapshot);

    // Trim old snapshots
    while (perfHistory.snapshots.length > perfHistory.maxSnapshots) {
      perfHistory.snapshots.shift();
    }
  }, 1000);

  // Don't prevent process from exiting
  captureInterval.unref();
}

// ============================================================================
// API
// ============================================================================

/**
 * Get current performance snapshot (immediate reading)
 */
export function getCurrentPerfSnapshot(): PerformanceSnapshot {
  return captureSnapshot();
}

/**
 * Get performance history (time series)
 */
export function getPerfHistory(): PerformanceSnapshot[] {
  return [...perfHistory.snapshots];
}

/**
 * Clear performance history
 */
export function clearPerfHistory(): void {
  perfHistory.snapshots.length = 0;
}

/**
 * Get aggregated stats over recent history
 */
export function getAggregatePerfStats(windowMs: number = 60000): {
  pgPool: { avgTotal: number, avgIdle: number, maxWaiting: number } | null,
  eventLoopDelay: { avgP50Ms: number, avgP99Ms: number, maxP99Ms: number } | null,
  eventLoopUtilization: { avgUtilization: number, maxUtilization: number } | null,
  memory: { avgHeapUsedMB: number, avgRssMB: number, maxRssMB: number },
} {
  const now = Date.now();
  const cutoff = now - windowMs;
  const recentSnapshots = perfHistory.snapshots.filter(s => s.timestamp >= cutoff);

  if (recentSnapshots.length === 0) {
    return {
      pgPool: null,
      eventLoopDelay: null,
      eventLoopUtilization: null,
      memory: { avgHeapUsedMB: 0, avgRssMB: 0, maxRssMB: 0 },
    };
  }

  // PG Pool aggregates
  const pgSnapshots = recentSnapshots.filter(s => s.pgPool !== null);
  const pgPool = pgSnapshots.length > 0 ? {
    avgTotal: pgSnapshots.reduce((sum, s) => sum + s.pgPool!.total, 0) / pgSnapshots.length,
    avgIdle: pgSnapshots.reduce((sum, s) => sum + s.pgPool!.idle, 0) / pgSnapshots.length,
    maxWaiting: Math.max(...pgSnapshots.map(s => s.pgPool!.waiting)),
  } : null;

  // Event Loop Delay aggregates
  const eloDelaySnapshots = recentSnapshots.filter(s => s.eventLoopDelay !== null);
  const eventLoopDelay = eloDelaySnapshots.length > 0 ? {
    avgP50Ms: eloDelaySnapshots.reduce((sum, s) => sum + s.eventLoopDelay!.p50Ms, 0) / eloDelaySnapshots.length,
    avgP99Ms: eloDelaySnapshots.reduce((sum, s) => sum + s.eventLoopDelay!.p99Ms, 0) / eloDelaySnapshots.length,
    maxP99Ms: Math.max(...eloDelaySnapshots.map(s => s.eventLoopDelay!.p99Ms)),
  } : null;

  // Event Loop Utilization aggregates
  const eloUtilSnapshots = recentSnapshots.filter(s => s.eventLoopUtilization !== null);
  const eventLoopUtilization = eloUtilSnapshots.length > 0 ? {
    avgUtilization: eloUtilSnapshots.reduce((sum, s) => sum + s.eventLoopUtilization!.utilization, 0) / eloUtilSnapshots.length,
    maxUtilization: Math.max(...eloUtilSnapshots.map(s => s.eventLoopUtilization!.utilization)),
  } : null;

  // Memory aggregates
  const memory = {
    avgHeapUsedMB: recentSnapshots.reduce((sum, s) => sum + s.memory.heapUsedMB, 0) / recentSnapshots.length,
    avgRssMB: recentSnapshots.reduce((sum, s) => sum + s.memory.rssMB, 0) / recentSnapshots.length,
    maxRssMB: Math.max(...recentSnapshots.map(s => s.memory.rssMB)),
  };

  return { pgPool, eventLoopDelay, eventLoopUtilization, memory };
}
