/**
 * escalation-types — Frozen type definitions for L2 Escalation Monitor and L3 Safety Gate.
 * All threshold values are HYPOTHESIS (Rule #59).
 * @see Plan45 §1.1, §1.2, §1.11
 */

// ─── L2 Escalation Monitor Types ─────────────────────────────────────────────

/**
 * L2 escalation severity levels.
 * Transitions: normal -> watch -> warning -> critical (and in reverse via window decay).
 * HYPOTHESIS thresholds (Rule #59): watch=2, warning=4, critical=7 within 5-min window.
 */
export type EscalationLevel = 'normal' | 'watch' | 'warning' | 'critical';

/**
 * Per-category escalation snapshot.
 * monitoringOnly = true when category is destructive or state_modifying
 * (Rule #55, Rule #57: destructive NEVER triggers L3).
 */
export interface CategoryEscalation {
  readonly category: string;
  readonly level: EscalationLevel;
  readonly anomalyCount: number;       // count within active time window
  readonly windowStartMs: number;      // epoch ms of window open edge
  readonly lastAnomalyMs: number;      // epoch ms of most recent anomaly
  readonly monitoringOnly: boolean;    // true = never contributes to L3 trigger
}

/**
 * Event payload emitted as audit:spc_escalation when a category's level changes.
 * Consumer: L3 SafetyGate, external observers.
 */
export interface EscalationEvent {
  readonly category: string;
  readonly previousLevel: EscalationLevel;
  readonly currentLevel: EscalationLevel;
  readonly anomalyCount: number;
  readonly windowMs: number;
  readonly timestamp: number;         // epoch ms
}

/**
 * L2 Escalation Monitor configuration.
 * All fields optional; all defaults are HYPOTHESIS values (Rule #59).
 */
export interface EscalationConfig {
  /** Sliding window duration in milliseconds. Default: 300000 (5 min). HYPOTHESIS. */
  readonly windowMs?: number;
  /** Anomaly count thresholds for level transitions. All values HYPOTHESIS (Rule #59). */
  readonly thresholds?: {
    readonly watch?: number;     // Default: 2
    readonly warning?: number;   // Default: 4
    readonly critical?: number;  // Default: 7
  };
}

// ─── L3 Safety Gate Types ─────────────────────────────────────────────────────

/**
 * L3 Emergency Safety Gate configuration.
 * Default enabled=false: opt-in required (D9-Q28).
 * Cooldown = shadow-decision count (see §2 for resolution).
 */
export interface SafetyGateConfig {
  /** Enable L3 safety gate. Default: false (opt-in, D9-Q28). */
  readonly enabled?: boolean;
  /**
   * Number of L2 'critical'-level categories that must be simultaneously active
   * to trigger the gate. Default: 2. HYPOTHESIS.
   */
  readonly criticalCategoryThreshold?: number;
  /**
   * Cooldown expressed as minimum number of shadow decisions after a gate trigger
   * before re-evaluation is permitted. Default: 50. HYPOTHESIS (D9-Q27).
   *
   * Both shadowDecisionsSinceTrigger >= cooldownShadowDecisions AND
   * msSinceTrigger >= cooldownMs must hold before re-trigger (AND logic, §2).
   */
  readonly cooldownShadowDecisions?: number;  // Default: 50 (HYPOTHESIS, D9-Q27)
  /**
   * Secondary wall-clock cooldown guard in milliseconds. Default: 60000 (1 min).
   * Applied with AND logic: BOTH guards must pass before re-trigger.
   */
  readonly cooldownMs?: number;               // Default: 60000
  /**
   * Gear to force when gate triggers. Default: 1 (most conservative).
   * MUST be <= current gear at trigger time (conservative-only, D9-Q29).
   * Enforced by DynamicArbiter.forceNextGear(): if forceGear > currentGear, no-op.
   */
  readonly forceGear?: number;
}

/**
 * Event payload emitted as audit:spc_safety_gate when L3 gate fires.
 * Consumer: external observers, audit trail.
 * L3 force-gear action is executed via pushInput, NOT via this event directly.
 */
export interface SafetyGateEvent {
  readonly triggered: boolean;
  readonly criticalCategories: readonly string[];
  readonly forceGear: number;
  readonly cooldownShadowDecisions: number;
  readonly cooldownMs: number;
  readonly timestamp: number;       // epoch ms
  readonly reason: string;          // human-readable trigger description
}

/**
 * Serializable state for SafetyGate (CC-2 Option B).
 * Pattern: Plan44 Fix 12c StateTracker.serialize()/fromSnapshot().
 * Schema version must be included for future forward-compat (§5 Risk).
 */
export interface SafetyGateSnapshot {
  readonly schemaVersion: 1;                   // increment if schema changes
  readonly lastTriggerMs: number;              // epoch ms of last trigger (0 = never)
  readonly shadowDecisionsSinceTrigger: number; // count since last trigger
}
