/**
 * composite-snapshot — Plan47 K-3 wire-in composite PluginSnapshot for spc-monitor.
 *
 * spc-monitor owns three stateful sub-components (SafetyGate, ShewhartChart,
 * EscalationMonitor) that the Plan46 K-3 framework expects under a single
 * name-keyed PluginSnapshot. This module aggregates per-component serialize()
 * output into a composite `state` object and dispatches restore back into the
 * in-place instances so closure-captured references (factory `unsubShadow` et al.)
 * stay valid.
 *
 * Schema is FROZEN after Plan47 delivery per Rule #45 K-3 re-auth semantics.
 * Any incompatible shape change requires schemaVersion bump + migration path.
 *
 * Tenets preserved:
 *   - Tenet #2 plugin autonomy — composite lives in plugin src/, never Core.
 *   - Tenet #7 snapshot-schema freeze — schemaVersion guarded on both sides.
 *   - MR-6 — no policy constants in Core; all schema/name literals are
 *     plugin-local.
 *
 * @see Plan47_Implementation_Plan.md §2.4 C47-K3-M4 composite schema
 */

import type { PluginSnapshot } from '@openstarry/sdk';
import { SafetyGate, SAFETY_GATE_PLUGIN_NAME } from './safety-gate.js';
import { ShewhartChart, SHEWHART_CHART_PLUGIN_NAME } from './shewhart-chart.js';
import { EscalationMonitor } from './escalation-monitor.js';
import type { EscalationConfig, SafetyGateConfig } from './escalation-types.js';

/**
 * Composite PluginSnapshot identifier — matches spc-monitor's manifest name so
 * the framework hookMap key and PluginSnapshot.pluginName agree.
 */
export const SPC_MONITOR_PLUGIN_NAME = '@openstarry-plugin/spc-monitor';

/**
 * Composite schema version. schemaVersion = 1 = Plan47 initial composite.
 * Bump strictly when the envelope shape (not individual sub-schemas) changes.
 */
export const SPC_MONITOR_COMPOSITE_SCHEMA_VERSION = 1;

/**
 * Narrow shape for the composite `state` field. Sub-snapshots use each
 * component's own schemaVersion internally; the composite envelope carries
 * its own version independent from sub-versions.
 */
export interface SpcMonitorCompositeState {
  readonly safetyGate?: {
    readonly schemaVersion: 1;
    readonly lastTriggerMs: number;
    readonly shadowDecisionsSinceTrigger: number;
  };
  readonly shewhartChart?: {
    readonly schemaVersion: 1;
    readonly windows: string; // JSON-encoded per ShewhartChart.serialize()
  };
  readonly escalationMonitor?: {
    readonly schemaVersion: 1;
    readonly states: ReadonlyArray<[
      string,
      {
        readonly anomalyTimestamps: readonly number[];
        readonly level: 'normal' | 'watch' | 'warning' | 'critical';
        readonly monitoringOnly: boolean;
      },
    ]>;
  };
}

export interface SpcMonitorCompositeParts {
  readonly safetyGate?: SafetyGate;
  readonly shewhartChart?: ShewhartChart;
  readonly escalationMonitor?: EscalationMonitor;
}

/**
 * Capture a composite PluginSnapshot from the three sub-components.
 * Any sub-component may be absent; the envelope is still emitted so the
 * framework records a checkpoint entry for this plugin.
 */
export function captureSpcMonitorComposite(parts: SpcMonitorCompositeParts): PluginSnapshot {
  const state: Record<string, unknown> = {};

  if (parts.safetyGate) {
    const gateSnap = parts.safetyGate.serialize();
    state['safetyGate'] = {
      schemaVersion: gateSnap.schemaVersion,
      lastTriggerMs: gateSnap.lastTriggerMs,
      shadowDecisionsSinceTrigger: gateSnap.shadowDecisionsSinceTrigger,
    };
  }
  if (parts.shewhartChart) {
    state['shewhartChart'] = {
      schemaVersion: 1,
      windows: parts.shewhartChart.serialize(),
    };
  }
  if (parts.escalationMonitor) {
    const escSnap = parts.escalationMonitor.serialize();
    state['escalationMonitor'] = escSnap;
  }

  return {
    pluginName: SPC_MONITOR_PLUGIN_NAME,
    schemaVersion: SPC_MONITOR_COMPOSITE_SCHEMA_VERSION,
    state,
    timestamp: Date.now(),
  };
}

/**
 * Apply a composite PluginSnapshot back into the live sub-components.
 *
 * Contract:
 *   - Validates pluginName and schemaVersion (throws on mismatch; framework
 *     CheckpointManager catches and falls back to fresh state).
 *   - Per-component restore uses the in-place `applySnapshot` / `onRestore`
 *     so existing references (factory closure, ctx.bus subscribers) survive.
 *   - A missing sub-section is a no-op for that component (forward-compat).
 *
 * Used by spc-monitor factory's onRestore adapter.
 */
export function applySpcMonitorComposite(
  snapshot: PluginSnapshot,
  parts: SpcMonitorCompositeParts,
  options?: {
    readonly safetyGateConfig?: SafetyGateConfig;
    readonly escalationConfig?: EscalationConfig;
  },
): void {
  if (snapshot.pluginName !== SPC_MONITOR_PLUGIN_NAME) {
    throw new Error(
      `SpcMonitorComposite.onRestore: pluginName mismatch (${snapshot.pluginName} !== ${SPC_MONITOR_PLUGIN_NAME})`,
    );
  }
  if (snapshot.schemaVersion !== SPC_MONITOR_COMPOSITE_SCHEMA_VERSION) {
    throw new Error(
      `SpcMonitorComposite.onRestore: unsupported composite schemaVersion ${snapshot.schemaVersion}` +
      ` (expected ${SPC_MONITOR_COMPOSITE_SCHEMA_VERSION})`,
    );
  }
  const state = snapshot.state;

  // SafetyGate: delegate to SafetyGate.fromSnapshot + copy fields.
  const gateSub = state['safetyGate'];
  if (parts.safetyGate && gateSub && typeof gateSub === 'object') {
    const restored = SafetyGate.fromSnapshot(gateSub, options?.safetyGateConfig);
    // Copy internal state via the in-place restore path: serialize+apply keeps
    // one code path for the invariant. We can use restored.serialize() as the
    // source of truth back into the live gate.
    const snap = restored.serialize();
    parts.safetyGate.onRestore({
      pluginName: SAFETY_GATE_PLUGIN_NAME,
      schemaVersion: snap.schemaVersion,
      state: {
        lastTriggerMs: snap.lastTriggerMs,
        shadowDecisionsSinceTrigger: snap.shadowDecisionsSinceTrigger,
      },
      timestamp: Date.now(),
    });
  }

  // ShewhartChart: reuse the existing PluginSnapshot contract for consistency.
  const chartSub = state['shewhartChart'];
  if (
    parts.shewhartChart &&
    chartSub &&
    typeof chartSub === 'object' &&
    typeof (chartSub as Record<string, unknown>)['windows'] === 'string'
  ) {
    parts.shewhartChart.onRestore({
      pluginName: SHEWHART_CHART_PLUGIN_NAME,
      schemaVersion: 1,
      state: { windows: (chartSub as Record<string, unknown>)['windows'] as string },
      timestamp: Date.now(),
    });
  }

  // EscalationMonitor: use applySnapshot for in-place mutation.
  const escSub = state['escalationMonitor'];
  if (parts.escalationMonitor && escSub && typeof escSub === 'object') {
    const restored = EscalationMonitor.fromSnapshot(escSub, options?.escalationConfig);
    parts.escalationMonitor.applySnapshot(restored.serialize());
  }
}
