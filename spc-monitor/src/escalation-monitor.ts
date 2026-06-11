/**
 * escalation-monitor — L2 Escalation Monitor for WIENER safety framework.
 * Tracks per-category anomaly counts within a sliding time window.
 * Transitions categories through normal→watch→warning→critical levels.
 * Monitoring-only for destructive categories (Rule #55, Rule #57).
 * Threshold values are HYPOTHESIS (Rule #59).
 * @see Plan45 W1-1, §1.1
 */

import type { SpcAnomaly } from './shewhart-chart.js';
import type {
  EscalationLevel,
  CategoryEscalation,
  EscalationEvent,
  EscalationConfig,
} from './escalation-types.js';

/** Schema version for EscalationMonitor snapshots (Plan47 K-3 composite bridge). */
export const ESCALATION_MONITOR_SCHEMA_VERSION = 1;

/** Serializable snapshot of per-category escalation state. */
export interface EscalationMonitorSnapshot {
  readonly schemaVersion: 1;
  readonly states: ReadonlyArray<[
    string,
    {
      readonly anomalyTimestamps: readonly number[];
      readonly level: EscalationLevel;
      readonly monitoringOnly: boolean;
    },
  ]>;
}

// HYPOTHESIS thresholds (Rule #59)
/** HYPOTHESIS (Rule #59) — to be calibrated with R10+ operational data. */
const DEFAULT_WINDOW_MS = 300_000;
/** HYPOTHESIS (Rule #59) — to be calibrated with R10+ operational data. */
const DEFAULT_WATCH = 2;
/** HYPOTHESIS (Rule #59) — to be calibrated with R10+ operational data. */
const DEFAULT_WARNING = 4;
/** HYPOTHESIS (Rule #59) — to be calibrated with R10+ operational data. */
const DEFAULT_CRITICAL = 7;

interface CategoryState {
  /** Timestamps (epoch ms) of anomalies within the window. */
  anomalyTimestamps: number[];
  level: EscalationLevel;
  monitoringOnly: boolean;
}

export class EscalationMonitor {
  private readonly states = new Map<string, CategoryState>();
  private readonly windowMs: number;
  private readonly watchThreshold: number;
  private readonly warningThreshold: number;
  private readonly criticalThreshold: number;

  constructor(config?: EscalationConfig) {
    this.windowMs = config?.windowMs ?? DEFAULT_WINDOW_MS;
    this.watchThreshold = config?.thresholds?.watch ?? DEFAULT_WATCH;
    this.warningThreshold = config?.thresholds?.warning ?? DEFAULT_WARNING;
    this.criticalThreshold = config?.thresholds?.critical ?? DEFAULT_CRITICAL;
  }

  /**
   * Process an SPC anomaly: update per-category state and return an EscalationEvent
   * if the level changed, or null if the level is unchanged.
   */
  processAnomaly(anomaly: SpcAnomaly): EscalationEvent | null {
    const now = Date.now();
    const cat = anomaly.category;

    let state = this.states.get(cat);
    if (!state) {
      state = {
        anomalyTimestamps: [],
        level: 'normal',
        monitoringOnly: anomaly.monitoringOnly,
      };
      this.states.set(cat, state);
    }

    // Add new anomaly timestamp
    state.anomalyTimestamps.push(now);

    // Prune timestamps outside the window
    const cutoff = now - this.windowMs;
    state.anomalyTimestamps = state.anomalyTimestamps.filter(t => t >= cutoff);

    const count = state.anomalyTimestamps.length;
    const newLevel = this.computeLevel(count);
    const previousLevel = state.level;

    if (newLevel === previousLevel) {
      return null;
    }

    state.level = newLevel;

    return {
      category: cat,
      previousLevel,
      currentLevel: newLevel,
      anomalyCount: count,
      windowMs: this.windowMs,
      timestamp: now,
    };
  }

  /** Compute escalation level from anomaly count. */
  private computeLevel(count: number): EscalationLevel {
    if (count >= this.criticalThreshold) return 'critical';
    if (count >= this.warningThreshold) return 'warning';
    if (count >= this.watchThreshold) return 'watch';
    return 'normal';
  }

  /** Get all current category escalation states. */
  getAllStates(): ReadonlyMap<string, CategoryEscalation> {
    const now = Date.now();
    const result = new Map<string, CategoryEscalation>();

    for (const [cat, state] of this.states) {
      // Prune stale timestamps for accurate reporting
      const cutoff = now - this.windowMs;
      const active = state.anomalyTimestamps.filter(t => t >= cutoff);
      const windowStart = active.length > 0 ? active[0] : now;
      const lastAnomaly = active.length > 0 ? active[active.length - 1] : 0;

      result.set(cat, {
        category: cat,
        level: state.level,
        anomalyCount: active.length,
        windowStartMs: windowStart,
        lastAnomalyMs: lastAnomaly,
        monitoringOnly: state.monitoringOnly,
      });
    }

    return result;
  }

  /**
   * Get categories currently at 'critical' level that are NOT monitoringOnly.
   * (Rule #55, Rule #57: destructive categories are excluded from L3 trigger.)
   */
  getCriticalCategories(): string[] {
    const result: string[] = [];
    for (const [cat, state] of this.states) {
      if (state.level === 'critical' && !state.monitoringOnly) {
        result.push(cat);
      }
    }
    return result;
  }

  /** Reset all state. */
  reset(): void {
    this.states.clear();
  }

  /** Serialize state for composite snapshot (Plan47 K-3 wire-in). */
  serialize(): EscalationMonitorSnapshot {
    const states: Array<[string, EscalationMonitorSnapshot['states'][number][1]]> = [];
    for (const [cat, state] of this.states) {
      states.push([cat, {
        anomalyTimestamps: [...state.anomalyTimestamps],
        level: state.level,
        monitoringOnly: state.monitoringOnly,
      }]);
    }
    return { schemaVersion: 1, states };
  }

  /**
   * Restore EscalationMonitor state from a snapshot, validating shape.
   * Lenient on per-entry shape (skips malformed entries) to match SafetyGate
   * and StateTracker restore semantics.
   */
  static fromSnapshot(snapshot: unknown, config?: EscalationConfig): EscalationMonitor {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new Error('EscalationMonitor.fromSnapshot: snapshot must be a non-null object');
    }
    const snap = snapshot as Record<string, unknown>;
    if (snap['schemaVersion'] !== 1) {
      throw new Error(
        `EscalationMonitor.fromSnapshot: unknown schemaVersion ${String(snap['schemaVersion'])}` +
        ' (expected 1); migration required',
      );
    }
    if (!Array.isArray(snap['states'])) {
      throw new Error('EscalationMonitor.fromSnapshot: states must be an array');
    }

    const monitor = new EscalationMonitor(config);
    for (const entry of snap['states'] as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [cat, raw] = entry;
      if (typeof cat !== 'string' || raw === null || typeof raw !== 'object') continue;
      const state = raw as Record<string, unknown>;
      if (!Array.isArray(state['anomalyTimestamps'])) continue;
      if (typeof state['level'] !== 'string') continue;
      if (typeof state['monitoringOnly'] !== 'boolean') continue;
      const level = state['level'] as EscalationLevel;
      if (level !== 'normal' && level !== 'watch' && level !== 'warning' && level !== 'critical') {
        continue;
      }
      const timestamps = (state['anomalyTimestamps'] as unknown[]).filter(
        (t): t is number => typeof t === 'number',
      );
      monitor.states.set(cat, {
        anomalyTimestamps: [...timestamps],
        level,
        monitoringOnly: state['monitoringOnly'] as boolean,
      });
    }
    return monitor;
  }

  /**
   * Plan47 K-3 composite bridge — mutate-in-place restore used by spc-monitor
   * composite snapshot. Keeps existing object reference so callers (e.g. the
   * plugin factory's closure-captured monitor) stay valid.
   */
  applySnapshot(snapshot: EscalationMonitorSnapshot): void {
    this.states.clear();
    for (const [cat, state] of snapshot.states) {
      this.states.set(cat, {
        anomalyTimestamps: [...state.anomalyTimestamps],
        level: state.level,
        monitoringOnly: state.monitoringOnly,
      });
    }
  }
}
