/**
 * safety-gate.test.ts — Unit tests for L3 SafetyGate (Plan45 W1-2).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SafetyGate, SAFETY_GATE_PLUGIN_NAME } from '../safety-gate.js';
import { EscalationMonitor } from '../escalation-monitor.js';
import type { SpcAnomaly } from '../shewhart-chart.js';
import type { PluginSnapshot } from '@openstarry/sdk';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeAnomaly(overrides?: Partial<SpcAnomaly>): SpcAnomaly {
  return {
    category: 'read_only',
    currentValue: 5,
    ucl: 3,
    lcl: -3,
    mean: 0,
    std: 1,
    windowSize: 50,
    monitoringOnly: false,
    reason: 'beyond UCL',
    ...overrides,
  };
}

/** Build an EscalationMonitor with N critical (non-monitoring) categories. */
function buildMonitorWithCriticals(n: number, monitoringOnly = false): EscalationMonitor {
  const monitor = new EscalationMonitor({
    windowMs: 300_000,
    thresholds: { watch: 2, warning: 4, critical: 7 },
  });
  for (let i = 0; i < n; i++) {
    const cat = `cat-${i}`;
    for (let j = 0; j < 7; j++) {
      monitor.processAnomaly(makeAnomaly({ category: cat, monitoringOnly }));
    }
  }
  return monitor;
}

// ─── AC-W1-2a: enabled=false always returns null ─────────────────────────────

describe('SafetyGate - disabled (AC-W1-2a)', () => {
  it('returns null when enabled=false regardless of escalation state', () => {
    const gate = new SafetyGate({ enabled: false });
    const monitor = buildMonitorWithCriticals(5); // well above threshold

    const result = gate.checkEscalation(monitor);
    expect(result).toBeNull();
  });
});

// ─── AC-W1-2b: below threshold does not trigger ───────────────────────────────

describe('SafetyGate - below threshold (AC-W1-2b)', () => {
  it('does not trigger when criticalCategories < criticalCategoryThreshold', () => {
    // threshold=2, only 1 critical category
    const gate = new SafetyGate({
      enabled: true,
      criticalCategoryThreshold: 2,
      cooldownShadowDecisions: 0, // bypass cooldown for this test
      cooldownMs: 0,
    });
    const monitor = buildMonitorWithCriticals(1);

    const result = gate.checkEscalation(monitor);
    expect(result).toBeNull();
  });
});

// ─── AC-W1-2c: triggers when criticalCategories >= threshold AND cooldown cleared ──

describe('SafetyGate - trigger (AC-W1-2c)', () => {
  it('triggers when criticalCategories >= threshold and cooldown is satisfied', () => {
    // Use 0 cooldowns for first-trigger (never triggered before, no cooldown needed)
    const gate = new SafetyGate({
      enabled: true,
      criticalCategoryThreshold: 2,
      cooldownShadowDecisions: 50,
      cooldownMs: 60_000,
      forceGear: 1,
    });
    const monitor = buildMonitorWithCriticals(3); // 3 critical >= threshold 2

    const result = gate.checkEscalation(monitor);
    expect(result).not.toBeNull();
    expect(result!.triggered).toBe(true);
    expect(result!.criticalCategories.length).toBeGreaterThanOrEqual(2);
    expect(result!.forceGear).toBe(1);
    expect(result!.cooldownShadowDecisions).toBe(50);
    expect(result!.cooldownMs).toBe(60_000);
    expect(typeof result!.reason).toBe('string');
    expect(result!.reason.length).toBeGreaterThan(0);
  });
});

// ─── AC-W1-2d: Dual-guard AND: shadowDecisions not enough → no trigger ────────

describe('SafetyGate - dual-guard: shadow decisions not ready (AC-W1-2d)', () => {
  it('does not re-trigger when shadowDecisionsSinceTrigger < cooldownShadowDecisions, even if time passed', () => {
    const dateSpy = vi.spyOn(Date, 'now');

    // First trigger at t=0
    dateSpy.mockReturnValue(0);
    const gate = new SafetyGate({
      enabled: true,
      criticalCategoryThreshold: 2,
      cooldownShadowDecisions: 50, // need 50 shadow decisions
      cooldownMs: 1000,            // 1 second time cooldown
    });
    const monitor = buildMonitorWithCriticals(3);
    const firstTrigger = gate.checkEscalation(monitor);
    expect(firstTrigger).not.toBeNull();

    // Time has passed (cooldownMs satisfied) but shadow decisions not enough
    dateSpy.mockReturnValue(5000); // 5 seconds later

    // Add only 10 shadow decisions (< 50 required)
    for (let i = 0; i < 10; i++) {
      gate.recordShadowDecision();
    }

    const secondTry = gate.checkEscalation(monitor);
    expect(secondTry).toBeNull(); // Shadow decisions guard not satisfied

    dateSpy.mockRestore();
  });
});

// ─── AC-W1-2e: Dual-guard AND: time not elapsed → no trigger ──────────────────

describe('SafetyGate - dual-guard: time not elapsed (AC-W1-2e)', () => {
  it('does not re-trigger when cooldownMs not elapsed, even if shadow decisions sufficient', () => {
    const dateSpy = vi.spyOn(Date, 'now');

    // First trigger at t=0
    dateSpy.mockReturnValue(0);
    const gate = new SafetyGate({
      enabled: true,
      criticalCategoryThreshold: 2,
      cooldownShadowDecisions: 5, // only need 5 shadow decisions
      cooldownMs: 60_000,         // 60 second time cooldown
    });
    const monitor = buildMonitorWithCriticals(3);
    const firstTrigger = gate.checkEscalation(monitor);
    expect(firstTrigger).not.toBeNull();

    // Add enough shadow decisions
    for (let i = 0; i < 10; i++) {
      gate.recordShadowDecision();
    }

    // Time is only 1 second later (< cooldownMs=60000)
    dateSpy.mockReturnValue(1000);

    const secondTry = gate.checkEscalation(monitor);
    expect(secondTry).toBeNull(); // Time guard not satisfied

    dateSpy.mockRestore();
  });
});

// ─── AC-W1-2f: recordShadowDecision increments counter ───────────────────────

describe('SafetyGate - recordShadowDecision (AC-W1-2f)', () => {
  it('recordShadowDecision increments and resets on trigger', () => {
    const dateSpy = vi.spyOn(Date, 'now');
    dateSpy.mockReturnValue(0);

    const gate = new SafetyGate({
      enabled: true,
      criticalCategoryThreshold: 2,
      cooldownShadowDecisions: 3,
      cooldownMs: 0,
    });
    const monitor = buildMonitorWithCriticals(3);

    // First trigger
    gate.checkEscalation(monitor);

    // Add 3 shadow decisions
    gate.recordShadowDecision();
    gate.recordShadowDecision();
    gate.recordShadowDecision();

    // Now both guards satisfied: shadow=3 >= 3, ms=0 >= 0
    const snapshot = gate.serialize();
    expect(snapshot.shadowDecisionsSinceTrigger).toBe(3);

    // Trigger again → counter resets
    const secondTrigger = gate.checkEscalation(monitor);
    expect(secondTrigger).not.toBeNull();
    const snapshot2 = gate.serialize();
    expect(snapshot2.shadowDecisionsSinceTrigger).toBe(0);

    dateSpy.mockRestore();
  });
});

// ─── AC-W1-2g: serialize/fromSnapshot roundtrip ───────────────────────────────

describe('SafetyGate - serialize/fromSnapshot (AC-W1-2g)', () => {
  it('roundtrips state correctly including schemaVersion=1', () => {
    const dateSpy = vi.spyOn(Date, 'now');
    dateSpy.mockReturnValue(1000);

    const config = {
      enabled: true,
      criticalCategoryThreshold: 2,
      cooldownShadowDecisions: 50,
      cooldownMs: 60_000,
    };
    const gate = new SafetyGate(config);
    const monitor = buildMonitorWithCriticals(3);
    gate.checkEscalation(monitor); // trigger once
    gate.recordShadowDecision();
    gate.recordShadowDecision();

    const snapshot = gate.serialize();
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.lastTriggerMs).toBe(1000);
    expect(snapshot.shadowDecisionsSinceTrigger).toBe(2);

    // Restore
    const restored = SafetyGate.fromSnapshot(snapshot, config);
    const restoredSnapshot = restored.serialize();
    expect(restoredSnapshot.schemaVersion).toBe(1);
    expect(restoredSnapshot.lastTriggerMs).toBe(1000);
    expect(restoredSnapshot.shadowDecisionsSinceTrigger).toBe(2);

    dateSpy.mockRestore();
  });
});

// ─── AC-W1-2h: fromSnapshot throws on unknown schemaVersion ──────────────────

describe('SafetyGate - fromSnapshot unknown version (AC-W1-2h)', () => {
  it('throws when schemaVersion is not 1', () => {
    expect(() => {
      SafetyGate.fromSnapshot({ schemaVersion: 2, lastTriggerMs: 0, shadowDecisionsSinceTrigger: 0 });
    }).toThrow(/schemaVersion/);

    expect(() => {
      SafetyGate.fromSnapshot({ schemaVersion: 0, lastTriggerMs: 0, shadowDecisionsSinceTrigger: 0 });
    }).toThrow(/schemaVersion/);

    expect(() => {
      SafetyGate.fromSnapshot({ schemaVersion: undefined, lastTriggerMs: 0, shadowDecisionsSinceTrigger: 0 });
    }).toThrow(/schemaVersion/);
  });

  it('throws on non-object snapshot', () => {
    expect(() => SafetyGate.fromSnapshot(null)).toThrow();
    expect(() => SafetyGate.fromSnapshot('string')).toThrow();
    expect(() => SafetyGate.fromSnapshot([])).toThrow();
  });
});

// ─── AC-W1-2i: destructive category isolation — does not trigger L3 ──────────

describe('SafetyGate - destructive category isolation (AC-W1-2i)', () => {
  it('does not trigger L3 when only destructive (monitoringOnly) categories are critical', () => {
    const gate = new SafetyGate({
      enabled: true,
      criticalCategoryThreshold: 2,
      cooldownShadowDecisions: 0,
      cooldownMs: 0,
    });

    // Drive 5 destructive (monitoringOnly=true) categories to critical
    const monitor = buildMonitorWithCriticals(5, /* monitoringOnly= */ true);

    // getCriticalCategories() should return [] for monitoringOnly categories
    expect(monitor.getCriticalCategories()).toHaveLength(0);

    const result = gate.checkEscalation(monitor);
    expect(result).toBeNull(); // Must NOT trigger despite 5 critical-level destructive categories
  });
});

// ─── AC-W1-2j: forceGear always equals config.forceGear ──────────────────────

describe('SafetyGate - forceGear (AC-W1-2j)', () => {
  it('forceGear in triggered event matches config.forceGear (default=1)', () => {
    const gate = new SafetyGate({
      enabled: true,
      criticalCategoryThreshold: 1,
      cooldownShadowDecisions: 0,
      cooldownMs: 0,
      forceGear: 1,
    });
    const monitor = buildMonitorWithCriticals(2);
    const result = gate.checkEscalation(monitor);
    expect(result).not.toBeNull();
    expect(result!.forceGear).toBe(1);
  });

  it('forceGear reflects custom config value', () => {
    const gate = new SafetyGate({
      enabled: true,
      criticalCategoryThreshold: 1,
      cooldownShadowDecisions: 0,
      cooldownMs: 0,
      forceGear: 2,
    });
    const monitor = buildMonitorWithCriticals(2);
    const result = gate.checkEscalation(monitor);
    expect(result).not.toBeNull();
    expect(result!.forceGear).toBe(2);
  });
});

// ─── Plan46 W2: onCheckpoint / onRestore PluginHooks adapters ────────────────

describe('SafetyGate - Plan46 W2 onCheckpoint/onRestore', () => {
  it('onCheckpoint returns a PluginSnapshot with correct plugin identity', () => {
    const gate = new SafetyGate({ enabled: true });
    const snap = gate.onCheckpoint();
    expect(snap.pluginName).toBe(SAFETY_GATE_PLUGIN_NAME);
    expect(snap.schemaVersion).toBe(1);
    expect(snap.state).toHaveProperty('lastTriggerMs');
    expect(snap.state).toHaveProperty('shadowDecisionsSinceTrigger');
    expect(typeof snap.timestamp).toBe('number');
  });

  it('onRestore rejects snapshots with wrong pluginName', () => {
    const gate = new SafetyGate({ enabled: true });
    const bad: PluginSnapshot = {
      pluginName: 'other',
      schemaVersion: 1,
      state: { lastTriggerMs: 0, shadowDecisionsSinceTrigger: 0 },
      timestamp: 0,
    };
    expect(() => gate.onRestore(bad)).toThrow(/pluginName mismatch/);
  });

  it('onCheckpoint → onRestore round-trips (trigger + shadow counter)', () => {
    const gate = new SafetyGate({
      enabled: true,
      criticalCategoryThreshold: 1,
      cooldownShadowDecisions: 10,
      cooldownMs: 10_000,
    });
    const monitor = buildMonitorWithCriticals(2);
    gate.checkEscalation(monitor); // triggers
    gate.recordShadowDecision();
    gate.recordShadowDecision();
    const snap = gate.onCheckpoint();

    // Drift: mutate state, then restore
    gate.reset();
    expect(gate.onCheckpoint().state.lastTriggerMs).toBe(0); // 0 = never triggered on wire

    gate.onRestore(snap);
    const after = gate.onCheckpoint().state;
    expect(after.shadowDecisionsSinceTrigger).toBe(2);
    // lastTriggerMs was non-zero when captured; must come back non-zero
    expect(after.lastTriggerMs).toBe(snap.state.lastTriggerMs);
  });
});
