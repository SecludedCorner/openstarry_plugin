/**
 * escalation-monitor.test.ts — Unit tests for L2 EscalationMonitor (Plan45 W1-1).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EscalationMonitor } from '../escalation-monitor.js';
import type { SpcAnomaly } from '../shewhart-chart.js';

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
    reason: 'Point 5 beyond UCL (+-3sigma)',
    ...overrides,
  };
}

// ─── AC-W1-1a: processAnomaly counts correctly within window ─────────────────

describe('EscalationMonitor - processAnomaly (AC-W1-1a)', () => {
  it('counts anomalies within the window and returns event on level change', () => {
    const monitor = new EscalationMonitor({
      windowMs: 300_000,
      thresholds: { watch: 2, warning: 4, critical: 7 },
    });

    // First anomaly: 1 count, still normal (< watch=2), no event
    const e1 = monitor.processAnomaly(makeAnomaly());
    expect(e1).toBeNull();

    // Second anomaly: count = 2, reaches watch → event emitted
    const e2 = monitor.processAnomaly(makeAnomaly());
    expect(e2).not.toBeNull();
    expect(e2!.currentLevel).toBe('watch');
    expect(e2!.previousLevel).toBe('normal');
    expect(e2!.anomalyCount).toBe(2);
  });
});

// ─── AC-W1-1b: window pruning removes old anomalies ──────────────────────────

describe('EscalationMonitor - window pruning (AC-W1-1b)', () => {
  it('prunes anomalies outside the time window', () => {
    const monitor = new EscalationMonitor({
      windowMs: 1000, // 1 second window for testing
      thresholds: { watch: 2, warning: 4, critical: 7 },
    });

    // Use fake timers to control Date.now()
    const dateSpy = vi.spyOn(Date, 'now');

    // Add 3 anomalies at t=0
    dateSpy.mockReturnValue(0);
    monitor.processAnomaly(makeAnomaly());
    monitor.processAnomaly(makeAnomaly());
    monitor.processAnomaly(makeAnomaly()); // level: warning (count=3 >= watch=2, < warning=4 → still watch... need count=4 for warning)

    // At t=2000ms (beyond windowMs=1000), add one more anomaly
    // The 3 old anomalies should be pruned (t=0 < cutoff=1000)
    dateSpy.mockReturnValue(2000);
    const event = monitor.processAnomaly(makeAnomaly());

    // After pruning: count should be 1 (only the new anomaly at t=2000)
    // Level should be normal (1 < watch=2), and if previous level was watch/warning,
    // a downward transition event is expected
    if (event) {
      expect(event.anomalyCount).toBe(1);
      expect(event.currentLevel).toBe('normal');
    } else {
      // If current level was already normal (e.g., never escalated), no event
      const states = monitor.getAllStates();
      const catState = states.get('read_only');
      expect(catState?.anomalyCount).toBe(1);
    }

    dateSpy.mockRestore();
  });
});

// ─── AC-W1-1c: level transitions emit events ─────────────────────────────────

describe('EscalationMonitor - level transitions (AC-W1-1c)', () => {
  it('emits event on every level transition: normal→watch→warning→critical', () => {
    const monitor = new EscalationMonitor({
      windowMs: 300_000,
      thresholds: { watch: 2, warning: 4, critical: 7 },
    });

    const events = [];

    // normal→watch at count=2
    for (let i = 0; i < 1; i++) monitor.processAnomaly(makeAnomaly()); // count=1, normal
    const e1 = monitor.processAnomaly(makeAnomaly()); // count=2, watch
    expect(e1).not.toBeNull();
    expect(e1!.currentLevel).toBe('watch');
    events.push(e1);

    // watch→warning at count=4
    monitor.processAnomaly(makeAnomaly()); // count=3, still watch → no event
    const e2 = monitor.processAnomaly(makeAnomaly()); // count=4, warning
    expect(e2).not.toBeNull();
    expect(e2!.currentLevel).toBe('warning');
    events.push(e2);

    // warning→critical at count=7
    monitor.processAnomaly(makeAnomaly()); // count=5
    monitor.processAnomaly(makeAnomaly()); // count=6
    const e3 = monitor.processAnomaly(makeAnomaly()); // count=7, critical
    expect(e3).not.toBeNull();
    expect(e3!.currentLevel).toBe('critical');
    events.push(e3);

    expect(events.length).toBe(3);
  });
});

// ─── AC-W1-1d: no event when level unchanged ─────────────────────────────────

describe('EscalationMonitor - no event on same level (AC-W1-1d)', () => {
  it('returns null when level does not change between consecutive anomalies', () => {
    const monitor = new EscalationMonitor({
      windowMs: 300_000,
      thresholds: { watch: 2, warning: 4, critical: 7 },
    });

    // Bring to watch (count=2)
    monitor.processAnomaly(makeAnomaly());
    monitor.processAnomaly(makeAnomaly()); // → watch

    // count=3: still watch, no event
    const e = monitor.processAnomaly(makeAnomaly());
    expect(e).toBeNull();
  });
});

// ─── AC-W1-1e: monitoringOnly categories excluded from getCriticalCategories() ──

describe('EscalationMonitor - monitoringOnly isolation (AC-W1-1e)', () => {
  it('monitoringOnly=true categories do not appear in getCriticalCategories()', () => {
    const monitor = new EscalationMonitor({
      windowMs: 300_000,
      thresholds: { watch: 2, warning: 4, critical: 7 },
    });

    // Drive destructive (monitoringOnly=true) to critical
    for (let i = 0; i < 10; i++) {
      monitor.processAnomaly(makeAnomaly({ category: 'destructive', monitoringOnly: true }));
    }

    // Drive a non-monitoring category to critical
    for (let i = 0; i < 7; i++) {
      monitor.processAnomaly(makeAnomaly({ category: 'read_only', monitoringOnly: false }));
    }

    const criticals = monitor.getCriticalCategories();
    expect(criticals).not.toContain('destructive');
    expect(criticals).toContain('read_only');
  });

  it('destructive at critical level IS reflected in getAllStates but not in getCriticalCategories', () => {
    const monitor = new EscalationMonitor({
      windowMs: 300_000,
      thresholds: { watch: 2, warning: 4, critical: 7 },
    });

    for (let i = 0; i < 10; i++) {
      monitor.processAnomaly(makeAnomaly({ category: 'destructive', monitoringOnly: true }));
    }

    const states = monitor.getAllStates();
    const destructiveState = states.get('destructive');
    expect(destructiveState?.level).toBe('critical');
    expect(destructiveState?.monitoringOnly).toBe(true);

    const criticals = monitor.getCriticalCategories();
    expect(criticals).toHaveLength(0);
  });
});

// ─── Multiple categories are independent ──────────────────────────────────────

describe('EscalationMonitor - multiple categories independent', () => {
  it('tracks different categories independently without cross-contamination', () => {
    const monitor = new EscalationMonitor({
      windowMs: 300_000,
      thresholds: { watch: 2, warning: 4, critical: 7 },
    });

    // cat-A: drive to critical (7 anomalies)
    for (let i = 0; i < 7; i++) {
      monitor.processAnomaly(makeAnomaly({ category: 'cat-A', monitoringOnly: false }));
    }

    // cat-B: only 1 anomaly (normal)
    monitor.processAnomaly(makeAnomaly({ category: 'cat-B', monitoringOnly: false }));

    const states = monitor.getAllStates();
    expect(states.get('cat-A')?.level).toBe('critical');
    expect(states.get('cat-B')?.level).toBe('normal');

    const criticals = monitor.getCriticalCategories();
    expect(criticals).toContain('cat-A');
    expect(criticals).not.toContain('cat-B');
  });
});

// ─── reset() clears all state ─────────────────────────────────────────────────

describe('EscalationMonitor - reset()', () => {
  it('clears all state on reset', () => {
    const monitor = new EscalationMonitor();
    for (let i = 0; i < 7; i++) {
      monitor.processAnomaly(makeAnomaly({ category: 'read_only' }));
    }
    expect(monitor.getCriticalCategories()).toContain('read_only');
    monitor.reset();
    expect(monitor.getAllStates().size).toBe(0);
    expect(monitor.getCriticalCategories()).toHaveLength(0);
  });
});
