/**
 * vasana-engine plugin — Plan57 D-30-5 (cycle 03-19 v0.54.0-alpha) refactored
 * to plugin form per cycle 03-21 amendment (v0.55.0-alpha).
 *
 * Phase 6 第四棒 — Track 1 deposit-only passive-observer log; Track 2 read-API
 * DEFERRED to Plan60 Blackboard-Alaya. Plan52/Plan54/Plan56 isomorph.
 *
 * **Phase 7 elevation 先驅範例**: first concrete refactor from runner-level
 * to plugin layer per R/S/C/G template (cycle 03-21 R3 D-§0-B AMEND-6).
 *
 * @see openstarry_doc/Technical_Specifications/Plan57_D30_5_VasanaEngine_Binding.md
 * @see openstarry_doc/Technical_Specifications/Plan57_D30_5_VasanaEngine_Binding_amendment_cycle03-21.md
 */

export {
  computeEntryHash,
  computeHmacSignature,
  verifyChain,
} from './hash-chain.js';

export {
  createVasanaEngine,
  type VasanaEngine,
  type VasanaEngineConfig,
} from './engine.js';

export {
  createVasanaEnginePlugin,
  type VasanaEnginePluginConfig,
} from './plugin.js';

export { default } from './plugin.js';
