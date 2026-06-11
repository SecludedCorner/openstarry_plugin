/**
 * shewhart-deserialize.test.ts — SEC-003 ShewhartChart.deserialize validation tests.
 *
 * Verifies that the validated deserialize method correctly handles:
 * AC-W0-2a: malformed JSON → throws 'ShewhartChart.deserialize: invalid JSON'
 * AC-W0-2b: non-object root (array / null / primitive) → throws 'ShewhartChart.deserialize: expected object'
 * AC-W0-2c: partial entries with missing fields → skips bad entries, loads valid ones
 * Roundtrip: serialize → deserialize produces equivalent chart state (backward compat)
 * All-non-number deviations → deviations array is empty after filtering
 */

import { describe, it, expect } from 'vitest';
import {
  ShewhartChart,
  SHEWHART_CHART_PLUGIN_NAME,
  SHEWHART_CHART_SCHEMA_VERSION,
} from '../shewhart-chart.js';
import type { ShadowDecisionRecord } from '@openstarry-plugin/gear-arbiter-dynamic';
import type { PluginSnapshot } from '@openstarry/sdk';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRecord(overrides?: Partial<ShadowDecisionRecord>): ShadowDecisionRecord {
  return {
    timestamp: Date.now(),
    category: 'read_only',
    shadowGear: 1,
    actualGear: 1,
    agrees: true,
    deviation: 0.1,
    monitoringOnly: false,
    trackerSnapshot: { totalObs: 15, recentDeltaMean: 0.02, currentGear: 1, dwellCounter: 0 },
    computeTimeMs: 0.05,
    ...overrides,
  };
}

/** Build a minimal valid CategoryWindow JSON object. */
function validEntry(overrides?: Record<string, unknown>) {
  return {
    deviations: [0.1, 0.2, 0.3],
    count: 3,
    sum: 0.6,
    sumSq: 0.14,
    monitoringOnly: false,
    prevAgreementRate: null,
    agreementCount: 2,
    ...overrides,
  };
}

// ─── AC-W0-2a: malformed JSON ─────────────────────────────────────────────────

describe('ShewhartChart.deserialize — AC-W0-2a: malformed JSON', () => {
  it('throws "invalid JSON" for a completely invalid string', () => {
    expect(() => ShewhartChart.deserialize('not valid json')).toThrow(
      'ShewhartChart.deserialize: invalid JSON',
    );
  });

  it('throws "invalid JSON" for truncated JSON', () => {
    expect(() => ShewhartChart.deserialize('{"foo": ')).toThrow(
      'ShewhartChart.deserialize: invalid JSON',
    );
  });

  it('throws "invalid JSON" for empty string', () => {
    expect(() => ShewhartChart.deserialize('')).toThrow(
      'ShewhartChart.deserialize: invalid JSON',
    );
  });
});

// ─── AC-W0-2b: non-object root ────────────────────────────────────────────────

describe('ShewhartChart.deserialize — AC-W0-2b: non-object root', () => {
  it('throws "expected object" for JSON array root', () => {
    expect(() => ShewhartChart.deserialize('[]')).toThrow(
      'ShewhartChart.deserialize: expected object',
    );
  });

  it('throws "expected object" for JSON null root', () => {
    expect(() => ShewhartChart.deserialize('null')).toThrow(
      'ShewhartChart.deserialize: expected object',
    );
  });

  it('throws "expected object" for JSON number root', () => {
    expect(() => ShewhartChart.deserialize('42')).toThrow(
      'ShewhartChart.deserialize: expected object',
    );
  });

  it('throws "expected object" for JSON string root', () => {
    expect(() => ShewhartChart.deserialize('"hello"')).toThrow(
      'ShewhartChart.deserialize: expected object',
    );
  });
});

// ─── AC-W0-2c: partial entries — bad entries skipped ─────────────────────────

describe('ShewhartChart.deserialize — AC-W0-2c: partial entries', () => {
  it('skips entry with missing deviations array, loads valid entry', () => {
    const json = JSON.stringify({
      valid_cat: validEntry(),
      bad_cat: {
        // deviations is missing
        count: 3,
        sum: 0.6,
        sumSq: 0.14,
        monitoringOnly: false,
        prevAgreementRate: null,
        agreementCount: 2,
      },
    });

    const chart = ShewhartChart.deserialize(json);
    expect(chart.getCategoryStats('valid_cat')).not.toBeNull();
    expect(chart.getCategoryStats('bad_cat')).toBeNull();
  });

  it('skips entry with non-number count, loads valid entry', () => {
    const json = JSON.stringify({
      good: validEntry(),
      bad: validEntry({ count: 'three' }),
    });

    const chart = ShewhartChart.deserialize(json);
    expect(chart.getCategoryStats('good')).not.toBeNull();
    expect(chart.getCategoryStats('bad')).toBeNull();
  });

  it('skips entry with non-boolean monitoringOnly', () => {
    const json = JSON.stringify({
      good: validEntry(),
      bad: validEntry({ monitoringOnly: 1 }),
    });

    const chart = ShewhartChart.deserialize(json);
    expect(chart.getCategoryStats('good')).not.toBeNull();
    expect(chart.getCategoryStats('bad')).toBeNull();
  });

  it('skips entry with invalid prevAgreementRate (not number or null)', () => {
    const json = JSON.stringify({
      good: validEntry(),
      bad: validEntry({ prevAgreementRate: 'high' }),
    });

    const chart = ShewhartChart.deserialize(json);
    expect(chart.getCategoryStats('good')).not.toBeNull();
    expect(chart.getCategoryStats('bad')).toBeNull();
  });

  it('accepts entry with prevAgreementRate = 0 (valid number)', () => {
    const json = JSON.stringify({
      cat: validEntry({ prevAgreementRate: 0 }),
    });

    const chart = ShewhartChart.deserialize(json);
    expect(chart.getCategoryStats('cat')).not.toBeNull();
  });

  it('loads empty object → chart with no categories', () => {
    const chart = ShewhartChart.deserialize('{}');
    expect(chart.getAllStats()).toHaveLength(0);
  });
});

// ─── Roundtrip: serialize → deserialize ──────────────────────────────────────

describe('ShewhartChart.deserialize — roundtrip (backward compat)', () => {
  it('serialize → deserialize → same stats (basic roundtrip)', () => {
    const original = new ShewhartChart(50);

    // Add enough data points to get stats (>= 2 in window)
    for (let i = 0; i < 5; i++) {
      original.addDataPoint(makeRecord({ deviation: i * 0.05, category: 'cat_a' }));
    }
    for (let i = 0; i < 3; i++) {
      original.addDataPoint(makeRecord({ deviation: 0.1 + i * 0.01, category: 'cat_b', monitoringOnly: true }));
    }

    const json = original.serialize();
    const restored = ShewhartChart.deserialize(json, 50);

    const statsA = restored.getCategoryStats('cat_a');
    const statsB = restored.getCategoryStats('cat_b');

    expect(statsA).not.toBeNull();
    expect(statsB).not.toBeNull();
    expect(statsA!.count).toBe(original.getCategoryStats('cat_a')!.count);
    expect(statsA!.mean).toBeCloseTo(original.getCategoryStats('cat_a')!.mean);
    expect(statsB!.count).toBe(original.getCategoryStats('cat_b')!.count);
  });

  it('roundtrip preserves monitoringOnly flag', () => {
    const original = new ShewhartChart(50);
    for (let i = 0; i < 3; i++) {
      original.addDataPoint(makeRecord({ deviation: 0.05, category: 'destructive', monitoringOnly: true }));
    }

    const restored = ShewhartChart.deserialize(original.serialize());
    expect(restored.getCategoryStats('destructive')!.monitoringOnly).toBe(true);
  });

  it('addDataPoint() continues working correctly after deserialize roundtrip', () => {
    const original = new ShewhartChart(50);
    for (let i = 0; i < 10; i++) {
      original.addDataPoint(makeRecord({ deviation: 0.02 * i }));
    }

    const restored = ShewhartChart.deserialize(original.serialize());

    // Adding more points should not throw
    expect(() => {
      restored.addDataPoint(makeRecord({ deviation: 99 })); // large outlier
    }).not.toThrow();
  });
});

// ─── All-non-number deviations → empty array ─────────────────────────────────

describe('ShewhartChart.deserialize — non-number deviations filtered', () => {
  it('filters all non-number values from deviations array', () => {
    // Manually craft JSON with string deviations
    const json = JSON.stringify({
      cat: {
        deviations: ['a', 'b', 'c'],
        count: 3,
        sum: 0.3,
        sumSq: 0.03,
        monitoringOnly: false,
        prevAgreementRate: null,
        agreementCount: 2,
      },
    });

    const chart = ShewhartChart.deserialize(json);
    // Entry is accepted (all other fields valid), but deviations are emptied
    // getCategoryStats returns null when < 2 deviations in window
    expect(chart.getCategoryStats('cat')).toBeNull();
  });

  it('filters mixed deviations: keeps numbers, drops non-numbers', () => {
    const json = JSON.stringify({
      cat: {
        deviations: [0.1, 'bad', 0.2, null, 0.3],
        count: 3,
        sum: 0.6,
        sumSq: 0.14,
        monitoringOnly: false,
        prevAgreementRate: null,
        agreementCount: 2,
      },
    });

    const chart = ShewhartChart.deserialize(json);
    const stats = chart.getCategoryStats('cat');
    // 3 numbers remain → enough for stats
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(3);
  });
});

// ─── Plan46 W2: onCheckpoint / onRestore PluginHooks adapters ────────────────

describe('ShewhartChart - Plan46 W2 onCheckpoint/onRestore (SEC-003 preserved)', () => {
  it('onCheckpoint returns PluginSnapshot with windows JSON and correct identity', () => {
    const chart = new ShewhartChart(50);
    for (let i = 0; i < 5; i++) {
      chart.addDataPoint(makeRecord({ deviation: i * 0.05 }));
    }
    const snap = chart.onCheckpoint();
    expect(snap.pluginName).toBe(SHEWHART_CHART_PLUGIN_NAME);
    expect(snap.schemaVersion).toBe(SHEWHART_CHART_SCHEMA_VERSION);
    expect(typeof snap.state['windows']).toBe('string');
    // state.windows must be parseable (round-trip sanity)
    expect(() => JSON.parse(snap.state['windows'] as string)).not.toThrow();
  });

  it('onRestore rejects snapshots with wrong pluginName', () => {
    const chart = new ShewhartChart(50);
    const bad: PluginSnapshot = {
      pluginName: 'other',
      schemaVersion: 1,
      state: { windows: '{}' },
      timestamp: 0,
    };
    expect(() => chart.onRestore(bad)).toThrow(/pluginName mismatch/);
  });

  it('onRestore rejects unsupported schemaVersion', () => {
    const chart = new ShewhartChart(50);
    const bad: PluginSnapshot = {
      pluginName: SHEWHART_CHART_PLUGIN_NAME,
      schemaVersion: 99,
      state: { windows: '{}' },
      timestamp: 0,
    };
    expect(() => chart.onRestore(bad)).toThrow(/schemaVersion/);
  });

  it('onRestore rejects non-string state.windows', () => {
    const chart = new ShewhartChart(50);
    const bad: PluginSnapshot = {
      pluginName: SHEWHART_CHART_PLUGIN_NAME,
      schemaVersion: 1,
      state: { windows: 42 },
      timestamp: 0,
    };
    expect(() => chart.onRestore(bad)).toThrow(/state.windows must be a JSON string/);
  });

  it('onRestore preserves SEC-003: corrupt JSON in state.windows rejected', () => {
    const chart = new ShewhartChart(50);
    const bad: PluginSnapshot = {
      pluginName: SHEWHART_CHART_PLUGIN_NAME,
      schemaVersion: 1,
      state: { windows: 'definitely not json' },
      timestamp: 0,
    };
    expect(() => chart.onRestore(bad)).toThrow(/invalid JSON/);
  });

  it('onCheckpoint → onRestore round-trips category stats', () => {
    const source = new ShewhartChart(50);
    for (let i = 0; i < 8; i++) {
      source.addDataPoint(makeRecord({ deviation: 0.02 * i, category: 'cat_a' }));
    }
    const snap = source.onCheckpoint();

    const target = new ShewhartChart(50);
    target.onRestore(snap);
    const stats = target.getCategoryStats('cat_a');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(source.getCategoryStats('cat_a')!.count);
  });
});
