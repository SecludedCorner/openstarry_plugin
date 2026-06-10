/** state-tracker — per-instance gear success rate tracking. No persistence (AC-CV5-2). */

import type { PluginSnapshot } from '@openstarry/sdk';

interface GearStats { success: number; total: number }

/** Plugin name used in PluginSnapshot for StateTracker checkpoint/restore (Plan46 W2). */
export const STATE_TRACKER_PLUGIN_NAME = 'state-tracker';

/**
 * Serializable snapshot of StateTracker state for cross-cycle persistence.
 *
 * schemaVersion added in Plan46 W0 to align with SafetyGate snapshot pattern.
 * fromSnapshot() validates schemaVersion === 1 and rejects unknown shapes.
 */
export interface StateTrackerSnapshot {
  readonly schemaVersion: 1;
  readonly rates: ReadonlyArray<[number, GearStats]>;
  readonly deltas: readonly number[];
  readonly categoryCounts: ReadonlyArray<[string, number]>;
}

export class StateTracker {
  private readonly rates = new Map<number, GearStats>();
  private readonly deltas: number[] = [];
  private readonly categoryCounts = new Map<string, number>();

  recordOutcome(gear: number, success: boolean): void {
    const s = this.rates.get(gear) ?? { success: 0, total: 0 };
    this.rates.set(gear, { success: s.success + (success ? 1 : 0), total: s.total + 1 });
  }

  getSuccessRate(gear: number): { rate: number; total: number } {
    const s = this.rates.get(gear);
    if (!s || s.total === 0) return { rate: 0, total: 0 };
    return { rate: s.success / s.total, total: s.total };
  }

  recordDelta(delta: number): void {
    this.deltas.push(delta);
    if (this.deltas.length > 20) this.deltas.shift();
  }

  recordObservation(category: string): void {
    this.categoryCounts.set(category, (this.categoryCounts.get(category) ?? 0) + 1);
  }

  getCategoryCount(category: string): number {
    return this.categoryCounts.get(category) ?? 0;
  }

  getTotalObservations(): number {
    let total = 0;
    for (const c of this.categoryCounts.values()) total += c;
    return total;
  }

  getRecentDeltas(): number[] { return [...this.deltas]; }
  getGearSuccessRates(): Map<number, GearStats> { return new Map(this.rates); }

  /** Serialize state for cross-cycle persistence (Plan44 hotfix, Plan46 schemaVersion). */
  serialize(): StateTrackerSnapshot {
    return {
      schemaVersion: 1,
      rates: [...this.rates.entries()],
      deltas: [...this.deltas],
      categoryCounts: [...this.categoryCounts.entries()],
    };
  }

  /**
   * Restore state from a serialized snapshot.
   *
   * Plan46 W0: runtime type validation mirroring SafetyGate.fromSnapshot()
   * (GUARDIAN finding, KERNEL corroborated). Throws on invalid snapshot so
   * the framework catches it → fresh state, consistent with SafetyGate.
   */
  static fromSnapshot(snapshot: unknown): StateTracker {
    if (
      snapshot === null ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot)
    ) {
      throw new Error('StateTracker.fromSnapshot: snapshot must be a non-null object');
    }

    const snap = snapshot as Record<string, unknown>;

    if (snap['schemaVersion'] !== 1) {
      throw new Error(
        `StateTracker.fromSnapshot: unknown schemaVersion ${String(snap['schemaVersion'])}` +
        ' (expected 1); migration required',
      );
    }

    if (!Array.isArray(snap['rates'])) {
      throw new Error('StateTracker.fromSnapshot: rates must be an array');
    }
    if (!Array.isArray(snap['deltas'])) {
      throw new Error('StateTracker.fromSnapshot: deltas must be an array');
    }
    if (!Array.isArray(snap['categoryCounts'])) {
      throw new Error('StateTracker.fromSnapshot: categoryCounts must be an array');
    }

    const tracker = new StateTracker();

    for (const entry of snap['rates'] as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [gear, stats] = entry;
      if (typeof gear !== 'number' || stats === null || typeof stats !== 'object') continue;
      const s = stats as Record<string, unknown>;
      if (typeof s.success !== 'number' || typeof s.total !== 'number') continue;
      tracker.rates.set(gear, { success: s.success, total: s.total });
    }

    for (const delta of snap['deltas'] as unknown[]) {
      if (typeof delta === 'number') tracker.deltas.push(delta);
    }

    for (const entry of snap['categoryCounts'] as unknown[]) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [cat, count] = entry;
      if (typeof cat !== 'string' || typeof count !== 'number') continue;
      tracker.categoryCounts.set(cat, count);
    }

    return tracker;
  }

  /**
   * Plan46 W2 — K-3 PluginHooks.onCheckpoint adapter.
   * Wraps serialize() in a PluginSnapshot envelope.
   */
  onCheckpoint(): PluginSnapshot {
    const snap = this.serialize();
    return {
      pluginName: STATE_TRACKER_PLUGIN_NAME,
      schemaVersion: snap.schemaVersion,
      state: {
        rates: snap.rates,
        deltas: snap.deltas,
        categoryCounts: snap.categoryCounts,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Plan46 W2 — K-3 PluginHooks.onRestore adapter.
   * Validates pluginName + schemaVersion then delegates to fromSnapshot().
   * Mutates this instance's state in place.
   */
  onRestore(snapshot: PluginSnapshot): void {
    if (snapshot.pluginName !== STATE_TRACKER_PLUGIN_NAME) {
      throw new Error(
        `StateTracker.onRestore: pluginName mismatch (${snapshot.pluginName} !== ${STATE_TRACKER_PLUGIN_NAME})`,
      );
    }
    const inner: StateTrackerSnapshot = {
      schemaVersion: snapshot.schemaVersion as 1,
      rates: snapshot.state['rates'] as StateTrackerSnapshot['rates'],
      deltas: snapshot.state['deltas'] as StateTrackerSnapshot['deltas'],
      categoryCounts: snapshot.state['categoryCounts'] as StateTrackerSnapshot['categoryCounts'],
    };
    const restored = StateTracker.fromSnapshot(inner);
    this.rates.clear();
    for (const [k, v] of restored.getGearSuccessRates()) this.rates.set(k, { ...v });
    this.deltas.length = 0;
    for (const d of restored.getRecentDeltas()) this.deltas.push(d);
    this.categoryCounts.clear();
    // getCategoryCount doesn't give enumerable keys; reach into serialized form:
    for (const [cat, count] of restored.serialize().categoryCounts) {
      this.categoryCounts.set(cat, count);
    }
  }
}
