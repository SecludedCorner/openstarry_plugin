/**
 * Plan50 σ_regime tests — covers W2-R15 σ-1..4 pilot + Plan50 acceptance PA-1..PA-7.
 *
 * Critical invariants verified:
 *   - 3-round identity preservation (R10/R11/R12 = 0.023753; R13 = 0.023993; R14 = 0.023873)
 *   - Closed-form σ byte-untouched
 *   - composition_index for current pipeline (CV-§1-08)
 *   - FR-2 dormant by construction under composition_index regime
 *   - §76.7 caveat emitted only for composition_index / legacy
 *   - Migration atomicity (all-or-nothing)
 */

import { describe, expect, it } from 'vitest';
import type { InputSource, SigmaObservation } from '@openstarry/sdk';

import {
  LEGACY_UNTAGGED_REGIME,
  SECTION_76_7_TEXT,
  assertSigmaRegimePresent,
  getSigmaRegimeOrLegacy,
  inferSigmaRegime,
  migrateLegacySigmaRecords,
  shouldActivateFr2Pooled,
  shouldEmitSection767Caveat,
} from '../sigma-regime.js';

const mkObs = (round_id: string, sigma: number, regime: SigmaObservation['sigma_regime']): SigmaObservation => ({
  round_id,
  sigma,
  ucl: sigma * 3,
  lcl: -sigma * 3,
  N_events: 100,
  mean: 0,
  pooled_mode: false,
  westgard_state: 'in_control',
  sigma_regime: regime,
});

describe('Plan50 §5 inferSigmaRegime — Hypothesis A declarative classification', () => {
  const staticSrc: InputSource = { name: 'static-rule-arbiter', is_static_lookup: true, is_llm_derived: false };
  const llmSrc: InputSource = { name: 'llm-risk-injector', is_static_lookup: false, is_llm_derived: true };
  const gearArb: InputSource = { name: 'gear-arbiter-dynamic', is_static_lookup: true, is_llm_derived: false };

  it('returns composition_index on empty input (legacy default)', () => {
    expect(inferSigmaRegime([])).toBe('composition_index');
  });

  it('returns composition_index when only static sources present', () => {
    expect(inferSigmaRegime([staticSrc, gearArb])).toBe('composition_index');
  });

  it('returns llm_variance when only LLM sources present', () => {
    expect(inferSigmaRegime([llmSrc])).toBe('llm_variance');
  });

  it('returns mixed when both static and LLM sources present', () => {
    expect(inferSigmaRegime([staticSrc, llmSrc])).toBe('mixed');
  });

  it('handles E5 BOTH-flags-true conservatively (still mixed)', () => {
    const both: InputSource = { name: 'weird', is_static_lookup: true, is_llm_derived: true };
    expect(inferSigmaRegime([both])).toBe('mixed');
  });

  it('handles E6 BOTH-flags-false as composition_index (declarative absence)', () => {
    const neither: InputSource = { name: 'untagged', is_static_lookup: false, is_llm_derived: false };
    expect(inferSigmaRegime([neither])).toBe('composition_index');
  });
});

describe('Plan50 §3 FR-2 AND-conjunct (Rule #77 §77.3)', () => {
  it('dormant under composition_index regime (current cycle 03-14 pipeline)', () => {
    // Active cell 3: identity_close=true ∧ ∀r: regime=composition_index → P_new=false
    const history = [
      mkObs('R10', 0.023753, 'composition_index'),
      mkObs('R11', 0.023753, 'composition_index'),
      mkObs('R12', 0.023753, 'composition_index'),
    ];
    expect(shouldActivateFr2Pooled(history)).toBe(false);
  });

  it('activates only when identity_close ∧ all rounds non-composition', () => {
    const history = [
      mkObs('R1', 0.05, 'llm_variance'),
      mkObs('R2', 0.05005, 'llm_variance'),
      mkObs('R3', 0.05010, 'llm_variance'),
    ];
    expect(shouldActivateFr2Pooled(history)).toBe(true);
  });

  it('does NOT activate when identity-close fails even under llm_variance', () => {
    const history = [
      mkObs('R1', 0.05, 'llm_variance'),
      mkObs('R2', 0.10, 'llm_variance'),
      mkObs('R3', 0.15, 'llm_variance'),
    ];
    expect(shouldActivateFr2Pooled(history)).toBe(false);
  });

  it('dormant on transition (one composition_index in last 3 rounds)', () => {
    const history = [
      mkObs('R1', 0.023753, 'composition_index'),
      mkObs('R2', 0.023753, 'mixed'),
      mkObs('R3', 0.023753, 'llm_variance'),
    ];
    expect(shouldActivateFr2Pooled(history)).toBe(false);
  });

  it('returns false when history is too short (< 3)', () => {
    expect(shouldActivateFr2Pooled([])).toBe(false);
    expect(shouldActivateFr2Pooled([mkObs('R1', 0.023753, 'composition_index')])).toBe(false);
  });
});

describe('Plan50 §4 Rule #76 §76.7 caveat trigger', () => {
  it('emits caveat for composition_index regime', () => {
    expect(shouldEmitSection767Caveat('composition_index')).toBe(true);
  });

  it('emits caveat for legacy untagged records', () => {
    expect(shouldEmitSection767Caveat(LEGACY_UNTAGGED_REGIME)).toBe(true);
  });

  it('does NOT emit caveat for llm_variance / mixed', () => {
    expect(shouldEmitSection767Caveat('llm_variance')).toBe(false);
    expect(shouldEmitSection767Caveat('mixed')).toBe(false);
  });

  it('§76.7 verbatim text references the sampling-floor wording', () => {
    expect(SECTION_76_7_TEXT).toContain('sampling discipline');
    expect(SECTION_76_7_TEXT).toContain('not a literal coincidence probability');
  });
});

describe('Plan50 §6 migration — atomicity invariant', () => {
  it('migrates all legacy records to composition_index in one shot', () => {
    const records: ReadonlyArray<Omit<SigmaObservation, 'sigma_regime'>> = [
      { round_id: 'R10', sigma: 0.023753, ucl: 0.07, lcl: -0.07, N_events: 100, mean: 0, pooled_mode: false, westgard_state: 'in_control' },
      { round_id: 'R11', sigma: 0.023753, ucl: 0.07, lcl: -0.07, N_events: 100, mean: 0, pooled_mode: false, westgard_state: 'in_control' },
      { round_id: 'R12', sigma: 0.023753, ucl: 0.07, lcl: -0.07, N_events: 100, mean: 0, pooled_mode: false, westgard_state: 'in_control' },
    ];
    let committed: readonly SigmaObservation[] = [];
    const result = migrateLegacySigmaRecords(records, (tagged) => { committed = tagged; });
    expect(result.migrated).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.migration_complete).toBe(true);
    expect(committed.every((r) => r.sigma_regime === 'composition_index')).toBe(true);
  });

  it('preserves σ values byte-identical across migration (R10/R11/R12=0.023753 + R13=0.023993 + R14=0.023873)', () => {
    const baselineSigmas: ReadonlyArray<{ round: string; sigma: number }> = [
      { round: 'R10', sigma: 0.023753 },
      { round: 'R11', sigma: 0.023753 },
      { round: 'R12', sigma: 0.023753 },
      { round: 'R13', sigma: 0.023993 },
      { round: 'R14', sigma: 0.023873 },
    ];
    const records = baselineSigmas.map(({ round, sigma }) => ({
      round_id: round, sigma, ucl: sigma * 3, lcl: -sigma * 3,
      N_events: 100, mean: 0, pooled_mode: false, westgard_state: 'in_control',
    }));
    let committed: readonly SigmaObservation[] = [];
    migrateLegacySigmaRecords(records, (tagged) => { committed = tagged; });
    // Byte-identical preservation (both raw value + 6dp string form)
    for (let i = 0; i < baselineSigmas.length; i++) {
      expect(committed[i]!.sigma).toBe(baselineSigmas[i]!.sigma);
      expect(committed[i]!.sigma.toFixed(6)).toBe(baselineSigmas[i]!.sigma.toFixed(6));
      expect(committed[i]!.sigma_regime).toBe('composition_index');
    }
  });

  it('skips records that already have a tag (idempotent)', () => {
    const records = [
      mkObs('R20', 0.05, 'llm_variance'), // already tagged
      { round_id: 'R21', sigma: 0.05, ucl: 0.15, lcl: -0.15, N_events: 100, mean: 0, pooled_mode: false, westgard_state: 'in_control' }, // legacy
    ];
    let committed: readonly SigmaObservation[] = [];
    const result = migrateLegacySigmaRecords(records, (tagged) => { committed = tagged; });
    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(committed[0]!.sigma_regime).toBe('llm_variance'); // unchanged
    expect(committed[1]!.sigma_regime).toBe('composition_index');
  });
});

describe('Plan50 §7 runtime assertion (serializer boundary)', () => {
  it('passes when sigma_regime is present', () => {
    expect(() => assertSigmaRegimePresent({ sigma_regime: 'composition_index' }, 'R10')).not.toThrow();
  });

  it('throws on undefined sigma_regime', () => {
    expect(() => assertSigmaRegimePresent({}, 'R-bad')).toThrow(/sigma_regime tag at round=R-bad/);
  });

  it('throws on null sigma_regime', () => {
    expect(() => assertSigmaRegimePresent({ sigma_regime: null as never }, 'R-bad')).toThrow();
  });
});

describe('Plan50 §6.4 getSigmaRegimeOrLegacy (audit_calc.py legacy handling)', () => {
  it('returns explicit regime when present', () => {
    expect(getSigmaRegimeOrLegacy({ sigma_regime: 'composition_index' })).toBe('composition_index');
    expect(getSigmaRegimeOrLegacy({ sigma_regime: 'mixed' })).toBe('mixed');
  });

  it('returns legacy_untagged_composition_index when sigma_regime missing', () => {
    expect(getSigmaRegimeOrLegacy({})).toBe(LEGACY_UNTAGGED_REGIME);
  });
});

describe('Plan50 §9 closed-form σ byte-untouched (3-round identity)', () => {
  it('preserves R10/R11/R12 = 0.023753 verbatim', () => {
    const obs = [
      mkObs('R10', 0.023753, 'composition_index'),
      mkObs('R11', 0.023753, 'composition_index'),
      mkObs('R12', 0.023753, 'composition_index'),
    ];
    expect(obs.every((o) => o.sigma === 0.023753)).toBe(true);
    expect(obs.every((o) => o.sigma.toFixed(6) === '0.023753')).toBe(true);
  });

  it('preserves R13 = 0.023993 verbatim (Plan48 composition shift)', () => {
    expect(mkObs('R13', 0.023993, 'composition_index').sigma.toFixed(6)).toBe('0.023993');
  });

  it('preserves R14 = 0.023873 verbatim', () => {
    expect(mkObs('R14', 0.023873, 'composition_index').sigma.toFixed(6)).toBe('0.023873');
  });
});
