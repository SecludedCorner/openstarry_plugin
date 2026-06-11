/** gear-arbiter-dynamic — WIENER adaptive gear arbiter. @skandha samskara, vijnana @see Plan41 CV-5 */

import type { IPlugin, IPluginContext, PluginHooks, PluginSnapshot } from '@openstarry/sdk';
import { StateTracker } from './state-tracker.js';
import type { StateTrackerSnapshot } from './state-tracker.js';

/**
 * Plugin name used in PluginSnapshot for gear-arbiter-dynamic composite
 * checkpoint/restore (Plan47 C47-K3-M2). Matches manifest.name so the
 * framework hookMap key and snapshot.pluginName agree.
 */
export const GEAR_ARBITER_DYNAMIC_PLUGIN_NAME = '@openstarry-plugin/gear-arbiter-dynamic';

/** Composite schema version for the factory-level PluginSnapshot (Plan47). */
export const GEAR_ARBITER_DYNAMIC_COMPOSITE_SCHEMA_VERSION = 1;
import { CalibrationBridge } from './calibration-bridge.js';
import { DynamicArbiter } from './dynamic-arbiter.js';
import type { Phase3Config } from './dynamic-arbiter.js';
import { M4aAggregator } from './m4a-aggregator.js';
import type { ShadowConfig } from './m4a-types.js';
import type { PerturbationConfig } from './perturbation-diagnostic.js';
import type { ContextDeltaConfig } from './context-delta-provider.js';
import { createContextDeltaProvider } from './context-delta-provider.js';

export interface GearArbiterDynamicConfig {
  readonly minSamples?: number;
  /** Cold-start gear (COND-4, Plan43). contextDependent: true */
  readonly coldStartGear?: 1 | 2 | 3;
  /** Phase 3 shadow decision config (Plan44 W1-5). Default: { enabled: false } */
  readonly phase3?: Phase3Config;
  /**
   * Restore calibration state from a previous cycle (Plan44 hotfix).
   * When provided, the StateTracker is initialized from this snapshot instead of empty.
   * Enables totalObs to accumulate across core restarts, allowing shadow computation
   * to activate after MIN_N=10 observations.
   */
  readonly calibrationState?: StateTrackerSnapshot;
  /**
   * Perturbation diagnostic configuration (Plan45 W2-1).
   * Requires phase3.enabled=true (perturbation runs inside fireShadow).
   * Default: { enabled: false }
   */
  readonly perturbation?: PerturbationConfig;
  /**
   * Context-dependent delta correction configuration (Plan45 W2-2).
   * Default: { enabled: false } — identity, no behavioral change.
   */
  readonly contextDelta?: ContextDeltaConfig;
}

export function createGearArbiterDynamicPlugin(config?: GearArbiterDynamicConfig): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/gear-arbiter-dynamic',
      version: '0.1.0-alpha',
      description: 'WIENER control theory adaptive gear arbiter (CV-5)',
      skandha: ['samskara', 'vijnana'],  // FAIL-4 fix: samskara (行蘊) not samjna
    },
    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      // Restore tracker from saved state if provided, otherwise start fresh
      const tracker = config?.calibrationState
        ? StateTracker.fromSnapshot(config.calibrationState)
        : new StateTracker();
      const phase3Enabled = config?.phase3?.enabled ?? false;
      const phase3Config: Phase3Config = { enabled: phase3Enabled };

      // AC-CV5-10: audit callback emits state transitions via pushInput
      const onTransition = (payload: object) => ctx.pushInput({
        source: 'gear-arbiter-dynamic', inputType: 'system_event',
        data: { event: 'gear:transition', ...payload },
      });

      const arbiter = new DynamicArbiter({
        stateTracker: tracker,
        onTransition,
        initialGear: config?.coldStartGear,
        phase3Config,
      });

      // Phase 3: M4a aggregator + shadow config (Plan44 W1-4, W1-6)
      const m4a = new M4aAggregator();
      const shadowConfig: ShadowConfig | undefined = phase3Enabled ? {
        enabled: true,
        getArbiterState: () => arbiter.getState(),
        onShadowDecision: (record) => {
          m4a.append(record);
          // W1-6: emit via audit trail (AC-W1-10)
          ctx.bus.emit({
            type: 'audit:shadow_decision',
            timestamp: Date.now(),
            payload: record,
          });
        },
      } : undefined;

      // Plan45 W2-2: build context delta provider from config (identity when disabled/absent)
      const contextDeltaProvider = createContextDeltaProvider(config?.contextDelta ?? { enabled: false });

      // Plan45 W2-1: perturbation config (passed through to CalibrationBridge)
      const perturbationConfig = config?.perturbation;

      const bridge = new CalibrationBridge(
        ctx.bus,
        tracker,
        undefined,
        shadowConfig,
        perturbationConfig,
        contextDeltaProvider,
      );
      bridge.start();

      // Plan45 W1-3b: subscribe to L3 safety gate system_event → forceNextGear
      const unsubSafetyEvent = ctx.bus.on('input:received', (event) => {
        const payload = event.payload as {
          source?: string;
          inputType?: string;
          data?: { event?: string; forceGear?: unknown };
        } | undefined;
        if (
          payload?.source === 'spc-monitor' &&
          payload?.inputType === 'system_event' &&
          payload?.data?.event === 'safety:force_conservative_gear' &&
          typeof payload?.data?.forceGear === 'number'
        ) {
          arbiter.forceNextGear(payload.data.forceGear);
        }
      });

      // Plan47 C47-K3-M2 — factory-level K-3 bridge. Delegates to the
      // StateTracker hooks (already K-3-compliant since Plan46) but wraps
      // the PluginSnapshot envelope under the manifest name so the framework
      // hookMap key and snapshot.pluginName align (required by the runner-side
      // capturePluginHooks → CheckpointManager.restore flow).
      const onCheckpoint = (): PluginSnapshot => {
        const inner = tracker.onCheckpoint();
        return {
          pluginName: GEAR_ARBITER_DYNAMIC_PLUGIN_NAME,
          schemaVersion: GEAR_ARBITER_DYNAMIC_COMPOSITE_SCHEMA_VERSION,
          state: {
            stateTracker: {
              schemaVersion: inner.schemaVersion,
              rates: inner.state['rates'],
              deltas: inner.state['deltas'],
              categoryCounts: inner.state['categoryCounts'],
            },
          },
          timestamp: Date.now(),
        };
      };

      const onRestore = (snapshot: PluginSnapshot): void => {
        if (snapshot.pluginName !== GEAR_ARBITER_DYNAMIC_PLUGIN_NAME) {
          throw new Error(
            `gear-arbiter-dynamic.onRestore: pluginName mismatch ` +
            `(${snapshot.pluginName} !== ${GEAR_ARBITER_DYNAMIC_PLUGIN_NAME})`,
          );
        }
        if (snapshot.schemaVersion !== GEAR_ARBITER_DYNAMIC_COMPOSITE_SCHEMA_VERSION) {
          throw new Error(
            `gear-arbiter-dynamic.onRestore: unsupported composite schemaVersion ` +
            `${snapshot.schemaVersion} (expected ${GEAR_ARBITER_DYNAMIC_COMPOSITE_SCHEMA_VERSION})`,
          );
        }
        const sub = snapshot.state['stateTracker'];
        if (!sub || typeof sub !== 'object') {
          throw new Error('gear-arbiter-dynamic.onRestore: missing stateTracker sub-section');
        }
        const trackerSnap = sub as Record<string, unknown>;
        // Delegate to StateTracker.onRestore via its own pluginName envelope —
        // the in-place mutate-fields pattern (KERNEL §2.2 recommended) keeps
        // the arbiter's tracker reference valid across restore.
        tracker.onRestore({
          pluginName: 'state-tracker',
          schemaVersion: trackerSnap['schemaVersion'] as number,
          state: {
            rates: trackerSnap['rates'],
            deltas: trackerSnap['deltas'],
            categoryCounts: trackerSnap['categoryCounts'],
          },
          timestamp: Date.now(),
        });
      };

      return {
        gearArbiters: [arbiter],
        onCheckpoint,
        onRestore,
        dispose: () => {
          unsubSafetyEvent();
          bridge.stop();
          // Emit final calibration state for persistence (consumers can save to disk)
          ctx.bus.emit({
            type: 'calibration:state_snapshot',
            timestamp: Date.now(),
            payload: { trackerState: tracker.serialize() },
          });
        },
      };
    },
  };
}

export { StateTracker } from './state-tracker.js';
export type { StateTrackerSnapshot } from './state-tracker.js';
export { CalibrationBridge, DELTA_SCALING_FACTOR, TOOL_CONFIDENCE_TABLE } from './calibration-bridge.js';
export type { ILogger } from './calibration-bridge.js';
export { DEFAULT_LOGGER } from './calibration-bridge.js';
export { DynamicArbiter } from './dynamic-arbiter.js';
export type { DynamicArbiterOptions, Phase3Config } from './dynamic-arbiter.js';
export { computeShadowDecision } from './shadow-decision.js';
export { M4aAggregator, isMonitoringOnly } from './m4a-aggregator.js';
export type { TrackerSnapshot, ShadowDecisionRecord, M4aCategoryRecord, M4aReport, ShadowConfig } from './m4a-types.js';
export { computePerturbationDiagnostic } from './perturbation-diagnostic.js';
export type { PerturbationResult, PerturbationDiagnostic, PerturbationConfig } from './perturbation-diagnostic.js';
export { createContextDeltaProvider, DEFAULT_CATEGORY_FACTORS } from './context-delta-provider.js';
export type { ContextDeltaConfig, ContextDeltaProvider } from './context-delta-provider.js';
export default createGearArbiterDynamicPlugin;
