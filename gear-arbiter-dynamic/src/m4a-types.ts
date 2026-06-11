/**
 * m4a-types — Phase 3 M4a schema (Rule #59 dual-track).
 * All fields readonly per OpenStarry convention.
 * @see Plan44 W1-2, W1-3
 */

/** Snapshot of StateTracker state at time of shadow decision. */
export interface TrackerSnapshot {
  readonly totalObs: number;
  readonly recentDeltaMean: number;
  readonly currentGear: number;
  readonly dwellCounter: number;
}

/** Per-event shadow decision record (W1-2). */
export interface ShadowDecisionRecord {
  readonly timestamp: number;
  readonly category: string;
  readonly shadowGear: number;
  readonly actualGear: number;
  readonly agrees: boolean;
  readonly deviation: number;
  readonly monitoringOnly: boolean;
  readonly trackerSnapshot: TrackerSnapshot;
  readonly computeTimeMs: number;
}

/** Per-category M4a aggregate (W1-3). */
export interface M4aCategoryRecord {
  readonly category: string;
  readonly totalDecisions: number;
  readonly agreements: number;
  readonly disagreements: number;
  readonly agreementRate: number;
  readonly meanDeviation: number;
  readonly monitoringOnly: boolean;
  /** HYPOTHESIS label (NOT numeric comparison). All thresholds labeled HYPOTHESIS (AC-W1-5). */
  readonly hypothesisThreshold: string;
}

/** Per-round M4a aggregate report (W1-3). */
export interface M4aReport {
  readonly roundId: string;
  readonly timestamp: number;
  readonly categories: readonly M4aCategoryRecord[];
  readonly aggregateAgreementRate: number;
  readonly shadowDecisionCount: number;
}

/**
 * Shadow computation configuration for CalibrationBridge.
 * Decouples bridge from DynamicArbiter's internal state.
 */
export interface ShadowConfig {
  readonly enabled: boolean;
  readonly getArbiterState: () => { readonly gear: number; readonly dwell: number };
  readonly onShadowDecision: (record: ShadowDecisionRecord) => void;
}
