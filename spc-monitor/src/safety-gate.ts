/**
 * safety-gate — L3 Emergency Safety Gate for WIENER safety framework (CC-2 Option B).
 * Opt-in (enabled=false by default, D9-Q28).
 * Dual-guard AND cooldown: both shadowDecisionsSinceTrigger and msSinceTrigger
 * must satisfy their respective thresholds before re-trigger (§2).
 * All cooldown values are HYPOTHESIS (Rule #59).
 * @see Plan45 W1-2, §1.2, §1.11, §2
 */

import type { EscalationMonitor } from './escalation-monitor.js';
import type { PluginSnapshot } from '@openstarry/sdk';
import type {
  SafetyGateConfig,
  SafetyGateEvent,
  SafetyGateSnapshot,
} from './escalation-types.js';

/** Plugin name used in PluginSnapshot for SafetyGate checkpoint/restore (Plan46 W2). */
export const SAFETY_GATE_PLUGIN_NAME = 'spc-safety-gate';

// HYPOTHESIS defaults (Rule #59)
const DEFAULT_CRITICAL_THRESHOLD = 2;
/** HYPOTHESIS (Rule #59, per D9-Q27) — to be calibrated with R10+ operational data. */
const DEFAULT_COOLDOWN_SHADOW_DECISIONS = 50;
/** HYPOTHESIS (Rule #59) — to be calibrated with R10+ operational data. */
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_FORCE_GEAR = 1;

export class SafetyGate {
  private readonly enabled: boolean;
  private readonly criticalCategoryThreshold: number;
  private readonly cooldownShadowDecisions: number;
  private readonly cooldownMs: number;
  private readonly forceGear: number;

  // CC-2 Option B internal state
  // lastTriggerMs = -1 means never triggered (distinct from epoch ms=0)
  private lastTriggerMs: number = -1;
  private shadowDecisionsSinceTrigger: number = 0;

  constructor(config?: SafetyGateConfig) {
    this.enabled = config?.enabled ?? false;
    this.criticalCategoryThreshold = config?.criticalCategoryThreshold ?? DEFAULT_CRITICAL_THRESHOLD;
    this.cooldownShadowDecisions = config?.cooldownShadowDecisions ?? DEFAULT_COOLDOWN_SHADOW_DECISIONS;
    this.cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.forceGear = config?.forceGear ?? DEFAULT_FORCE_GEAR;
  }

  /**
   * Check whether L3 gate should trigger given current escalation state.
   * Returns SafetyGateEvent if triggered, null otherwise.
   *
   * Dual-guard AND logic (§2):
   *   re-trigger allowed ONLY WHEN:
   *     shadowDecisionsSinceTrigger >= cooldownShadowDecisions
   *     AND msSinceTrigger >= cooldownMs
   */
  checkEscalation(escalation: EscalationMonitor): SafetyGateEvent | null {
    if (!this.enabled) return null;

    const now = Date.now();

    // Dual-guard AND cooldown check (only applied after first trigger)
    if (this.lastTriggerMs >= 0) {
      // Previously triggered: both guards must be satisfied
      const msSinceTrigger = now - this.lastTriggerMs;
      const shadowReady = this.shadowDecisionsSinceTrigger >= this.cooldownShadowDecisions;
      const timeReady = msSinceTrigger >= this.cooldownMs;
      if (!(shadowReady && timeReady)) {
        return null;
      }
    }
    // lastTriggerMs === -1: never triggered, no cooldown needed

    // Get non-monitoringOnly critical categories (Rule #55, Rule #57)
    const criticalCats = escalation.getCriticalCategories();

    if (criticalCats.length < this.criticalCategoryThreshold) {
      return null;
    }

    // Trigger: record timestamp (always >= 0 for epoch ms)
    this.lastTriggerMs = now;
    this.shadowDecisionsSinceTrigger = 0;

    const reason =
      `L3 gate triggered: ${criticalCats.length} critical categories` +
      ` [${criticalCats.join(', ')}] >= threshold ${this.criticalCategoryThreshold}`;

    return {
      triggered: true,
      criticalCategories: criticalCats,
      forceGear: this.forceGear,
      cooldownShadowDecisions: this.cooldownShadowDecisions,
      cooldownMs: this.cooldownMs,
      timestamp: now,
      reason,
    };
  }

  /**
   * Increment shadow-decision counter (call on every audit:shadow_decision event).
   * Counter resets to 0 on L3 trigger to enforce cooldown.
   */
  recordShadowDecision(): void {
    this.shadowDecisionsSinceTrigger++;
  }

  /** Serialize state for CC-2 Option B cross-session continuity. */
  serialize(): SafetyGateSnapshot {
    return {
      schemaVersion: 1,
      // Snapshot convention: 0 = never triggered (internal -1 mapped to 0)
      lastTriggerMs: this.lastTriggerMs < 0 ? 0 : this.lastTriggerMs,
      shadowDecisionsSinceTrigger: this.shadowDecisionsSinceTrigger,
    };
  }

  /**
   * Restore SafetyGate from a serialized snapshot.
   * Validates schemaVersion === 1; throws for unknown versions (Plan46 migration guard).
   */
  static fromSnapshot(snapshot: unknown, config?: SafetyGateConfig): SafetyGate {
    if (
      snapshot === null ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot)
    ) {
      throw new Error('SafetyGate.fromSnapshot: snapshot must be a non-null object');
    }

    const snap = snapshot as Record<string, unknown>;

    if (snap['schemaVersion'] !== 1) {
      throw new Error(
        `SafetyGate.fromSnapshot: unknown schemaVersion ${String(snap['schemaVersion'])}` +
        ' (expected 1); migration required',
      );
    }

    if (typeof snap['lastTriggerMs'] !== 'number') {
      throw new Error('SafetyGate.fromSnapshot: lastTriggerMs must be a number');
    }
    if (typeof snap['shadowDecisionsSinceTrigger'] !== 'number') {
      throw new Error('SafetyGate.fromSnapshot: shadowDecisionsSinceTrigger must be a number');
    }

    const gate = new SafetyGate(config);
    const snapshotLastTrigger = snap['lastTriggerMs'] as number;
    // Snapshot convention: 0 = never triggered; map back to internal -1 sentinel
    gate.lastTriggerMs = snapshotLastTrigger === 0 ? -1 : snapshotLastTrigger;
    gate.shadowDecisionsSinceTrigger = snap['shadowDecisionsSinceTrigger'] as number;
    return gate;
  }

  /** Reset all state. */
  reset(): void {
    this.lastTriggerMs = -1;
    this.shadowDecisionsSinceTrigger = 0;
  }

  /**
   * Plan46 W2 — K-3 PluginHooks.onCheckpoint adapter.
   * Wraps serialize() in a PluginSnapshot envelope with pluginName +
   * schemaVersion so the CheckpointManager can restore by name.
   */
  onCheckpoint(): PluginSnapshot {
    const snap = this.serialize();
    return {
      pluginName: SAFETY_GATE_PLUGIN_NAME,
      schemaVersion: snap.schemaVersion,
      state: {
        lastTriggerMs: snap.lastTriggerMs,
        shadowDecisionsSinceTrigger: snap.shadowDecisionsSinceTrigger,
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Plan46 W2 — K-3 PluginHooks.onRestore adapter.
   * Validates pluginName + schemaVersion then delegates to fromSnapshot().
   * Mutates this instance's state in place (restore semantics).
   */
  onRestore(snapshot: PluginSnapshot): void {
    if (snapshot.pluginName !== SAFETY_GATE_PLUGIN_NAME) {
      throw new Error(
        `SafetyGate.onRestore: pluginName mismatch (${snapshot.pluginName} !== ${SAFETY_GATE_PLUGIN_NAME})`,
      );
    }
    const inner: SafetyGateSnapshot = {
      schemaVersion: snapshot.schemaVersion as 1,
      lastTriggerMs: snapshot.state['lastTriggerMs'] as number,
      shadowDecisionsSinceTrigger: snapshot.state['shadowDecisionsSinceTrigger'] as number,
    };
    // Delegate to existing validator; mutate this instance to match.
    const restored = SafetyGate.fromSnapshot(inner);
    this.lastTriggerMs = (restored as unknown as { lastTriggerMs: number }).lastTriggerMs;
    this.shadowDecisionsSinceTrigger = (restored as unknown as { shadowDecisionsSinceTrigger: number }).shadowDecisionsSinceTrigger;
  }
}
