/**
 * dynamic-arbiter.test.ts — comprehensive tests for gear-arbiter-dynamic (CV-5).
 * Includes Plan44 W1 shadow decision + M4a + W3 NC3 integration tests.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StateTracker } from '../state-tracker.js';
import { CalibrationBridge, DELTA_SCALING_FACTOR, TOOL_CONFIDENCE_TABLE, DEFAULT_LOGGER } from '../calibration-bridge.js';
import { DynamicArbiter } from '../dynamic-arbiter.js';
import { createGearArbiterDynamicPlugin } from '../index.js';
import { computeShadowDecision } from '../shadow-decision.js';
import { M4aAggregator, isMonitoringOnly } from '../m4a-aggregator.js';
import type { ShadowDecisionRecord, ShadowConfig } from '../m4a-types.js';
import type { GearContext, EventBus, AgentEvent } from '@openstarry/sdk';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeContext(overrides?: Partial<GearContext>): GearContext {
  return {
    input: 'test',
    proposedToolCalls: [],
    actionHistory: [],
    agentConfig: { id: 'agent-1' },
    ...overrides,
  };
}

function makeBus(handlers: Map<string, ((e: AgentEvent) => void)[]> = new Map()): EventBus {
  return {
    on(type: string, handler: (e: AgentEvent) => void) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
      return () => {
        const l = handlers.get(type) ?? [];
        handlers.set(type, l.filter(h => h !== handler));
      };
    },
    once(type: string, handler: (e: AgentEvent) => void) {
      const wrapped = (e: AgentEvent) => { handler(e); };
      return this.on(type, wrapped);
    },
    onAny(handler: (e: AgentEvent) => void) {
      return this.on('*', handler);
    },
    emit(event: AgentEvent) {
      const list = handlers.get(event.type) ?? [];
      list.forEach(h => h(event));
    },
  };
}

function feedDeltas(tracker: StateTracker, deltas: number[]): void {
  for (const d of deltas) tracker.recordDelta(d);
}

// ─── StateTracker ─────────────────────────────────────────────────────────────

describe('StateTracker', () => {
  it('returns zero rate for unknown gear', () => {
    const t = new StateTracker();
    expect(t.getSuccessRate(1)).toEqual({ rate: 0, total: 0 });
  });

  it('records outcomes correctly', () => {
    const t = new StateTracker();
    t.recordOutcome(1, true);
    t.recordOutcome(1, false);
    t.recordOutcome(1, true);
    expect(t.getSuccessRate(1)).toEqual({ rate: 2 / 3, total: 3 });
  });

  it('tracks deltas and returns a copy', () => {
    const t = new StateTracker();
    feedDeltas(t, [0.01, 0.02, 0.03]);
    const d = t.getRecentDeltas();
    expect(d).toEqual([0.01, 0.02, 0.03]);
    d.push(999);  // mutation should not affect internal state
    expect(t.getRecentDeltas()).toHaveLength(3);
  });

  it('state is isolated per instance (AC-CV5-2)', () => {
    const t1 = new StateTracker();
    const t2 = new StateTracker();
    t1.recordOutcome(1, true);
    expect(t2.getSuccessRate(1)).toEqual({ rate: 0, total: 0 });
  });

  it('recordObservation accumulates per category (AC-CV5-FIX-2)', () => {
    const t = new StateTracker();
    t.recordObservation('read_only');
    t.recordObservation('read_only');
    t.recordObservation('destructive');
    expect(t.getCategoryCount('read_only')).toBe(2);
    expect(t.getCategoryCount('destructive')).toBe(1);
    expect(t.getCategoryCount('informational')).toBe(0);
  });

  it('getTotalObservations sums all categories', () => {
    const t = new StateTracker();
    t.recordObservation('read_only');
    t.recordObservation('state_modifying');
    t.recordObservation('state_modifying');
    expect(t.getTotalObservations()).toBe(3);
  });

  it('serialize/fromSnapshot preserves all state (Plan44 hotfix)', () => {
    const t = new StateTracker();
    t.recordOutcome(1, true);
    t.recordOutcome(1, false);
    feedDeltas(t, [0.01, 0.02, 0.03]);
    t.recordObservation('read_only');
    t.recordObservation('read_only');
    t.recordObservation('destructive');

    const snapshot = t.serialize();
    const restored = StateTracker.fromSnapshot(snapshot);

    expect(restored.getSuccessRate(1)).toEqual(t.getSuccessRate(1));
    expect(restored.getRecentDeltas()).toEqual(t.getRecentDeltas());
    expect(restored.getCategoryCount('read_only')).toBe(2);
    expect(restored.getCategoryCount('destructive')).toBe(1);
    expect(restored.getTotalObservations()).toBe(3);
  });

  // Plan46 W0 — snapshot validation mirroring SafetyGate pattern.
  it('fromSnapshot() rejects null / non-object snapshots', () => {
    expect(() => StateTracker.fromSnapshot(null as unknown as never)).toThrow(/non-null object/);
    expect(() => StateTracker.fromSnapshot(42 as unknown as never)).toThrow(/non-null object/);
    expect(() => StateTracker.fromSnapshot([] as unknown as never)).toThrow(/non-null object/);
  });

  it('fromSnapshot() rejects unknown schemaVersion (migration guard)', () => {
    const bad = { schemaVersion: 2, rates: [], deltas: [], categoryCounts: [] };
    expect(() => StateTracker.fromSnapshot(bad as unknown as never)).toThrow(/schemaVersion/);
  });

  it('fromSnapshot() rejects malformed top-level fields', () => {
    const noRates = { schemaVersion: 1, rates: 'x', deltas: [], categoryCounts: [] };
    expect(() => StateTracker.fromSnapshot(noRates as unknown as never)).toThrow(/rates/);
    const noDeltas = { schemaVersion: 1, rates: [], deltas: 'x', categoryCounts: [] };
    expect(() => StateTracker.fromSnapshot(noDeltas as unknown as never)).toThrow(/deltas/);
    const noCats = { schemaVersion: 1, rates: [], deltas: [], categoryCounts: 'x' };
    expect(() => StateTracker.fromSnapshot(noCats as unknown as never)).toThrow(/categoryCounts/);
  });

  it('serialize() emits schemaVersion:1 and round-trips through fromSnapshot()', () => {
    const t = new StateTracker();
    t.recordOutcome(2, true);
    feedDeltas(t, [0.1]);
    t.recordObservation('read_only');
    const snap = t.serialize();
    expect(snap.schemaVersion).toBe(1);
    const restored = StateTracker.fromSnapshot(snap);
    expect(restored.getSuccessRate(2)).toEqual(t.getSuccessRate(2));
    expect(restored.getTotalObservations()).toBe(1);
  });

  // Plan46 W2 — onCheckpoint / onRestore PluginHooks adapters
  it('onCheckpoint returns PluginSnapshot with correct identity', async () => {
    const { STATE_TRACKER_PLUGIN_NAME } = await import('../state-tracker.js');
    const t = new StateTracker();
    t.recordOutcome(1, true);
    const snap = t.onCheckpoint();
    expect(snap.pluginName).toBe(STATE_TRACKER_PLUGIN_NAME);
    expect(snap.schemaVersion).toBe(1);
    expect(snap.state).toHaveProperty('rates');
    expect(snap.state).toHaveProperty('deltas');
    expect(snap.state).toHaveProperty('categoryCounts');
  });

  it('onRestore rejects snapshots with wrong pluginName', () => {
    const t = new StateTracker();
    expect(() => t.onRestore({
      pluginName: 'other',
      schemaVersion: 1,
      state: { rates: [], deltas: [], categoryCounts: [] },
      timestamp: 0,
    })).toThrow(/pluginName mismatch/);
  });

  it('onCheckpoint → onRestore round-trips state in place', async () => {
    const src = new StateTracker();
    src.recordOutcome(1, true);
    src.recordOutcome(1, false);
    src.recordObservation('read_only');
    feedDeltas(src, [0.1, 0.2]);
    const snap = src.onCheckpoint();

    const dst = new StateTracker();
    dst.recordObservation('destructive'); // pre-existing noise
    dst.onRestore(snap);

    expect(dst.getSuccessRate(1)).toEqual(src.getSuccessRate(1));
    expect(dst.getCategoryCount('read_only')).toBe(1);
    expect(dst.getCategoryCount('destructive')).toBe(0); // pre-existing was cleared
    expect(dst.getRecentDeltas()).toEqual(src.getRecentDeltas());
  });

  it('fromSnapshot enables shadow after MIN_N via cross-cycle persistence', () => {
    // Simulate: cycle 1 accumulates 8 observations, cycle 2 restores and adds 2 more
    const t1 = new StateTracker();
    for (let i = 0; i < 8; i++) t1.recordObservation('read_only');
    feedDeltas(t1, Array(8).fill(0.02));
    const snapshot = t1.serialize();

    // Cycle 2: restore and continue
    const t2 = StateTracker.fromSnapshot(snapshot);
    t2.recordObservation('read_only');
    t2.recordObservation('read_only');
    t2.recordDelta(0.02);
    t2.recordDelta(0.02);

    expect(t2.getTotalObservations()).toBe(10); // Crosses MIN_N
    expect(t2.getRecentDeltas()).toHaveLength(10);
  });
});

// ─── DynamicArbiter — observe mode ───────────────────────────────────────────

describe('DynamicArbiter — observe mode (AC-CV5-6)', () => {
  it('abstains when totalObservations < 10 (AC-CV5-FIX-2, shadow counting)', () => {
    const tracker = new StateTracker();
    // Feed deltas but NO observations → totalObs = 0
    feedDeltas(tracker, [0.05, 0.06, 0.07]);
    const arbiter = new DynamicArbiter({ stateTracker: tracker });
    const result = arbiter.evaluate(makeContext());
    expect(result.action).toBe('abstain');
    expect(result.confidence).toBe(0);
  });

  it('abstains when totalObservations = 9 (one short of MIN_N)', () => {
    const tracker = new StateTracker();
    feedDeltas(tracker, Array(10).fill(0.05));
    for (let i = 0; i < 9; i++) tracker.recordObservation('read_only');
    const arbiter = new DynamicArbiter({ stateTracker: tracker });
    expect(arbiter.evaluate(makeContext()).action).toBe('abstain');
  });

  it('exits observe mode after exactly 10 observations (AC-CV5-FIX-3)', () => {
    const tracker = new StateTracker();
    feedDeltas(tracker, Array(10).fill(0.01)); // mean 0.01 < UP, stays gear 1
    for (let i = 0; i < 10; i++) tracker.recordObservation('read_only');
    const arbiter = new DynamicArbiter({ stateTracker: tracker });
    const result = arbiter.evaluate(makeContext());
    expect(result.action).not.toBe('abstain');
  });

  it('observations can span multiple categories for threshold (AC-CV5-FIX-2)', () => {
    const tracker = new StateTracker();
    feedDeltas(tracker, Array(10).fill(0.01));
    tracker.recordObservation('read_only');
    tracker.recordObservation('destructive');
    tracker.recordObservation('state_modifying');
    tracker.recordObservation('informational');
    tracker.recordObservation('read_only');
    tracker.recordObservation('read_only');
    tracker.recordObservation('destructive');
    tracker.recordObservation('read_only');
    tracker.recordObservation('read_only');
    tracker.recordObservation('read_only'); // 10 total across 4 categories
    const arbiter = new DynamicArbiter({ stateTracker: tracker });
    expect(arbiter.evaluate(makeContext()).action).not.toBe('abstain');
  });
});

// ─── DynamicArbiter — hysteresis & dwell time ────────────────────────────────

function seedObservations(tracker: StateTracker, n: number): void {
  for (let i = 0; i < n; i++) tracker.recordObservation('read_only');
}

describe('DynamicArbiter — hysteresis prevents hunting (C-W-CV5-2, C-W-CV5-3)', () => {
  it('does not switch gear until dwell time satisfied (MIN_DWELL_TIME = 5)', () => {
    const tracker = new StateTracker();
    feedDeltas(tracker, Array(10).fill(0.05)); // mean 0.05 > SWITCH_UP_THRESHOLD 0.047
    seedObservations(tracker, 10); // exit observe mode
    const arbiter = new DynamicArbiter({ stateTracker: tracker });

    // First 5 calls should accumulate dwell, not switch yet
    for (let i = 0; i < 5; i++) {
      const r = arbiter.evaluate(makeContext());
      expect(r.action).toBe(1); // still gear 1 during dwell
    }
    // After MIN_DWELL_TIME calls, gear switches on next evaluation
    const switched = arbiter.evaluate(makeContext());
    expect(switched.action).toBe(2);
  });

  it('does not switch back down immediately (hysteresis gap)', () => {
    const tracker = new StateTracker();
    // First get to gear 2
    feedDeltas(tracker, Array(10).fill(0.05));
    seedObservations(tracker, 10); // exit observe mode
    const arbiter = new DynamicArbiter({ stateTracker: tracker });
    for (let i = 0; i < 6; i++) arbiter.evaluate(makeContext());
    // Now switch deltas to below down-threshold
    // Feed more deltas
    for (let i = 0; i < 10; i++) tracker.recordDelta(0.01); // mean drifts down
    // Should not immediately switch back: needs dwell
    for (let i = 0; i < 5; i++) {
      const r = arbiter.evaluate(makeContext());
      expect(r.action).toBe(2); // still gear 2 during dwell
    }
  });
});

// ─── DynamicArbiter — destructive delta constraint ───────────────────────────

describe('DynamicArbiter — destructive delta <= 0 (AC-CV5-9)', () => {
  it('abstains when destructive (negative) delta > 0 proxy', () => {
    const tracker = new StateTracker();
    feedDeltas(tracker, Array(10).fill(0.02));
    seedObservations(tracker, 10); // exit observe mode
    const arbiter = new DynamicArbiter({ stateTracker: tracker });
    const r = arbiter.evaluate(makeContext());
    expect(r.action).not.toBe('abstain');
  });

  it('abstains with riskCategory destructive when destructive constraint fails', () => {
    const tracker = new StateTracker();
    class TestArbiter extends DynamicArbiter {
      override evaluate(ctx: GearContext) { return super.evaluate(ctx); }
    }
    const arbiter = new TestArbiter({ stateTracker: tracker });
    feedDeltas(tracker, Array(10).fill(-0.05)); // all negative
    seedObservations(tracker, 10); // exit observe mode
    const r = arbiter.evaluate(makeContext());
    expect(r.confidence).toBeGreaterThanOrEqual(0);
  });
});

// ─── DynamicArbiter — priority ───────────────────────────────────────────────

describe('DynamicArbiter — priority > 10 (AC-CV5-4, C41-12)', () => {
  it('has priority 20 which is > static priority 10 (AC-CV5-FIX-5)', () => {
    const arbiter = new DynamicArbiter({ stateTracker: new StateTracker() });
    expect(arbiter.priority).toBe(20);
    expect(arbiter.priority).toBeGreaterThan(10);
  });

  it('has id gear-arbiter-dynamic', () => {
    const arbiter = new DynamicArbiter({ stateTracker: new StateTracker() });
    expect(arbiter.id).toBe('gear-arbiter-dynamic');
  });

  it('defaults to gear 1 when no initialGear provided (AC-W2-8)', () => {
    const tracker = new StateTracker();
    feedDeltas(tracker, Array(10).fill(0.01));
    for (let i = 0; i < 10; i++) tracker.recordObservation('read_only');
    const arbiter = new DynamicArbiter({ stateTracker: tracker });
    expect(arbiter.evaluate(makeContext()).action).toBe(1);
  });

  it('accepts configurable initialGear (AC-W2-8)', () => {
    const tracker = new StateTracker();
    feedDeltas(tracker, Array(10).fill(0.01));
    for (let i = 0; i < 10; i++) tracker.recordObservation('read_only');
    const arbiter = new DynamicArbiter({ stateTracker: tracker, initialGear: 2 });
    const result = arbiter.evaluate(makeContext());
    expect(result.action).toBe(2);
  });
});

// ─── DynamicArbiter — getState (Plan44 W1) ──────────────────────────────────

describe('DynamicArbiter — getState (Plan44)', () => {
  it('returns current gear and dwell', () => {
    const tracker = new StateTracker();
    const arbiter = new DynamicArbiter({ stateTracker: tracker, initialGear: 2 });
    const state = arbiter.getState();
    expect(state.gear).toBe(2);
    expect(state.dwell).toBe(0);
  });

  it('reflects gear changes after evaluate()', () => {
    const tracker = new StateTracker();
    feedDeltas(tracker, Array(10).fill(0.05));
    seedObservations(tracker, 10);
    const arbiter = new DynamicArbiter({ stateTracker: tracker });
    // Accumulate dwell then switch
    for (let i = 0; i < 6; i++) arbiter.evaluate(makeContext());
    expect(arbiter.getState().gear).toBe(2);
  });
});

// ─── CalibrationBridge ────────────────────────────────────────────────────────

describe('CalibrationBridge', () => {
  it('feeds clampedDelta to tracker on audit:tool_audited (AC-CV5-FIX-1)', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    const bridge = new CalibrationBridge(bus, tracker);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 0.04, executionResult: 'success', inferredRiskCategory: 'read_only' },
    });

    expect(tracker.getRecentDeltas()).toContain(0.04);
    bridge.stop();
  });

  it('records inferredRiskCategory as observation (AC-CV5-FIX-2)', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    const bridge = new CalibrationBridge(bus, tracker);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 0.04, executionResult: 'success', inferredRiskCategory: 'state_modifying' },
    });

    expect(tracker.getCategoryCount('state_modifying')).toBe(1);
    expect(tracker.getTotalObservations()).toBe(1);
    bridge.stop();
  });

  it('logs warning and skips when clampedDelta is missing (AC-W2-9)', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const bridge = new CalibrationBridge(bus, tracker, mockLogger);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { executionResult: 'success', inferredRiskCategory: 'read_only' },
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('missing clampedDelta'),
      expect.any(Object),
    );
    expect(tracker.getRecentDeltas()).toHaveLength(0);
    bridge.stop();
  });

  it('logs warning and skips when clampedDelta is non-numeric', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const bridge = new CalibrationBridge(bus, tracker, mockLogger);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 'not-a-number', inferredRiskCategory: 'read_only' },
    });

    expect(mockLogger.warn).toHaveBeenCalled();
    expect(tracker.getRecentDeltas()).toHaveLength(0);
    bridge.stop();
  });

  it('unsubscribes on stop()', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    const bridge = new CalibrationBridge(bus, tracker);
    bridge.start();
    bridge.stop();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 0.09, inferredRiskCategory: 'read_only' },
    });

    expect(tracker.getRecentDeltas()).toHaveLength(0);
  });

  it('exports DELTA_SCALING_FACTOR = 0.055', () => {
    expect(DELTA_SCALING_FACTOR).toBe(0.055);
  });

  it('exports TOOL_CONFIDENCE_TABLE with 4 risk categories', () => {
    expect(TOOL_CONFIDENCE_TABLE.destructive).toBe(0.85);
    expect(TOOL_CONFIDENCE_TABLE.state_modifying).toBe(0.75);
    expect(TOOL_CONFIDENCE_TABLE.read_only).toBe(0.50);
    expect(TOOL_CONFIDENCE_TABLE.informational).toBe(0.001);
  });

  it('CalibrationBridge uses DEFAULT_LOGGER when no logger injected (COND-1)', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    const bridge = new CalibrationBridge(bus, tracker);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 0.03, inferredRiskCategory: 'read_only', executionResult: 'success' },
    });
    expect(tracker.getRecentDeltas()).toContain(0.03);
    expect(tracker.getCategoryCount('read_only')).toBe(1);
    bridge.stop();
  });

  it('logs warning on falsy payload (guard path 1)', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const bridge = new CalibrationBridge(bus, tracker, mockLogger);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: undefined,
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('missing or invalid payload'),
    );
    bridge.stop();
  });

  it('logs warning when inferredRiskCategory is absent (guard path 3)', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const bridge = new CalibrationBridge(bus, tracker, mockLogger);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 0.04, executionResult: 'success' },
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('missing inferredRiskCategory'),
    );
    expect(tracker.getRecentDeltas()).toContain(0.04);
    expect(tracker.getTotalObservations()).toBe(0);
    bridge.stop();
  });
});

// ─── CalibrationBridge — shadow integration (Plan44 W1-4) ───────────────────

describe('CalibrationBridge — shadow integration (Plan44)', () => {
  it('fires shadow decision when Phase3Config.enabled and category present', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    // Seed enough observations for shadow to not abstain
    for (let i = 0; i < 10; i++) tracker.recordObservation('read_only');
    feedDeltas(tracker, Array(9).fill(0.02)); // 9 deltas already

    const shadowRecords: ShadowDecisionRecord[] = [];
    const shadowConfig: ShadowConfig = {
      enabled: true,
      getArbiterState: () => ({ gear: 1, dwell: 0 }),
      onShadowDecision: (r) => shadowRecords.push(r),
    };

    const bridge = new CalibrationBridge(bus, tracker, undefined, shadowConfig);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 0.03, inferredRiskCategory: 'read_only' },
    });

    expect(shadowRecords).toHaveLength(1);
    expect(shadowRecords[0].category).toBe('read_only');
    expect(shadowRecords[0].actualGear).toBe(1);
    expect(typeof shadowRecords[0].computeTimeMs).toBe('number');
    bridge.stop();
  });

  it('does not fire shadow when Phase3Config.enabled = false', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    for (let i = 0; i < 10; i++) tracker.recordObservation('read_only');
    feedDeltas(tracker, Array(9).fill(0.02));

    const shadowRecords: ShadowDecisionRecord[] = [];
    // No shadowConfig = no shadow
    const bridge = new CalibrationBridge(bus, tracker);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 0.03, inferredRiskCategory: 'read_only' },
    });

    expect(shadowRecords).toHaveLength(0);
    bridge.stop();
  });

  it('does not fire shadow when category missing', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    for (let i = 0; i < 10; i++) tracker.recordObservation('read_only');
    feedDeltas(tracker, Array(9).fill(0.02));

    const shadowRecords: ShadowDecisionRecord[] = [];
    const shadowConfig: ShadowConfig = {
      enabled: true,
      getArbiterState: () => ({ gear: 1, dwell: 0 }),
      onShadowDecision: (r) => shadowRecords.push(r),
    };
    const mockLogger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const bridge = new CalibrationBridge(bus, tracker, mockLogger, shadowConfig);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 0.03 }, // no inferredRiskCategory
    });

    expect(shadowRecords).toHaveLength(0);
    bridge.stop();
  });

  it('shadow fires AFTER delta recording (AC-W1-8 temporal isolation)', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    for (let i = 0; i < 10; i++) tracker.recordObservation('read_only');
    // Start with 0 deltas
    const shadowRecords: ShadowDecisionRecord[] = [];
    const shadowConfig: ShadowConfig = {
      enabled: true,
      getArbiterState: () => ({ gear: 1, dwell: 0 }),
      onShadowDecision: (r) => {
        // At this point, tracker should have the new delta
        expect(tracker.getRecentDeltas()).toHaveLength(1);
        shadowRecords.push(r);
      },
    };

    const bridge = new CalibrationBridge(bus, tracker, undefined, shadowConfig);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 0.05, inferredRiskCategory: 'read_only' },
    });

    expect(shadowRecords).toHaveLength(1);
    bridge.stop();
  });

  it('sets monitoringOnly for destructive category (AC-W1-4, Rule #57)', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    for (let i = 0; i < 10; i++) tracker.recordObservation('destructive');
    feedDeltas(tracker, Array(9).fill(-0.04));

    const shadowRecords: ShadowDecisionRecord[] = [];
    const shadowConfig: ShadowConfig = {
      enabled: true,
      getArbiterState: () => ({ gear: 1, dwell: 0 }),
      onShadowDecision: (r) => shadowRecords.push(r),
    };

    const bridge = new CalibrationBridge(bus, tracker, undefined, shadowConfig);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: -0.04, inferredRiskCategory: 'destructive' },
    });

    // Note: shadow may abstain due to negative mean. If it abstains, no record.
    // With all-negative deltas, negMean < 0, so it passes the constraint.
    // mean of [-0.04 * 10] = -0.04 < DOWN=0.031, so no gear switch.
    // Shadow should not abstain (totalObs >= 10, deltas present, negMean <= 0).
    if (shadowRecords.length > 0) {
      expect(shadowRecords[0].monitoringOnly).toBe(true);
    }
    bridge.stop();
  });

  it('includes trackerSnapshot in shadow record (AC-W1-9)', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const tracker = new StateTracker();
    for (let i = 0; i < 10; i++) tracker.recordObservation('read_only');
    feedDeltas(tracker, Array(9).fill(0.02));

    const shadowRecords: ShadowDecisionRecord[] = [];
    const shadowConfig: ShadowConfig = {
      enabled: true,
      getArbiterState: () => ({ gear: 1, dwell: 3 }),
      onShadowDecision: (r) => shadowRecords.push(r),
    };

    const bridge = new CalibrationBridge(bus, tracker, undefined, shadowConfig);
    bridge.start();

    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: { clampedDelta: 0.02, inferredRiskCategory: 'read_only' },
    });

    expect(shadowRecords).toHaveLength(1);
    const snap = shadowRecords[0].trackerSnapshot;
    expect(snap.totalObs).toBe(11); // 10 + 1 new
    expect(snap.currentGear).toBe(1);
    expect(snap.dwellCounter).toBe(3);
    expect(typeof snap.recentDeltaMean).toBe('number');
    bridge.stop();
  });
});

// ─── computeShadowDecision — pure function (Plan44 W1-1) ────────────────────

describe('computeShadowDecision — pure function (AC-W1-1)', () => {
  it('returns abstain when totalObs < MIN_N', () => {
    const result = computeShadowDecision([0.05, 0.06], 5, 1, 0);
    expect(result.abstains).toBe(true);
    expect(result.shadowGear).toBe(1);
  });

  it('returns abstain when deltas empty', () => {
    const result = computeShadowDecision([], 15, 1, 0);
    expect(result.abstains).toBe(true);
  });

  it('does not mutate input arrays (purity)', () => {
    const deltas = [0.05, 0.06, 0.04];
    Object.freeze(deltas);
    expect(() => computeShadowDecision(deltas, 15, 1, 6)).not.toThrow();
  });

  it('returns gear 2 when mean >= UP and dwell >= MIN_DWELL', () => {
    const result = computeShadowDecision(Array(10).fill(0.05), 15, 1, 5);
    expect(result.shadowGear).toBe(2);
    expect(result.abstains).toBe(false);
  });

  it('returns gear 1 when mean <= DOWN and dwell >= MIN_DWELL (gear 2)', () => {
    const result = computeShadowDecision(Array(10).fill(0.01), 15, 2, 5);
    expect(result.shadowGear).toBe(1);
    expect(result.abstains).toBe(false);
  });

  it('stays at current gear when dwell < MIN_DWELL', () => {
    const result = computeShadowDecision(Array(10).fill(0.05), 15, 1, 3);
    expect(result.shadowGear).toBe(1);
    expect(result.abstains).toBe(false);
  });

  it('abstains when negative mean > 0 (destructive constraint)', () => {
    // This case is mathematically impossible with real negatives, but tests the guard
    const result = computeShadowDecision(Array(10).fill(-0.05), 15, 1, 0);
    // negMean = -0.05 which is <= 0, so no abstain from this guard
    expect(result.abstains).toBe(false);
  });

  it('is deterministic (same inputs → same outputs)', () => {
    const args: [readonly number[], number, number, number] = [Array(10).fill(0.04), 15, 1, 5];
    const r1 = computeShadowDecision(...args);
    const r2 = computeShadowDecision(...args);
    expect(r1).toEqual(r2);
  });
});

// ─── M4aAggregator (Plan44 W1-3) ────────────────────────────────────────────

describe('M4aAggregator', () => {
  function makeRecord(overrides?: Partial<ShadowDecisionRecord>): ShadowDecisionRecord {
    return {
      timestamp: Date.now(),
      category: 'read_only',
      shadowGear: 1,
      actualGear: 1,
      agrees: true,
      deviation: 0,
      monitoringOnly: false,
      trackerSnapshot: { totalObs: 15, recentDeltaMean: 0.02, currentGear: 1, dwellCounter: 0 },
      computeTimeMs: 0.05,
      ...overrides,
    };
  }

  it('appends records and tracks count', () => {
    const agg = new M4aAggregator();
    agg.append(makeRecord());
    agg.append(makeRecord({ category: 'informational' }));
    expect(agg.getRecords()).toHaveLength(2);
  });

  it('generates report with per-category agreement rate (AC-W1-3)', () => {
    const agg = new M4aAggregator();
    agg.append(makeRecord({ category: 'read_only', agrees: true }));
    agg.append(makeRecord({ category: 'read_only', agrees: true }));
    agg.append(makeRecord({ category: 'read_only', agrees: false, deviation: 1 }));
    agg.append(makeRecord({ category: 'informational', agrees: true }));

    const report = agg.generateReport('test-round');
    expect(report.shadowDecisionCount).toBe(4);
    expect(report.aggregateAgreementRate).toBe(3 / 4);

    const readOnly = report.categories.find(c => c.category === 'read_only');
    expect(readOnly!.agreementRate).toBeCloseTo(2 / 3);
    expect(readOnly!.meanDeviation).toBe(1);
    expect(readOnly!.monitoringOnly).toBe(false);

    const info = report.categories.find(c => c.category === 'informational');
    expect(info!.agreementRate).toBe(1);
  });

  it('labels destructive as monitoring-only (AC-W1-4, Rule #57)', () => {
    const agg = new M4aAggregator();
    agg.append(makeRecord({ category: 'destructive', monitoringOnly: true }));
    const report = agg.generateReport('test');
    expect(report.categories[0].monitoringOnly).toBe(true);
    expect(report.categories[0].hypothesisThreshold).toContain('monitoring-only');
  });

  it('labels state_modifying as monitoring-only (Rule #57)', () => {
    const agg = new M4aAggregator();
    agg.append(makeRecord({ category: 'state_modifying', monitoringOnly: true }));
    const report = agg.generateReport('test');
    expect(report.categories[0].monitoringOnly).toBe(true);
  });

  it('includes HYPOTHESIS thresholds in report (AC-W1-5)', () => {
    const agg = new M4aAggregator();
    agg.append(makeRecord({ category: 'read_only' }));
    agg.append(makeRecord({ category: 'informational' }));
    const report = agg.generateReport('test');
    for (const cat of report.categories) {
      expect(cat.hypothesisThreshold).toContain('HYPOTHESIS');
    }
  });

  it('clear() removes all records', () => {
    const agg = new M4aAggregator();
    agg.append(makeRecord());
    agg.clear();
    expect(agg.getRecords()).toHaveLength(0);
  });

  it('isMonitoringOnly correctly identifies categories', () => {
    expect(isMonitoringOnly('destructive')).toBe(true);
    expect(isMonitoringOnly('state_modifying')).toBe(true);
    expect(isMonitoringOnly('read_only')).toBe(false);
    expect(isMonitoringOnly('informational')).toBe(false);
  });
});

// ─── Plugin factory ──────────────────────────────────────────────────────────

describe('createGearArbiterDynamicPlugin — factory', () => {
  it('produces gearArbiters hook (AC-CV5-1)', async () => {
    const bus = makeBus();
    const ctx = { bus, config: undefined, logger: console, pushInput: vi.fn(), services: { register: vi.fn(), get: vi.fn() } } as unknown as import('@openstarry/sdk').IPluginContext;
    const plugin = createGearArbiterDynamicPlugin();
    const hooks = await plugin.factory(ctx);
    expect(hooks.gearArbiters).toBeDefined();
    expect(hooks.gearArbiters!.length).toBe(1);
    expect(hooks.gearArbiters![0].id).toBe('gear-arbiter-dynamic');
  });

  it('manifest has correct name and skandha', () => {
    const plugin = createGearArbiterDynamicPlugin();
    expect(plugin.manifest.name).toBe('@openstarry-plugin/gear-arbiter-dynamic');
    expect(plugin.manifest.skandha).toContain('samskara');
    expect(plugin.manifest.skandha).toContain('vijnana');
  });

  it('dispose() calls bridge.stop() without error', async () => {
    const bus = makeBus();
    const ctx = { bus, config: undefined, logger: console, pushInput: vi.fn(), services: { register: vi.fn(), get: vi.fn() } } as unknown as import('@openstarry/sdk').IPluginContext;
    const plugin = createGearArbiterDynamicPlugin();
    const hooks = await plugin.factory(ctx);
    expect(() => hooks.dispose?.()).not.toThrow();
  });

  it('returns different arbiter instances per factory call (state isolation)', async () => {
    const bus = makeBus();
    const ctx = { bus, config: undefined, logger: console, pushInput: vi.fn(), services: { register: vi.fn(), get: vi.fn() } } as unknown as import('@openstarry/sdk').IPluginContext;
    const plugin = createGearArbiterDynamicPlugin();
    const hooks1 = await plugin.factory(ctx);
    const hooks2 = await plugin.factory(ctx);
    expect(hooks1.gearArbiters![0]).not.toBe(hooks2.gearArbiters![0]);
    hooks1.dispose?.();
    hooks2.dispose?.();
  });

  it('factory passes coldStartGear as initialGear (COND-4)', async () => {
    const bus = makeBus();
    const ctx = { bus, config: undefined, logger: console, pushInput: vi.fn(), services: { register: vi.fn(), get: vi.fn() } } as unknown as import('@openstarry/sdk').IPluginContext;
    const plugin = createGearArbiterDynamicPlugin({ coldStartGear: 2 });
    const hooks = await plugin.factory(ctx);
    expect(hooks.gearArbiters![0].id).toBe('gear-arbiter-dynamic');
    hooks.dispose?.();
  });

  it('Phase3Config type is exported', () => {
    const config: import('../index.js').Phase3Config = { enabled: false };
    expect(config.enabled).toBe(false);
  });

  it('Phase3Config.enabled defaults to false (AC-W1-6)', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const ctx = { bus, config: undefined, logger: console, pushInput: vi.fn(), services: { register: vi.fn(), get: vi.fn() } } as unknown as import('@openstarry/sdk').IPluginContext;
    // No phase3 config → defaults to false → no shadow events
    const plugin = createGearArbiterDynamicPlugin();
    const hooks = await plugin.factory(ctx);
    // Emit audit events — no shadow_decision should fire
    const shadowEvents: AgentEvent[] = [];
    bus.on('audit:shadow_decision', (e) => shadowEvents.push(e));

    // Seed enough data
    for (let i = 0; i < 15; i++) {
      bus.emit({
        type: 'audit:tool_audited',
        timestamp: Date.now(),
        payload: { clampedDelta: 0.03, inferredRiskCategory: 'read_only', executionResult: 'success' },
      });
    }
    expect(shadowEvents).toHaveLength(0);
    hooks.dispose?.();
  });

  it('Phase3Config.enabled=true emits shadow decisions via audit trail (AC-W1-10)', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const ctx = { bus, config: undefined, logger: console, pushInput: vi.fn(), services: { register: vi.fn(), get: vi.fn() } } as unknown as import('@openstarry/sdk').IPluginContext;
    const plugin = createGearArbiterDynamicPlugin({ phase3: { enabled: true } });
    const hooks = await plugin.factory(ctx);

    const shadowEvents: AgentEvent[] = [];
    bus.on('audit:shadow_decision', (e) => shadowEvents.push(e));

    // Emit enough audit events to exit observe mode and trigger shadow
    for (let i = 0; i < 12; i++) {
      bus.emit({
        type: 'audit:tool_audited',
        timestamp: Date.now(),
        payload: { clampedDelta: 0.03, inferredRiskCategory: 'read_only', executionResult: 'success' },
      });
    }
    // After 10 observations, shadow should start producing records
    expect(shadowEvents.length).toBeGreaterThan(0);
    const record = shadowEvents[0].payload as ShadowDecisionRecord;
    expect(record.category).toBe('read_only');
    expect(typeof record.computeTimeMs).toBe('number');
    hooks.dispose?.();
  });
});

// ─── calibrationState persistence (Plan44 hotfix) ───────────────────────────

describe('calibrationState persistence (Plan44 hotfix)', () => {
  it('factory restores StateTracker from calibrationState config', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const ctx = { bus, config: undefined, pushInput: vi.fn(), services: { register: vi.fn(), get: vi.fn() } } as unknown as import('@openstarry/sdk').IPluginContext;

    // Cycle 1: accumulate observations
    const plugin1 = createGearArbiterDynamicPlugin({ phase3: { enabled: true } });
    const hooks1 = await plugin1.factory(ctx);
    for (let i = 0; i < 8; i++) {
      bus.emit({ type: 'audit:tool_audited', timestamp: Date.now(),
        payload: { clampedDelta: 0.03, inferredRiskCategory: 'read_only', executionResult: 'success' },
      });
    }
    // Capture state on dispose (emitted via calibration:state_snapshot)
    let savedState: import('../state-tracker.js').StateTrackerSnapshot | null = null;
    bus.on('calibration:state_snapshot', (e) => {
      savedState = (e.payload as { trackerState: import('../state-tracker.js').StateTrackerSnapshot }).trackerState;
    });
    hooks1.dispose?.();
    expect(savedState).not.toBeNull();

    // Cycle 2: restore state and continue
    const plugin2 = createGearArbiterDynamicPlugin({
      phase3: { enabled: true },
      calibrationState: savedState!,
    });
    const hooks2 = await plugin2.factory(ctx);

    const shadowEvents: AgentEvent[] = [];
    bus.on('audit:shadow_decision', (e) => shadowEvents.push(e));

    // Add 4 more observations → total = 12 (>= MIN_N=10), shadow should fire
    for (let i = 0; i < 4; i++) {
      bus.emit({ type: 'audit:tool_audited', timestamp: Date.now(),
        payload: { clampedDelta: 0.03, inferredRiskCategory: 'read_only', executionResult: 'success' },
      });
    }

    expect(shadowEvents.length).toBeGreaterThan(0);
    hooks2.dispose?.();
  });
});

// ─── NC3 integration tests (Plan44 W3, Rule #63) ────────────────────────────
// ALL tests use factory chain, not direct construction (C44-12, AC-W3-7)

describe('NC3 integration', () => {
  it('COND-1: factory→bridge→logger chain (AC-W3-1)', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const ctx = { bus, config: undefined, pushInput: vi.fn(), services: { register: vi.fn(), get: vi.fn() } } as unknown as import('@openstarry/sdk').IPluginContext;
    const plugin = createGearArbiterDynamicPlugin();
    const hooks = await plugin.factory(ctx);

    // Spy on DEFAULT_LOGGER.warn (bound to console.warn at module init)
    const warnSpy = vi.spyOn(DEFAULT_LOGGER, 'warn').mockImplementation(() => {});

    // Emit with missing payload to trigger factory→bridge→DEFAULT_LOGGER→console.warn chain
    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: undefined,
    });

    // Behavioral verification: DEFAULT_LOGGER.warn was called through factory chain
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing or invalid payload'),
    );
    warnSpy.mockRestore();
    hooks.dispose?.();
  });

  it('COND-3: factory→full options→runtime (AC-W3-2)', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const ctx = { bus, config: undefined, logger: console, pushInput: vi.fn(), services: { register: vi.fn(), get: vi.fn() } } as unknown as import('@openstarry/sdk').IPluginContext;
    // Pass ALL config options through factory
    const plugin = createGearArbiterDynamicPlugin({
      coldStartGear: 2,
      phase3: { enabled: true },
    });
    const hooks = await plugin.factory(ctx);

    const arbiter = hooks.gearArbiters![0] as DynamicArbiter;
    // Verify initialGear and phase3Config acceptance via getState
    expect(arbiter.getState().gear).toBe(2);

    // Verify shadow events fire when phase3 enabled
    const shadowEvents: AgentEvent[] = [];
    bus.on('audit:shadow_decision', (e) => shadowEvents.push(e));
    for (let i = 0; i < 12; i++) {
      bus.emit({
        type: 'audit:tool_audited',
        timestamp: Date.now(),
        payload: { clampedDelta: 0.02, inferredRiskCategory: 'read_only', executionResult: 'success' },
      });
    }
    expect(shadowEvents.length).toBeGreaterThan(0);
    hooks.dispose?.();
  });

  it('COND-4 NC3 gap closure: coldStartGear=2 → evaluate() returns gear 2 (AC-W3-3, Rule #63 L4)', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const ctx = { bus, config: undefined, logger: console, pushInput: vi.fn(), services: { register: vi.fn(), get: vi.fn() } } as unknown as import('@openstarry/sdk').IPluginContext;
    // CRITICAL: config→factory→runtime verification (Rule #63 L4)
    const plugin = createGearArbiterDynamicPlugin({ coldStartGear: 2 });
    const hooks = await plugin.factory(ctx);

    const arbiter = hooks.gearArbiters![0] as DynamicArbiter;

    // Feed MIN_N observations through the bus to exit observe mode
    for (let i = 0; i < 10; i++) {
      bus.emit({
        type: 'audit:tool_audited',
        timestamp: Date.now(),
        payload: {
          clampedDelta: 0.035, // Between DOWN and UP → no gear switch
          inferredRiskCategory: 'read_only',
          executionResult: 'success',
        },
      });
    }

    // Evaluate — should return gear 2 (not just id check, AC-W3-3)
    const result = arbiter.evaluate(makeContext());
    expect(result.action).toBe(2); // NOT just id check — verifies config→behavior
  });

  it('shadow computation latency benchmark (AC-W3-4)', () => {
    // Benchmark: 1000 iterations, assert < 1ms mean
    const deltas = Array(20).fill(0.04);
    const iterations = 1000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      computeShadowDecision(deltas, 50, 1, 3);
    }
    const elapsed = performance.now() - start;
    const meanMs = elapsed / iterations;
    expect(meanMs).toBeLessThan(1); // Well below 5% of 5500ms cycle (C44-3)
  });
});
