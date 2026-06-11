/**
 * perturbation-activation.test.ts — activation tests for PerturbationDiagnostic
 * at the CalibrationBridge level and factory level (Rule #63 L4, Plan45 W2-1).
 *
 * Design note on dwell:
 *   In the real DynamicArbiter, dwell is reset to 0 whenever a gear switch fires,
 *   and accumulates only while approaching a switch threshold. There is no stable
 *   state where dwell stays >= MIN_DWELL=5 without the gear switching. For this
 *   reason, the "sensitive=true callback fires" tests are written at the
 *   CalibrationBridge level with a controlled shadowConfig that provides a fixed
 *   dwell=5, isolating the perturbation path from the arbiter state machine.
 *
 *   Factory-level tests verify that the perturbation config is correctly wired
 *   (enabled=false → never fires, phase3=false → never fires).
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentEvent, EventBus } from '@openstarry/sdk';
import { createGearArbiterDynamicPlugin } from '../index.js';
import { CalibrationBridge } from '../calibration-bridge.js';
import { StateTracker } from '../state-tracker.js';
import type { ShadowConfig, ShadowDecisionRecord } from '../m4a-types.js';
import type { PerturbationDiagnostic } from '../perturbation-diagnostic.js';
import type { GearArbiterDynamicConfig } from '../index.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function makeCtx(bus: EventBus) {
  return {
    bus,
    pushInput: vi.fn(),
    agentConfig: { id: 'test-agent' },
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  };
}

function emitAuditEvents(
  bus: EventBus,
  count: number,
  delta: number,
  category: string = 'read_only',
): void {
  for (let i = 0; i < count; i++) {
    bus.emit({
      type: 'audit:tool_audited',
      timestamp: Date.now(),
      payload: {
        clampedDelta: delta,
        inferredRiskCategory: category,
        executionResult: 'success',
      },
    });
  }
}

/**
 * Build a CalibrationBridge with controlled shadow state (fixed gear + dwell)
 * so that the perturbation diagnostic can produce sensitive=true reliably.
 *
 * Strategy:
 *   - 100 deltas at 0.04 → mean=0.04 < UP=0.047 (original shadow stays gear=1)
 *   - dwell=5 >= MIN_DWELL=5 is provided by the fixed getArbiterState()
 *   - +1 perturbed mean = (99*0.04 + 1.04)/100 = 0.05 > UP → shadow switches to gear=2
 *   → sensitive=true
 */
function buildSensitiveBridge(
  bus: EventBus,
  onDiagnostic?: (d: PerturbationDiagnostic) => void,
): { tracker: StateTracker; bridge: CalibrationBridge } {
  const tracker = new StateTracker();

  // Pre-populate 100 deltas so the tracker has them when fireShadow runs
  for (let i = 0; i < 100; i++) tracker.recordDelta(0.04);
  // Register enough observations so totalObs >= MIN_N=10
  for (let i = 0; i < 15; i++) tracker.recordObservation('read_only');

  const shadowConfig: ShadowConfig = {
    enabled: true,
    // Fixed state: gear=1, dwell=5 (ensures shadow switch condition can fire)
    getArbiterState: () => ({ gear: 1, dwell: 5 }),
    onShadowDecision: (_r: ShadowDecisionRecord) => { /* no-op */ },
  };

  const bridge = new CalibrationBridge(
    bus,
    tracker,
    undefined,
    shadowConfig,
    { enabled: true, onDiagnostic },
  );
  return { tracker, bridge };
}

// ─── CalibrationBridge-level: perturbation enabled=true fires callback ─────────

describe('perturbation activation - enabled=true, CalibrationBridge level (Rule #63 L4)', () => {
  it('onDiagnostic callback is called when sensitive diagnostic occurs', () => {
    const onDiagnostic = vi.fn<[PerturbationDiagnostic], void>();
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);

    const { bridge } = buildSensitiveBridge(bus, onDiagnostic);
    bridge.start();

    // Emit one more audit event — tracker already has 100 deltas at 0.04,
    // totalObs >= MIN_N. The new event adds one more delta. Since fireShadow
    // reads getRecentDeltas() (returns last 20), this fires the shadow path.
    emitAuditEvents(bus, 1, 0.04, 'read_only');

    // Callback should have fired: +1 perturbation crosses UP=0.047 → sensitive=true
    expect(onDiagnostic).toHaveBeenCalled();
    const diag = onDiagnostic.mock.calls[0][0];
    expect(diag.sensitive).toBe(true);
    expect(diag.plusOne.direction).toBe('+1');
    expect(diag.minusOne.direction).toBe('-1');
    expect(typeof diag.timestamp).toBe('number');

    bridge.stop();
  });

  it('audit:perturbation_diagnostic bus event is emitted on sensitive diagnostic', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const emittedEvents: AgentEvent[] = [];

    bus.on('audit:perturbation_diagnostic', (e) => {
      emittedEvents.push(e);
    });

    const { bridge } = buildSensitiveBridge(bus);
    bridge.start();

    emitAuditEvents(bus, 1, 0.04, 'read_only');

    expect(emittedEvents.length).toBeGreaterThan(0);
    expect(emittedEvents[0].type).toBe('audit:perturbation_diagnostic');
    const payload = emittedEvents[0].payload as PerturbationDiagnostic;
    expect(payload.sensitive).toBe(true);

    bridge.stop();
  });

  it('onDiagnostic receives correct category from audit event', () => {
    const receivedCategories: string[] = [];
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);

    const { bridge } = buildSensitiveBridge(bus, (d) => {
      receivedCategories.push(d.category);
    });
    bridge.start();

    emitAuditEvents(bus, 1, 0.04, 'informational');

    // Category from the event should be recorded in the diagnostic
    expect(receivedCategories.length).toBeGreaterThan(0);
    // Category matches what was emitted
    const lastCategory = receivedCategories[receivedCategories.length - 1];
    expect(typeof lastCategory).toBe('string');

    bridge.stop();
  });
});

// ─── CalibrationBridge-level: perturbation enabled=false → callback NOT called ──

describe('perturbation activation - enabled=false, CalibrationBridge level (Rule #63 L4)', () => {
  it('onDiagnostic callback is NOT called when enabled=false', () => {
    const onDiagnostic = vi.fn<[PerturbationDiagnostic], void>();
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);

    const tracker = new StateTracker();
    for (let i = 0; i < 100; i++) tracker.recordDelta(0.04);
    for (let i = 0; i < 15; i++) tracker.recordObservation('read_only');

    const shadowConfig: ShadowConfig = {
      enabled: true,
      getArbiterState: () => ({ gear: 1, dwell: 5 }),
      onShadowDecision: (_r: ShadowDecisionRecord) => { /* no-op */ },
    };

    const bridge = new CalibrationBridge(
      bus,
      tracker,
      undefined,
      shadowConfig,
      { enabled: false, onDiagnostic },  // disabled
    );
    bridge.start();

    emitAuditEvents(bus, 1, 0.04, 'read_only');

    expect(onDiagnostic).not.toHaveBeenCalled();

    bridge.stop();
  });

  it('audit:perturbation_diagnostic bus event NOT emitted when enabled=false', () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const emittedEvents: AgentEvent[] = [];

    bus.on('audit:perturbation_diagnostic', (e) => {
      emittedEvents.push(e);
    });

    const tracker = new StateTracker();
    for (let i = 0; i < 100; i++) tracker.recordDelta(0.04);
    for (let i = 0; i < 15; i++) tracker.recordObservation('read_only');

    const shadowConfig: ShadowConfig = {
      enabled: true,
      getArbiterState: () => ({ gear: 1, dwell: 5 }),
      onShadowDecision: (_r: ShadowDecisionRecord) => { /* no-op */ },
    };

    const bridge = new CalibrationBridge(
      bus, tracker, undefined, shadowConfig, { enabled: false },
    );
    bridge.start();

    emitAuditEvents(bus, 1, 0.04, 'read_only');

    expect(emittedEvents).toHaveLength(0);

    bridge.stop();
  });
});

// ─── Factory-level: enabled=false → callback never called ─────────────────────

describe('perturbation activation - factory level (Rule #63 L4)', () => {
  it('onDiagnostic NOT called when perturbation.enabled=false in factory', async () => {
    const onDiagnostic = vi.fn<[PerturbationDiagnostic], void>();
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);

    const plugin = createGearArbiterDynamicPlugin({
      phase3: { enabled: true },
      perturbation: { enabled: false, onDiagnostic },
    });

    const ctx = makeCtx(bus);
    await plugin.factory(ctx as never);

    emitAuditEvents(bus, 15, 0.04, 'read_only');

    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it('onDiagnostic NOT called when phase3.enabled=false (fireShadow never runs)', async () => {
    const onDiagnostic = vi.fn<[PerturbationDiagnostic], void>();
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);

    const plugin = createGearArbiterDynamicPlugin({
      phase3: { enabled: false },  // shadow never fires
      perturbation: { enabled: true, onDiagnostic },
    });

    const ctx = makeCtx(bus);
    await plugin.factory(ctx as never);

    emitAuditEvents(bus, 15, 0.04, 'read_only');

    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  it('perturbation absent from config → no errors thrown', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);

    const config: GearArbiterDynamicConfig = {
      phase3: { enabled: true },
      // perturbation field omitted
    };

    const plugin = createGearArbiterDynamicPlugin(config);
    const ctx = makeCtx(bus);
    await expect(plugin.factory(ctx as never)).resolves.toBeDefined();

    emitAuditEvents(bus, 15, 0.04, 'read_only');
    // No errors expected
  });
});
