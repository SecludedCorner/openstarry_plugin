/**
 * force-next-gear.test.ts — Unit tests for DynamicArbiter.forceNextGear() (Plan45 W1-3).
 */

import { describe, it, expect } from 'vitest';
import { StateTracker } from '../state-tracker.js';
import { DynamicArbiter } from '../dynamic-arbiter.js';
import type { GearContext } from '@openstarry/sdk';

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

/** Build a DynamicArbiter at gear=2 (enough observations for evaluate to give opinion). */
function buildArbiterAtGear2(): DynamicArbiter {
  const tracker = new StateTracker();
  // Add enough high-deviation deltas so the arbiter wants gear 2
  // UP threshold = 0.047; with mean well above UP, arbiter will eventually reach gear 2
  for (let i = 0; i < 20; i++) {
    tracker.recordDelta(0.1);
    tracker.recordObservation('read_only');
  }
  const arbiter = new DynamicArbiter({ stateTracker: tracker, initialGear: 2 });
  return arbiter;
}

/** Build a DynamicArbiter at gear=1 (cold start). */
function buildArbiterAtGear1(): DynamicArbiter {
  const tracker = new StateTracker();
  for (let i = 0; i < 15; i++) {
    tracker.recordDelta(0.0);
    tracker.recordObservation('read_only');
  }
  return new DynamicArbiter({ stateTracker: tracker, initialGear: 1 });
}

// ─── AC-W1-3a: forceNextGear(gear <= current) sets override ──────────────────

describe('DynamicArbiter.forceNextGear - accepts conservative gear (AC-W1-3a)', () => {
  it('forceNextGear(1) when currentGear=2 sets override (gear <= current)', () => {
    const arbiter = buildArbiterAtGear2();

    // Verify current gear is 2
    expect(arbiter.getState().gear).toBe(2);

    // Force to gear=1 (conservative, 1 <= 2)
    arbiter.forceNextGear(1);

    // evaluate() should consume the override and return gear=1
    const result = arbiter.evaluate(makeContext());
    expect(result.action).toBe(1);
  });

  it('forceNextGear(2) when currentGear=2 is accepted (gear == current)', () => {
    const arbiter = buildArbiterAtGear2();
    arbiter.forceNextGear(2);

    const result = arbiter.evaluate(makeContext());
    expect(result.action).toBe(2);
  });
});

// ─── AC-W1-3b: forceNextGear(gear > current) is silently no-op ───────────────

describe('DynamicArbiter.forceNextGear - rejects non-conservative gear (AC-W1-3b)', () => {
  it('forceNextGear(2) when currentGear=1 is silently ignored (gear > current)', () => {
    const arbiter = buildArbiterAtGear1();

    // Verify current gear is 1
    expect(arbiter.getState().gear).toBe(1);

    // Attempt to force up to gear=2 — should be silently ignored
    arbiter.forceNextGear(2);

    // evaluate() should NOT use the override; normal evaluation proceeds
    const result = arbiter.evaluate(makeContext());

    // Since deltas are 0 (mean=0, below UP=0.047), normal eval returns gear=1
    // The key invariant is: gear did NOT become 2 via the forceNextGear path
    // (It may still be 1 from normal evaluation)
    // We verify the reasoning does NOT mention L3 override
    expect(result.reasoning).not.toContain('L3 safety gate');
  });

  it('forceNextGear(3) when currentGear=1 is silently ignored', () => {
    const arbiter = buildArbiterAtGear1();
    arbiter.forceNextGear(3);

    const result = arbiter.evaluate(makeContext());
    expect(result.reasoning).not.toContain('L3 safety gate');
  });
});

// ─── AC-W1-3c: override is one-shot (consumed after single evaluate) ─────────

describe('DynamicArbiter.forceNextGear - one-shot consume (AC-W1-3c)', () => {
  it('forcedNextGear is consumed on first evaluate() and does not persist', () => {
    const arbiter = buildArbiterAtGear2();
    arbiter.forceNextGear(1);

    // First evaluate: consumes override → returns gear=1 with L3 reasoning
    const r1 = arbiter.evaluate(makeContext());
    expect(r1.action).toBe(1);
    expect(r1.reasoning).toContain('L3 safety gate');

    // Second evaluate: override is gone, normal evaluation resumes
    const r2 = arbiter.evaluate(makeContext());
    expect(r2.reasoning).not.toContain('L3 safety gate');
  });
});

// ─── AC-W1-3d: without override, evaluate() works normally ───────────────────

describe('DynamicArbiter.forceNextGear - backward compatibility (AC-W1-3d)', () => {
  it('evaluate() works normally when no forceNextGear has been called', () => {
    const tracker = new StateTracker();
    for (let i = 0; i < 15; i++) {
      tracker.recordDelta(0);
      tracker.recordObservation('read_only');
    }
    const arbiter = new DynamicArbiter({ stateTracker: tracker });

    const result = arbiter.evaluate(makeContext());
    // With mean=0 (below UP threshold), arbiter stays at gear=1 or abstains
    expect(result.action).not.toBe(undefined);
    expect(result.reasoning).not.toContain('L3 safety gate');
  });

  it('normal gear transitions work without override', () => {
    const tracker = new StateTracker();
    // Not enough observations: abstain
    tracker.recordObservation('read_only');
    const arbiter = new DynamicArbiter({ stateTracker: tracker });
    const result = arbiter.evaluate(makeContext());
    expect(result.action).toBe('abstain');
  });
});
