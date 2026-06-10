/**
 * shewhart-chart — Shewhart control chart implementation for SPC monitoring.
 * Tracks per-category M4a deviation stream with UCL/LCL at +-3sigma.
 * Monitoring-only: no automated response (C44-5, Rule #57).
 * @see Plan44 W2-2, W2-3, W2-4
 */

import type { ShadowDecisionRecord } from '@openstarry-plugin/gear-arbiter-dynamic';
import type { PluginSnapshot } from '@openstarry/sdk';

/** Plugin name used in PluginSnapshot for ShewhartChart checkpoint/restore (Plan46 W2). */
export const SHEWHART_CHART_PLUGIN_NAME = 'shewhart-chart';
/** Schema version for ShewhartChart snapshots — bump on incompatible state shape changes. */
export const SHEWHART_CHART_SCHEMA_VERSION = 1;

/** Running statistics for a single category. */
export interface CategoryStats {
  readonly category: string;
  readonly count: number;
  readonly mean: number;
  readonly std: number;
  readonly ucl: number;
  readonly lcl: number;
  readonly lastValue: number;
  readonly monitoringOnly: boolean;
}

/** SPC anomaly event payload. */
export interface SpcAnomaly {
  readonly category: string;
  readonly currentValue: number;
  readonly ucl: number;
  readonly lcl: number;
  readonly mean: number;
  readonly std: number;
  readonly windowSize: number;
  readonly monitoringOnly: boolean;
  readonly reason: string;
}

/** Per-category rolling window data. */
interface CategoryWindow {
  readonly deviations: number[];
  count: number;
  sum: number;
  sumSq: number;
  monitoringOnly: boolean;
  /** Previous-round agreement rate for 20pp change detection (D7-Q7). */
  prevAgreementRate: number | null;
  agreementCount: number;
}

export class ShewhartChart {
  private readonly windows = new Map<string, CategoryWindow>();

  constructor(private readonly windowSize: number = 50) {}

  /**
   * Add a shadow decision data point.
   * Checks against PRIOR control limits before adding (standard SPC practice).
   * Returns anomaly if out-of-control detected, null otherwise.
   */
  addDataPoint(record: ShadowDecisionRecord): SpcAnomaly | null {
    let win = this.windows.get(record.category);
    if (!win) {
      win = {
        deviations: [],
        count: 0, sum: 0, sumSq: 0,
        monitoringOnly: record.monitoringOnly,
        prevAgreementRate: null,
        agreementCount: 0,
      };
      this.windows.set(record.category, win);
    }

    const value = record.deviation;

    // Check BEFORE adding: compare new point against prior control limits
    let anomaly: SpcAnomaly | null = null;
    if (win.deviations.length >= 2) {
      const n = win.deviations.length;
      const mean = win.sum / n;
      const variance = (win.sumSq / n) - (mean * mean);
      const std = Math.sqrt(Math.max(0, variance));
      const ucl = mean + 3 * std;
      const lcl = mean - 3 * std;

      // Shewhart +-3sigma rule (W2-2): point beyond PRIOR control limits
      if (value > ucl || value < lcl) {
        anomaly = {
          category: record.category,
          currentValue: value,
          ucl, lcl, mean, std,
          windowSize: n,
          monitoringOnly: record.monitoringOnly,
          reason: `Point ${value.toFixed(4)} beyond ${value > ucl ? 'UCL' : 'LCL'} (+-3sigma)`,
        };
      }
    }

    // Now add to window
    win.deviations.push(value);
    win.count++;
    win.sum += value;
    win.sumSq += value * value;
    if (record.agrees) win.agreementCount++;

    // Maintain rolling window
    if (win.deviations.length > this.windowSize) {
      const removed = win.deviations.shift()!;
      win.sum -= removed;
      win.sumSq -= removed * removed;
    }

    if (anomaly) return anomaly;

    // Destructive: 20pp agreement change trigger (D7-Q7, AC-W2-5)
    if (record.monitoringOnly) {
      const currentAgreementRate = win.agreementCount / win.count;
      if (win.prevAgreementRate !== null) {
        const change = Math.abs(currentAgreementRate - win.prevAgreementRate);
        if (change >= 0.20) {
          const n = win.deviations.length;
          const mean = win.sum / n;
          const variance = (win.sumSq / n) - (mean * mean);
          const std = Math.sqrt(Math.max(0, variance));
          return {
            category: record.category,
            currentValue: value,
            ucl: mean + 3 * std,
            lcl: mean - 3 * std,
            mean, std,
            windowSize: n,
            monitoringOnly: true,
            reason: `Agreement rate change ${(change * 100).toFixed(1)}pp exceeds 20pp threshold`,
          };
        }
      }
    }

    return null;
  }

  /** Get current stats for a category. */
  getCategoryStats(category: string): CategoryStats | null {
    const win = this.windows.get(category);
    if (!win || win.deviations.length < 2) return null;

    const n = win.deviations.length;
    const mean = win.sum / n;
    const variance = (win.sumSq / n) - (mean * mean);
    const std = Math.sqrt(Math.max(0, variance));

    return {
      category,
      count: n,
      mean, std,
      ucl: mean + 3 * std,
      lcl: mean - 3 * std,
      lastValue: win.deviations[n - 1],
      monitoringOnly: win.monitoringOnly,
    };
  }

  /** Get all category stats. */
  getAllStats(): CategoryStats[] {
    const stats: CategoryStats[] = [];
    for (const category of this.windows.keys()) {
      const s = this.getCategoryStats(category);
      if (s) stats.push(s);
    }
    return stats;
  }

  /** Update previous agreement rate for destructive 20pp detection. Call per-round. */
  snapshotAgreementRates(): void {
    for (const win of this.windows.values()) {
      win.prevAgreementRate = win.count > 0 ? win.agreementCount / win.count : null;
    }
  }

  /** Reset all state (e.g., on Phase3Config change, W2-4). */
  reset(): void {
    this.windows.clear();
  }

  /** Serialize state for cross-session continuity (W2-4). */
  serialize(): string {
    const data: Record<string, { deviations: number[]; count: number; sum: number; sumSq: number; monitoringOnly: boolean; prevAgreementRate: number | null; agreementCount: number }> = {};
    for (const [cat, win] of this.windows) {
      data[cat] = {
        deviations: [...win.deviations],
        count: win.count,
        sum: win.sum,
        sumSq: win.sumSq,
        monitoringOnly: win.monitoringOnly,
        prevAgreementRate: win.prevAgreementRate,
        agreementCount: win.agreementCount,
      };
    }
    return JSON.stringify(data);
  }

  /** Restore state from serialized data (W2-4). SEC-003: validated JSON.parse. */
  static deserialize(json: string, windowSize: number = 50): ShewhartChart {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error('ShewhartChart.deserialize: invalid JSON');
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('ShewhartChart.deserialize: expected object');
    }

    const chart = new ShewhartChart(windowSize);
    const data = parsed as Record<string, unknown>;

    for (const [cat, raw] of Object.entries(data)) {
      if (raw === null || typeof raw !== 'object') continue;
      const win = raw as Record<string, unknown>;

      // Validate required fields (lenient: skip non-conforming entries)
      if (!Array.isArray(win['deviations'])) continue;
      if (typeof win['count'] !== 'number') continue;
      if (typeof win['sum'] !== 'number') continue;
      if (typeof win['sumSq'] !== 'number') continue;
      if (typeof win['monitoringOnly'] !== 'boolean') continue;
      if (win['prevAgreementRate'] !== null && typeof win['prevAgreementRate'] !== 'number') continue;
      if (typeof win['agreementCount'] !== 'number') continue;

      // Filter deviations to numbers only
      const deviations = (win['deviations'] as unknown[]).filter(
        (d): d is number => typeof d === 'number',
      );

      chart.windows.set(cat, {
        deviations,
        count: win['count'] as number,
        sum: win['sum'] as number,
        sumSq: win['sumSq'] as number,
        monitoringOnly: win['monitoringOnly'] as boolean,
        prevAgreementRate: win['prevAgreementRate'] as number | null,
        agreementCount: win['agreementCount'] as number,
      });
    }

    return chart;
  }

  /**
   * Plan46 W2 — K-3 PluginHooks.onCheckpoint adapter.
   * Wraps serialize() (a JSON string) in a PluginSnapshot envelope under a
   * single `windows` field so the framework sees it as opaque state.
   * SEC-003 validation is preserved: onRestore delegates to deserialize()
   * which rejects corrupt/tampered JSON (C46-3).
   */
  onCheckpoint(): PluginSnapshot {
    return {
      pluginName: SHEWHART_CHART_PLUGIN_NAME,
      schemaVersion: SHEWHART_CHART_SCHEMA_VERSION,
      state: { windows: this.serialize() },
      timestamp: Date.now(),
    };
  }

  /**
   * Plan46 W2 — K-3 PluginHooks.onRestore adapter.
   * Validates pluginName + schemaVersion, then delegates to deserialize()
   * which enforces SEC-003 JSON validation (C46-3 preserved). On success,
   * copies restored windows into this instance.
   */
  onRestore(snapshot: PluginSnapshot): void {
    if (snapshot.pluginName !== SHEWHART_CHART_PLUGIN_NAME) {
      throw new Error(
        `ShewhartChart.onRestore: pluginName mismatch (${snapshot.pluginName} !== ${SHEWHART_CHART_PLUGIN_NAME})`,
      );
    }
    if (snapshot.schemaVersion !== SHEWHART_CHART_SCHEMA_VERSION) {
      throw new Error(
        `ShewhartChart.onRestore: unsupported schemaVersion ${snapshot.schemaVersion}`,
      );
    }
    const windowsJson = snapshot.state['windows'];
    if (typeof windowsJson !== 'string') {
      throw new Error('ShewhartChart.onRestore: state.windows must be a JSON string');
    }
    // SEC-003 preserved: deserialize() runs the full JSON schema validator.
    const restored = ShewhartChart.deserialize(windowsJson, this.windowSize);
    // Copy restored windows into `this` — avoid creating a new instance so
    // existing references (e.g. inside SpcMonitor) remain valid.
    this.windows.clear();
    for (const [cat, win] of (restored as unknown as { windows: Map<string, unknown> }).windows) {
      this.windows.set(cat, win as never);
    }
  }
}
