/**
 * spc-monitor — Statistical Process Control plugin for Phase 3 shadow monitoring.
 * Plan45 expansion: L2 Escalation Monitor + L3 Emergency Safety Gate.
 * Independent plugin (Tenet #2). Zero Core modifications (Tenet #7, C44-8, C45-2).
 * Monitoring-only for destructive categories (C44-5, Rule #55, Rule #57).
 * Disabled when Phase3Config.enabled = false (C44-6, naturally via no events).
 * @see Plan44 W2, Plan45 W1
 */

import type { IPlugin, IPluginContext, PluginHooks, PluginSnapshot } from '@openstarry/sdk';
import type { ShadowDecisionRecord } from '@openstarry-plugin/gear-arbiter-dynamic';
import { ShewhartChart } from './shewhart-chart.js';
import { EscalationMonitor } from './escalation-monitor.js';
import { SafetyGate } from './safety-gate.js';
import type { EscalationConfig, SafetyGateConfig } from './escalation-types.js';
import {
  captureSpcMonitorComposite,
  applySpcMonitorComposite,
} from './composite-snapshot.js';

export type { CategoryStats, SpcAnomaly } from './shewhart-chart.js';
export { ShewhartChart } from './shewhart-chart.js';
export type {
  EscalationLevel,
  CategoryEscalation,
  EscalationEvent,
  EscalationConfig,
  SafetyGateConfig,
  SafetyGateEvent,
  SafetyGateSnapshot,
} from './escalation-types.js';
export { EscalationMonitor, ESCALATION_MONITOR_SCHEMA_VERSION } from './escalation-monitor.js';
export type { EscalationMonitorSnapshot } from './escalation-monitor.js';
export { SafetyGate } from './safety-gate.js';
export {
  SPC_MONITOR_PLUGIN_NAME,
  SPC_MONITOR_COMPOSITE_SCHEMA_VERSION,
  captureSpcMonitorComposite,
  applySpcMonitorComposite,
} from './composite-snapshot.js';
export type { SpcMonitorCompositeState, SpcMonitorCompositeParts } from './composite-snapshot.js';

// Plan50 σ_regime in-place annotation machinery (cycle 03-13 BINDING + cycle 03-14 R3 refinement).
export {
  RETROACTIVE_LEGACY_PROVENANCE,
  LEGACY_UNTAGGED_REGIME,
  SECTION_76_7_TEXT,
  inferSigmaRegime,
  shouldActivateFr2Pooled,
  shouldEmitSection767Caveat,
  assertSigmaRegimePresent,
  getSigmaRegimeOrLegacy,
  migrateLegacySigmaRecords,
} from './sigma-regime.js';
export type { MigrationResult } from './sigma-regime.js';

// Plan49 C49-M5b — map escalation levels to WIENER threshold tiers.
// Undefined level (e.g. 'normal') → no telemetry emit.
const WIENER_THRESHOLD_BY_LEVEL: Partial<Record<import('./escalation-types.js').EscalationLevel, 'L2' | 'L3'>> = {
  watch: 'L2',
  warning: 'L2',
  critical: 'L3',
};

/**
 * L3 Safety Gate plugin-level configuration (extends SafetyGateConfig with snapshot).
 * Snapshot field enables CC-2 Option B cross-session state restoration.
 */
export interface SpcSafetyGateConfig extends SafetyGateConfig {
  /** Restore from persisted snapshot (CC-2 Option B). */
  readonly snapshot?: unknown;
}

/**
 * SPC Monitor plugin configuration (Plan45 expansion).
 * Backward compatible: existing fields unchanged, new fields optional.
 */
export interface SpcMonitorConfig {
  /** Enable SPC monitoring. Default: true (operational when shadow events exist). */
  readonly enabled?: boolean;
  /** Rolling window size for Shewhart chart. Default: 50. */
  readonly windowSize?: number;
  /** L2 Escalation Monitor configuration. NEW in Plan45. */
  readonly escalation?: EscalationConfig;
  /** L3 Safety Gate configuration. NEW in Plan45. Default: disabled. */
  readonly safetyGate?: SpcSafetyGateConfig;
}

export function createSpcMonitorPlugin(config?: SpcMonitorConfig): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/spc-monitor',
      version: '0.1.0-alpha',
      description: 'Statistical Process Control monitor for Phase 3 shadow decisions (D-30-6)',
      skandha: ['vijnana'],  // 識蘊 — monitoring/observation
    },
    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const enabled = config?.enabled ?? true;
      if (!enabled) {
        return { dispose: () => {} };
      }

      // L1: Shewhart chart (Plan44)
      const chart = new ShewhartChart(config?.windowSize ?? 50);

      // L2: Escalation monitor (Plan45 W1-1)
      const escalationMonitor = new EscalationMonitor(config?.escalation);

      // L3: Safety gate (Plan45 W1-2, CC-2 Option B)
      const safetyGatePluginConfig = config?.safetyGate;
      let safetyGate: SafetyGate;
      if (safetyGatePluginConfig?.snapshot !== undefined) {
        // Plan47 C47-K3-M5 dual-path resolution:
        //   K-3 onRestore is the authoritative restore path (cold-start winner).
        //   config.safetyGate.snapshot is the Plan45 cold-start path, now
        //   DEPRECATED in Plan47 and scheduled for removal in Plan48.
        //   When both are supplied, K-3 onRestore called by the framework
        //   after factory returns will overwrite this cold-start state.
        console.warn(
          '[spc-monitor] config.safetyGate.snapshot is DEPRECATED (Plan47 C47-K3-M5); ' +
          'use the framework K-3 onRestore path (CheckpointManager.restore). ' +
          'This config-level cold-start path is scheduled for removal in Plan48.',
        );
        safetyGate = SafetyGate.fromSnapshot(safetyGatePluginConfig.snapshot, safetyGatePluginConfig);
      } else {
        safetyGate = new SafetyGate(safetyGatePluginConfig);
      }

      // Subscribe to shadow decision events (W2-1, Plan44)
      // Also: increment L3 shadow-decision counter (§2.3)
      const unsubShadow = ctx.bus.on('audit:shadow_decision', (event) => {
        const record = event.payload as ShadowDecisionRecord;
        if (!record || typeof record.category !== 'string') return;

        // L3: increment shadow-decision counter (§2.3 note 2)
        safetyGate.recordShadowDecision();

        // L1: Shewhart anomaly detection
        const anomaly = chart.addDataPoint(record);
        if (anomaly) {
          // W2-3: emit anomaly event (informational ONLY, C44-5)
          ctx.bus.emit({
            type: 'audit:spc_anomaly',
            timestamp: Date.now(),
            payload: anomaly,
          });
        }
      });

      // L2: Subscribe to SPC anomaly events; escalate and emit level changes
      const unsubAnomaly = ctx.bus.on('audit:spc_anomaly', (event) => {
        const anomaly = event.payload as import('./shewhart-chart.js').SpcAnomaly;
        if (!anomaly || typeof anomaly.category !== 'string') return;

        const escalationEvent = escalationMonitor.processAnomaly(anomaly);
        if (escalationEvent) {
          ctx.bus.emit({
            type: 'audit:spc_escalation',
            timestamp: Date.now(),
            payload: escalationEvent,
          });

          // Plan49 C49-M5b — producer-side WIENER telemetry. Emit alongside the
          // existing audit:spc_escalation so external consumers (Plan48
          // structured-log + audit-sink, SPC dashboards, Plan51+ re-calibration
          // tooling) can observe L2/L3 traversals without subscribing to the
          // spc-specific event shape. No threshold VALUE changes (C49-M5e).
          const threshold = WIENER_THRESHOLD_BY_LEVEL[escalationEvent.currentLevel];
          if (threshold !== undefined) {
            ctx.bus.emit({
              type: 'wiener_threshold_hit',
              timestamp: Date.now(),
              payload: {
                threshold,
                level: escalationEvent.currentLevel,
                previousLevel: escalationEvent.previousLevel,
                category: escalationEvent.category,
                anomalyCount: escalationEvent.anomalyCount,
                windowMs: escalationEvent.windowMs,
                nAtHit: escalationEvent.anomalyCount,
              },
            });
          }
        }
      });

      // L3: Subscribe to escalation events; trigger safety gate if critical
      const unsubEscalation = ctx.bus.on('audit:spc_escalation', (event) => {
        const escalationEvent = event.payload as import('./escalation-types.js').EscalationEvent;
        if (!escalationEvent || escalationEvent.currentLevel !== 'critical') return;

        const safetyGateEvent = safetyGate.checkEscalation(escalationMonitor);
        if (safetyGateEvent) {
          // Emit audit event for external observers
          ctx.bus.emit({
            type: 'audit:spc_safety_gate',
            timestamp: Date.now(),
            payload: safetyGateEvent,
          });

          // Push system_event to trigger DynamicArbiter.forceNextGear()
          ctx.pushInput({
            source: 'spc-monitor',
            inputType: 'system_event',
            data: {
              event: 'safety:force_conservative_gear',
              forceGear: safetyGateEvent.forceGear,
              reason: safetyGateEvent.reason,
            },
          });
        }
      });

      // Plan47 C47-K3-M1 + M4 — factory-level K-3 composite bridge.
      // Returns a single PluginSnapshot covering safetyGate + shewhartChart +
      // escalationMonitor so the framework CheckpointManager sees one hook per
      // plugin name (matches capturePluginHooks keying convention in
      // apps/runner/src/utils/tool-filter-proxy.ts).
      const onCheckpoint = (): PluginSnapshot => captureSpcMonitorComposite({
        safetyGate,
        shewhartChart: chart,
        escalationMonitor,
      });
      const onRestore = (snapshot: PluginSnapshot): void => applySpcMonitorComposite(
        snapshot,
        { safetyGate, shewhartChart: chart, escalationMonitor },
        { safetyGateConfig: safetyGatePluginConfig, escalationConfig: config?.escalation },
      );

      return {
        onCheckpoint,
        onRestore,
        dispose: () => {
          unsubShadow();
          unsubAnomaly();
          unsubEscalation();
          chart.reset();
          escalationMonitor.reset();
          safetyGate.reset();
        },
      };
    },
  };
}

export default createSpcMonitorPlugin;
