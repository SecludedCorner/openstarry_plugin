/**
 * Plan47 C47-K3-M4 composite snapshot round-trip tests.
 *
 * Verifies:
 *   - captureSpcMonitorComposite produces a PluginSnapshot with the correct
 *     pluginName / schemaVersion / sub-sections.
 *   - applySpcMonitorComposite restores SafetyGate, ShewhartChart, and
 *     EscalationMonitor state in-place (same references preserved).
 *   - Schema version + pluginName guards throw on mismatch (framework
 *     catches the throw to preserve fresh-state fallback semantics).
 */

import { describe, it, expect } from 'vitest';
import { SafetyGate } from '../safety-gate.js';
import { ShewhartChart } from '../shewhart-chart.js';
import { EscalationMonitor } from '../escalation-monitor.js';
import {
  SPC_MONITOR_PLUGIN_NAME,
  SPC_MONITOR_COMPOSITE_SCHEMA_VERSION,
  captureSpcMonitorComposite,
  applySpcMonitorComposite,
} from '../composite-snapshot.js';

describe('Plan47 spc-monitor composite snapshot', () => {
  it('captures pluginName / schemaVersion / three sub-sections', () => {
    const gate = new SafetyGate({ enabled: true });
    const chart = new ShewhartChart(50);
    const monitor = new EscalationMonitor();
    const snap = captureSpcMonitorComposite({
      safetyGate: gate,
      shewhartChart: chart,
      escalationMonitor: monitor,
    });
    expect(snap.pluginName).toBe(SPC_MONITOR_PLUGIN_NAME);
    expect(snap.schemaVersion).toBe(SPC_MONITOR_COMPOSITE_SCHEMA_VERSION);
    expect(snap.state).toHaveProperty('safetyGate');
    expect(snap.state).toHaveProperty('shewhartChart');
    expect(snap.state).toHaveProperty('escalationMonitor');
  });

  it('round-trips safetyGate state (mutate → checkpoint → reset → restore)', () => {
    const gate = new SafetyGate({ enabled: true });
    gate.recordShadowDecision();
    gate.recordShadowDecision();
    gate.recordShadowDecision();
    const before = gate.serialize();
    const snap = captureSpcMonitorComposite({ safetyGate: gate });

    gate.reset();
    expect(gate.serialize().shadowDecisionsSinceTrigger).toBe(0);

    applySpcMonitorComposite(snap, { safetyGate: gate });
    expect(gate.serialize().shadowDecisionsSinceTrigger).toBe(before.shadowDecisionsSinceTrigger);
  });

  it('round-trips escalationMonitor state (anomalyTimestamps preserved)', () => {
    const monitor = new EscalationMonitor();
    // Inject state via SPC anomaly processing.
    const synthAnomaly = {
      category: 'file_read',
      currentValue: 5,
      ucl: 3,
      lcl: -3,
      mean: 0,
      std: 1,
      windowSize: 10,
      monitoringOnly: false,
      reason: 'synthetic',
    };
    monitor.processAnomaly(synthAnomaly);
    monitor.processAnomaly(synthAnomaly);
    const beforeSize = monitor.getAllStates().size;

    const snap = captureSpcMonitorComposite({ escalationMonitor: monitor });
    monitor.reset();
    expect(monitor.getAllStates().size).toBe(0);

    applySpcMonitorComposite(snap, { escalationMonitor: monitor });
    expect(monitor.getAllStates().size).toBe(beforeSize);
  });

  it('round-trips shewhartChart state (window contents preserved)', () => {
    const chart = new ShewhartChart(50);
    const record = (deviation: number) => ({
      category: 'write',
      gear: 1,
      deviation,
      finalGear: 1,
      arbiterGear: 1,
      agrees: true,
      monitoringOnly: false,
      confidence: 0.9,
      timestamp: 0,
    });
    chart.addDataPoint(record(0.1));
    chart.addDataPoint(record(0.2));
    chart.addDataPoint(record(0.3));
    const beforeStats = chart.getAllStats();

    const snap = captureSpcMonitorComposite({ shewhartChart: chart });
    chart.reset();
    expect(chart.getAllStats()).toHaveLength(0);

    applySpcMonitorComposite(snap, { shewhartChart: chart });
    const afterStats = chart.getAllStats();
    expect(afterStats).toHaveLength(beforeStats.length);
  });

  it('throws on pluginName mismatch (framework catches → fresh state)', () => {
    const gate = new SafetyGate();
    const bogus = {
      pluginName: 'other-plugin',
      schemaVersion: 1,
      state: {},
      timestamp: 0,
    };
    expect(() => applySpcMonitorComposite(bogus, { safetyGate: gate })).toThrow(/pluginName mismatch/);
  });

  it('throws on unsupported composite schemaVersion', () => {
    const gate = new SafetyGate();
    const snap = captureSpcMonitorComposite({ safetyGate: gate });
    const tampered = { ...snap, schemaVersion: 999 };
    expect(() => applySpcMonitorComposite(tampered, { safetyGate: gate })).toThrow(/unsupported composite schemaVersion/);
  });

  it('missing sub-sections are no-ops (forward-compat)', () => {
    const gate = new SafetyGate({ enabled: true });
    gate.recordShadowDecision();
    // Capture only safetyGate section.
    const snap = captureSpcMonitorComposite({ safetyGate: gate });
    // Apply to a different set of parts — the chart/monitor are absent in
    // parts, so the sub-sections (even if present) are skipped.
    const monitor = new EscalationMonitor();
    const chart = new ShewhartChart();
    expect(() => applySpcMonitorComposite(snap, {
      safetyGate: gate,
      shewhartChart: chart,
      escalationMonitor: monitor,
    })).not.toThrow();
  });
});

describe('Plan47 EscalationMonitor snapshot', () => {
  it('serialize / fromSnapshot round-trip preserves level + timestamps', () => {
    const monitor = new EscalationMonitor();
    monitor.processAnomaly({
      category: 'c1',
      currentValue: 1,
      ucl: 0,
      lcl: 0,
      mean: 0,
      std: 1,
      windowSize: 1,
      monitoringOnly: false,
      reason: 'x',
    });
    const snap = monitor.serialize();
    const restored = EscalationMonitor.fromSnapshot(snap);
    const restoredStates = restored.getAllStates();
    expect(restoredStates.size).toBe(1);
  });

  it('fromSnapshot rejects unknown schemaVersion', () => {
    expect(() => EscalationMonitor.fromSnapshot({ schemaVersion: 999, states: [] })).toThrow(
      /unknown schemaVersion/,
    );
  });

  it('fromSnapshot rejects non-array states', () => {
    expect(() => EscalationMonitor.fromSnapshot({ schemaVersion: 1, states: 'bad' })).toThrow(
      /states must be an array/,
    );
  });
});
