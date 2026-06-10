/**
 * sigma-regime — Plan50 in-place σ_regime annotation machinery.
 *
 * Implements the 50-LOC BINDING budget (Option γ rebudget per cycle 03-14 R3
 * D-§2-Q1+Q2+Q4 UNANIMOUS + MRB-§2-01 RESOLVED):
 *
 *   §1 closed enum + struct field          (in SDK; types/sigma-regime.ts)
 *   §2 emission-path propagation             (consumers wire this in; thin)
 *   §3 FR-2 AND-conjunct                     (3 LOC, this module)
 *   §4 Rule #76 §76.7 caveat trigger         (5 LOC + verbatim text)
 *   §5 inference helper Hypothesis A         (13 LOC; declarative)
 *   §6 migration helper with atomicity wrap  (9 LOC; staging → canonical)
 *   §7 runtime assertion                     (3 LOC; serializer boundary)
 *
 * **MR-6 posture**: lives under `openstarry_plugin/`, NOT `packages/core/`.
 * **Critical invariant**: σ closed-form computation byte-untouched; baseline
 * σ values (R10/R11/R12=0.023753 / R13=0.023993 / R14=0.023873) preserved
 * verbatim post-tagging.
 *
 * @see openstarry_doc/Technical_Specifications/Plan50_Sigma_Regime_Binding.md
 * @see packages/sdk/src/types/sigma-regime.ts (closed enum + observation type)
 */

import type {
  InputSource,
  SigmaObservation,
  SigmaRegime,
} from '@openstarry/sdk';

/**
 * Provenance string for retroactively-tagged pre-Plan50 records (per Option A
 * inline-string discipline; no separate provenance helper to save 3 LOC).
 */
export const RETROACTIVE_LEGACY_PROVENANCE =
  'retroactive_legacy_pre_plan50_default' as const;

/**
 * Legacy default tag for σ records read after Plan50 ships but written
 * before migration completed (e.g. a transient gap during atomic-rename).
 * audit_calc.py uses this to distinguish from explicit composition_index.
 */
export const LEGACY_UNTAGGED_REGIME = 'legacy_untagged_composition_index' as const;

/**
 * Rule #76 §76.7 verbatim text (cycle 03-13 O3 §C.4.1 lines 376-384;
 * CV-§2-03 reaffirm). Reproduced byte-identical here so the runtime emit
 * path does not depend on doc-side updates.
 */
export const SECTION_76_7_TEXT = `\
§76.7 Scope caveat — When σ is demonstrably rule-deterministic (σ is a composition
      index rather than stochastic variance, e.g. via 3-round identity or event-count
      vector hash identity), P(coincidence) ≤ 10⁻⁴⁸ is a conservative upper bound
      reflecting sampling discipline, not a literal coincidence probability. The bound
      remains sound as a sampling-floor statement; it is not a statement about LLM
      stochasticity in these cases. See cycle03-13 R4 O3 §C (core trio chapter) for
      derivation; see Plan50 σ_regime annotation for the regime-tagging machinery.`;

/**
 * Plan50 §5 — inference helper, Hypothesis A declarative.
 *
 * Classification (priority order):
 *   1. has_llm AND has_static → "mixed"
 *   2. has_llm only           → "llm_variance"
 *   3. otherwise (all static, or empty) → "composition_index"
 *
 * Rejected alternatives (CV-§2-04 reaffirm):
 *   - B (runtime entropy probe) — > 50 LOC blowing budget; F-13/F-14 already
 *     cover mis-declaration.
 *   - C (hash-identity on output sample) — re-introduces 3-round ambiguity.
 *
 * Threat-model gap: manifest mistake → F-13 + F-14 runtime probes catch
 * mis-declared `is_llm_derived=false`. Adversarial forgery → out of Plan50
 * scope; HMAC manifest signature reserved as ENG-FAB F-18 candidate.
 */
export function inferSigmaRegime(inputSources: readonly InputSource[]): SigmaRegime {
  if (inputSources.length === 0) return 'composition_index'; // empty / legacy
  let hasLlm = false;
  let hasStatic = false;
  for (const src of inputSources) {
    if (src.is_llm_derived) hasLlm = true;
    if (src.is_static_lookup) hasStatic = true;
  }
  if (hasLlm && hasStatic) return 'mixed';
  if (hasLlm) return 'llm_variance';
  return 'composition_index';
}

/**
 * Plan50 §3 — FR-2 pooled-mode AND-conjunct (Rule #77 §77.3 amendment).
 *
 * Activation predicate (3 LOC net delta over pre-Plan50 baseline):
 *   P_new = (max(σᵢ) − min(σᵢ) ≤ 0.0001 over last 3 rounds)
 *           ∧ (∀ r ∈ last3: r.sigma_regime ≠ "composition_index")
 *
 * **Critical**: under cycle 03-14 codebase σ_regime ≡ composition_index for
 * every round → second conjunct false → FR-2 dormant by construction.
 * Plan50 ships NO behavior change for current pipeline.
 */
export function shouldActivateFr2Pooled(
  history: readonly SigmaObservation[],
): boolean {
  if (history.length < 3) return false;
  const last3 = history.slice(-3);
  const sigmas = last3.map((o) => o.sigma);
  const identityClose = Math.max(...sigmas) - Math.min(...sigmas) <= 0.0001;
  const allNonComposition = last3.every((o) => o.sigma_regime !== 'composition_index');
  return identityClose && allNonComposition;
}

/**
 * Plan50 §4 — Rule #76 §76.7 caveat trigger.
 *
 * Annotates (does NOT gate / FAIL) any P(coincidence) claim where σ_regime is
 * `composition_index` or the legacy untagged default. For `llm_variance` /
 * `mixed`: caller falls through to standard §76.6 reproducibility check.
 */
export function shouldEmitSection767Caveat(regime: SigmaRegime | typeof LEGACY_UNTAGGED_REGIME): boolean {
  return regime === 'composition_index' || regime === LEGACY_UNTAGGED_REGIME;
}

/**
 * Plan50 §7 — runtime assertion at serializer boundary.
 *
 * Defense-in-depth covering dynamic-serialization edge case: a downstream
 * emitter that drops the `sigma_regime` tag before write is loud-failed at
 * boundary rather than silently emitting an untagged record.
 */
export function assertSigmaRegimePresent(obs: { sigma_regime?: SigmaRegime }, roundId: string): void {
  if (obs.sigma_regime === undefined || obs.sigma_regime === null) {
    throw new Error(`σ observation missing sigma_regime tag at round=${roundId}`);
  }
}

/**
 * Get the σ_regime tag from a possibly-legacy record (Plan50 §6.4).
 * Use this in audit_calc.py-style consumers that read pre-migration data.
 */
export function getSigmaRegimeOrLegacy(
  record: { sigma_regime?: SigmaRegime },
): SigmaRegime | typeof LEGACY_UNTAGGED_REGIME {
  return record.sigma_regime ?? LEGACY_UNTAGGED_REGIME;
}

/**
 * Plan50 §6 — Atomic-rename migration wrapper.
 *
 * Strong-invariant pre/post (BABBAGE R2 OQ-7 + MRB-§2-01 RESOLVED):
 *   pre:           ∀ r: r.sigma_regime = undefined
 *   post-success:  ∀ r: r.sigma_regime = "composition_index" ∧ r.sigma == pre.r.sigma
 *   post-rollback: ∀ r: r.sigma_regime = undefined ∧ r.sigma == pre.r.sigma
 *
 * Either ALL records tagged (success) or NONE (rollback). The σ values are
 * never modified — only the `sigma_regime` field is added.
 *
 * Caller injects `commit` (atomic-rename in production; no-op in tests).
 */
export interface MigrationResult {
  readonly migrated: number;
  readonly skipped: number;
  readonly migration_complete: true;
}

export function migrateLegacySigmaRecords(
  records: ReadonlyArray<SigmaObservation | (Omit<SigmaObservation, 'sigma_regime'> & { sigma_regime?: SigmaRegime })>,
  commit: (tagged: readonly SigmaObservation[]) => void,
): MigrationResult {
  const staging: SigmaObservation[] = [];
  let migrated = 0;
  let skipped = 0;
  for (const r of records) {
    if (r.sigma_regime !== undefined) {
      staging.push(r as SigmaObservation);
      skipped++;
      continue;
    }
    staging.push({
      round_id: r.round_id,
      sigma: r.sigma,
      ucl: r.ucl,
      lcl: r.lcl,
      N_events: r.N_events,
      mean: r.mean,
      pooled_mode: r.pooled_mode,
      westgard_state: r.westgard_state,
      sigma_regime: 'composition_index',
    });
    migrated++;
  }
  // Integrity check: every staging record has a tag (no partial state).
  for (const s of staging) assertSigmaRegimePresent(s, s.round_id);
  // Atomic commit — caller swaps staging → canonical in one shot.
  commit(staging);
  return { migrated, skipped, migration_complete: true };
}
