/** calibration-bridge — feeds audit:tool_audited clampedDelta to StateTracker + Phase 3 shadow. */

import type { EventBus, RiskCategory } from '@openstarry/sdk';
import type { StateTracker } from './state-tracker.js';
import type { ShadowConfig, ShadowDecisionRecord, TrackerSnapshot } from './m4a-types.js';
import { computeShadowDecision } from './shadow-decision.js';
import { isMonitoringOnly } from './m4a-aggregator.js';
import type { PerturbationConfig } from './perturbation-diagnostic.js';
import { computePerturbationDiagnostic } from './perturbation-diagnostic.js';
import type { ContextDeltaProvider } from './context-delta-provider.js';

export const DELTA_SCALING_FACTOR = 0.055;

export const TOOL_CONFIDENCE_TABLE: Readonly<Record<RiskCategory, number>> = {
  destructive: 0.85, state_modifying: 0.75, read_only: 0.50, informational: 0.001,
};

/** Logging interface for testable output (COND-1, Plan43). */
export interface ILogger {
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Default logger delegating to console (backward compatible). Uses .bind to prevent this-rebinding. */
export const DEFAULT_LOGGER: ILogger = {
  warn: console.warn.bind(console),
  info: console.info.bind(console),
  error: console.error.bind(console),
};

export class CalibrationBridge {
  private unsub: (() => void) | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly tracker: StateTracker,
    private readonly logger: ILogger = DEFAULT_LOGGER,
    private readonly shadowConfig?: ShadowConfig,
    /** Plan45 W2-1: perturbation diagnostic config (output-only, no main-path change). */
    private readonly perturbationConfig?: PerturbationConfig,
    /** Plan45 W2-2: context-dependent delta provider (identity when disabled). */
    private readonly contextDeltaProvider?: ContextDeltaProvider,
  ) {}

  start(): void {
    this.unsub = this.bus.on('audit:tool_audited', (event) => {
      const p = event.payload as Record<string, unknown> | undefined;
      if (!p) {
        this.logger.warn('[gear-arbiter-dynamic] audit:tool_audited missing or invalid payload');
        return;
      }

      const delta = p['clampedDelta'];
      const category = p['inferredRiskCategory'] as string | undefined;

      if (typeof delta !== 'number') {
        this.logger.warn('[gear-arbiter-dynamic] audit:tool_audited missing clampedDelta', { keys: Object.keys(p) });
        return;
      }

      // Plan45 W2-2: apply context-dependent delta correction before recording.
      // When contextDeltaProvider is undefined or disabled it is an identity fn.
      const correctedDelta = this.contextDeltaProvider
        ? this.contextDeltaProvider(category ?? '', delta)
        : delta;

      this.tracker.recordDelta(correctedDelta);
      if (category) {
        this.tracker.recordObservation(category);
      } else {
        this.logger.warn('[gear-arbiter-dynamic] audit:tool_audited missing inferredRiskCategory');
      }
      if (p['executionResult']) this.tracker.recordOutcome(1, p['executionResult'] === 'success');

      // Phase 3 shadow computation (Plan44 W1-4, AC-W1-8: fires AFTER recording delta)
      if (this.shadowConfig?.enabled && category) {
        this.fireShadow(category);
      }
    });
  }

  /** Phase 3 shadow: compute, compare, record (W1-4, W1-7). */
  private fireShadow(category: string): void {
    const t0 = performance.now();
    const deltas = this.tracker.getRecentDeltas();
    const totalObs = this.tracker.getTotalObservations();
    const { gear, dwell } = this.shadowConfig!.getArbiterState();
    const { shadowGear, abstains } = computeShadowDecision(deltas, totalObs, gear, dwell);
    const computeTimeMs = performance.now() - t0;

    if (abstains) return; // No shadow record during observe mode

    const snapshot: TrackerSnapshot = {
      totalObs,
      recentDeltaMean: deltas.length > 0
        ? deltas.reduce((a, b) => a + b, 0) / deltas.length
        : 0,
      currentGear: gear,
      dwellCounter: dwell,
    };

    const record: ShadowDecisionRecord = {
      timestamp: Date.now(),
      category,
      shadowGear,
      actualGear: gear,
      agrees: shadowGear === gear,
      deviation: Math.abs(shadowGear - gear),
      monitoringOnly: isMonitoringOnly(category),
      trackerSnapshot: snapshot,
      computeTimeMs,
    };

    this.shadowConfig!.onShadowDecision(record);

    // Plan45 W2-1: perturbation diagnostic (output-only, no main-path change).
    // Runs AFTER shadow decision is recorded so it never affects the normal path.
    if (this.perturbationConfig?.enabled) {
      const diagnostic = computePerturbationDiagnostic(deltas, totalObs, gear, dwell, category);
      if (diagnostic.sensitive) {
        this.perturbationConfig.onDiagnostic?.(diagnostic);
        // Emit via bus for external observers (audit trail).
        // Bus is accessible as this.bus (constructor parameter).
        this.bus.emit({
          type: 'audit:perturbation_diagnostic',
          timestamp: Date.now(),
          payload: diagnostic,
        });
      }
    }
  }

  stop(): void { this.unsub?.(); this.unsub = null; }
}
