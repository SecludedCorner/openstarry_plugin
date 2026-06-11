/**
 * l3-integration.test.ts — L3 factory-level integration test (Rule #63 L4).
 * Validates the full chain: shadow_decision → SPC anomaly → L2 escalation
 *   → L3 gate → pushInput called.
 * @see Plan45 W1, §3.3
 */

import { describe, it, expect, vi } from 'vitest';
import { createSpcMonitorPlugin } from '../index.js';
import type { ShadowDecisionRecord } from '@openstarry-plugin/gear-arbiter-dynamic';
import type { EventBus, AgentEvent, IPluginContext } from '@openstarry/sdk';

// ─── helpers ─────────────────────────────────────────────────────────────────

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
      return this.on(type, handler);
    },
    onAny(handler: (e: AgentEvent) => void) {
      return this.on('*', handler);
    },
    emit(event: AgentEvent) {
      // Propagate to all registered handlers
      const list = handlers.get(event.type) ?? [];
      list.forEach(h => h(event));
    },
  };
}

function makeCtx(bus: EventBus, pushInput: ReturnType<typeof vi.fn>): IPluginContext {
  return {
    bus,
    config: undefined,
    logger: console,
    pushInput,
    services: { register: vi.fn(), get: vi.fn() },
  } as unknown as IPluginContext;
}

// ─── Full chain: shadow_decision → L1 → L2 → L3 → pushInput ─────────────────

describe('L3 Integration: full chain shadow_decision → pushInput (Rule #63 L4)', () => {
  it('pushInput is called with safety:force_conservative_gear when L3 triggers', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const pushInput = vi.fn();
    const ctx = makeCtx(bus, pushInput);

    // Configure plugin: L2 thresholds low for test, L3 enabled with threshold=2
    const plugin = createSpcMonitorPlugin({
      windowSize: 50,
      escalation: {
        windowMs: 300_000,
        thresholds: { watch: 1, warning: 2, critical: 3 }, // low thresholds for test
      },
      safetyGate: {
        enabled: true,
        criticalCategoryThreshold: 2, // need 2 critical categories
        cooldownShadowDecisions: 0,   // no cooldown for test
        cooldownMs: 0,
        forceGear: 1,
      },
    });

    const hooks = await plugin.factory(ctx);

    // Step 1: Establish baseline for two categories (10 normal points each)
    const cats = ['cat-alpha', 'cat-beta'];
    for (const cat of cats) {
      for (let i = 0; i < 10; i++) {
        bus.emit({
          type: 'audit:shadow_decision',
          timestamp: Date.now(),
          payload: makeRecord({ category: cat, deviation: 0 }),
        });
      }
    }

    // pushInput should NOT have been called yet
    expect(pushInput).not.toHaveBeenCalled();

    // Step 2: Drive both categories through L1 anomalies → L2 escalation → critical
    // Each category needs 3 anomalies to reach critical (L2 threshold=3).
    // After each outlier is added the UCL rises, so we send many outliers
    // with progressively larger deviations to guarantee >=3 L1 anomalies per category.
    for (const cat of cats) {
      // Send 8 outliers with very large and growing deviations to reliably
      // produce at least 3 L1 anomaly events per category
      for (let round = 0; round < 8; round++) {
        bus.emit({
          type: 'audit:shadow_decision',
          timestamp: Date.now(),
          payload: makeRecord({ category: cat, deviation: 100 + round * 50, agrees: false }),
        });
      }
    }

    // Step 3: pushInput should now have been called with the safety event
    expect(pushInput).toHaveBeenCalled();
    const call = pushInput.mock.calls[0][0];
    expect(call.source).toBe('spc-monitor');
    expect(call.inputType).toBe('system_event');
    expect(call.data.event).toBe('safety:force_conservative_gear');
    expect(call.data.forceGear).toBe(1);
    expect(typeof call.data.reason).toBe('string');

    hooks.dispose?.();
  });

  it('audit:spc_safety_gate event is emitted when L3 triggers', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const pushInput = vi.fn();
    const ctx = makeCtx(bus, pushInput);

    const plugin = createSpcMonitorPlugin({
      windowSize: 50,
      escalation: {
        windowMs: 300_000,
        thresholds: { watch: 1, warning: 2, critical: 3 },
      },
      safetyGate: {
        enabled: true,
        criticalCategoryThreshold: 2,
        cooldownShadowDecisions: 0,
        cooldownMs: 0,
        forceGear: 1,
      },
    });

    const hooks = await plugin.factory(ctx);
    const safetyGateEvents: AgentEvent[] = [];
    bus.on('audit:spc_safety_gate', (e) => safetyGateEvents.push(e));

    const cats = ['cat-x', 'cat-y'];
    for (const cat of cats) {
      for (let i = 0; i < 10; i++) {
        bus.emit({
          type: 'audit:shadow_decision',
          timestamp: Date.now(),
          payload: makeRecord({ category: cat, deviation: 0 }),
        });
      }
    }
    for (const cat of cats) {
      // Send 8 growing outliers to guarantee >=3 L1 anomaly events per category
      for (let round = 0; round < 8; round++) {
        bus.emit({
          type: 'audit:shadow_decision',
          timestamp: Date.now(),
          payload: makeRecord({ category: cat, deviation: 100 + round * 50, agrees: false }),
        });
      }
    }

    expect(safetyGateEvents.length).toBeGreaterThan(0);
    const gatePayload = safetyGateEvents[0].payload as { triggered: boolean; forceGear: number };
    expect(gatePayload.triggered).toBe(true);
    expect(gatePayload.forceGear).toBe(1);

    hooks.dispose?.();
  });

  it('L3 does NOT trigger when plugin is disabled (enabled=false)', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const pushInput = vi.fn();
    const ctx = makeCtx(bus, pushInput);

    const plugin = createSpcMonitorPlugin({ enabled: false });
    const hooks = await plugin.factory(ctx);

    bus.emit({
      type: 'audit:shadow_decision',
      timestamp: Date.now(),
      payload: makeRecord({ deviation: 100 }),
    });

    expect(pushInput).not.toHaveBeenCalled();
    hooks.dispose?.();
  });

  it('L3 does NOT trigger when safetyGate.enabled=false (default opt-in)', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const pushInput = vi.fn();
    const ctx = makeCtx(bus, pushInput);

    // Safety gate NOT enabled (default)
    const plugin = createSpcMonitorPlugin({
      escalation: { thresholds: { watch: 1, warning: 2, critical: 3 } },
      // safetyGate not provided → defaults to disabled
    });
    const hooks = await plugin.factory(ctx);

    const cats = ['cat-a', 'cat-b'];
    for (const cat of cats) {
      for (let i = 0; i < 10; i++) {
        bus.emit({
          type: 'audit:shadow_decision',
          timestamp: Date.now(),
          payload: makeRecord({ category: cat, deviation: 0 }),
        });
      }
      for (let round = 0; round < 8; round++) {
        bus.emit({
          type: 'audit:shadow_decision',
          timestamp: Date.now(),
          payload: makeRecord({ category: cat, deviation: 100 + round * 50, agrees: false }),
        });
      }
    }

    // Gate is disabled, pushInput must never be called
    expect(pushInput).not.toHaveBeenCalled();
    hooks.dispose?.();
  });

  it('destructive (monitoringOnly) categories do NOT trigger L3 gate', async () => {
    const handlers = new Map<string, ((e: AgentEvent) => void)[]>();
    const bus = makeBus(handlers);
    const pushInput = vi.fn();
    const ctx = makeCtx(bus, pushInput);

    const plugin = createSpcMonitorPlugin({
      escalation: { thresholds: { watch: 1, warning: 2, critical: 3 } },
      safetyGate: {
        enabled: true,
        criticalCategoryThreshold: 2,
        cooldownShadowDecisions: 0,
        cooldownMs: 0,
        forceGear: 1,
      },
    });
    const hooks = await plugin.factory(ctx);

    // Drive 5 destructive (monitoringOnly) categories to critical
    const destructiveCats = ['destructive-1', 'destructive-2', 'destructive-3', 'destructive-4', 'destructive-5'];
    for (const cat of destructiveCats) {
      for (let i = 0; i < 10; i++) {
        bus.emit({
          type: 'audit:shadow_decision',
          timestamp: Date.now(),
          payload: makeRecord({ category: cat, deviation: 0, monitoringOnly: true }),
        });
      }
      // Send 8 growing outliers to reliably produce >=3 L1 anomalies per category
      for (let round = 0; round < 8; round++) {
        bus.emit({
          type: 'audit:shadow_decision',
          timestamp: Date.now(),
          payload: makeRecord({ category: cat, deviation: 100 + round * 50, agrees: false, monitoringOnly: true }),
        });
      }
    }

    // All categories are monitoringOnly → getCriticalCategories() returns []
    // L3 gate must NOT trigger
    expect(pushInput).not.toHaveBeenCalled();
    hooks.dispose?.();
  });
});
