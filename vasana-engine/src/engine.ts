/**
 * vasana-engine / engine — Plan57 D-30-5 main entry.
 *
 * Track 1 deposit-only API (Track 2 read-API DEFERRED to Plan60). Implements
 * Plan57 §2.3 SICP-canonical 4-method public surface:
 *
 *   - `deposit(req, secretKey)` — append entry; return entry_hash
 *   - `verify_chain(startIdx?, endIdx?)` — runtime integrity check
 *   - `count()` — entry count (no content access)
 *   - `latest_hash()` — for external attestation
 *
 * **Boot-time refuse-to-start** (Plan57 §9): chain integrity verified at
 * construction; throws on violation. Runtime re-verification on every deposit.
 *
 * **Replay cache 4-contributor** (Plan57 §5): when `sharedNonceCache` is
 * supplied, Plan57 contributes via `vsn:` prefix.
 *
 * @see openstarry_doc/Technical_Specifications/Plan57_D30_5_VasanaEngine_Binding.md
 */

import { randomBytes } from 'node:crypto';
import {
  NonceCache,
  redactPayload,
  VasanaDepositRequestSchema,
  VasanaDepositResultSchema,
  VASANA_GENESIS_PREV_HASH,
  VASANA_REPLAY_CACHE_PREFIX,
  type VasanaDepositEntry,
  type VasanaDepositRequest,
  type VasanaDepositResult,
} from '@openstarry/sdk';
import {
  computeEntryHash,
  computeHmacSignature,
  verifyChain,
} from './hash-chain.js';

/** Configuration for the VasanaEngine. */
export interface VasanaEngineConfig {
  /** Hex-encoded HMAC key (≥ 32 bytes). MUST come from CSPRNG. */
  readonly hmacKeyHex?: string;
  /** Pre-existing log entries (loaded at boot; integrity verified). */
  readonly initialEntries?: readonly VasanaDepositEntry[];
  /** Plan57 §5 replay cache (4-contributor mode shares this). */
  readonly sharedNonceCache?: NonceCache;
  readonly nonceTtlMs?: number;
  readonly rotationOverlapMs?: number;
}

/** Public surface — Plan57 §2.3 4-method SICP-canonical API. */
export interface VasanaEngine {
  deposit(req: VasanaDepositRequest): VasanaDepositResult;
  verify_chain(startIdx?: number, endIdx?: number): { ok: true } | { ok: false; violation_index: number; reason: string };
  count(): number;
  latest_hash(): string;
}

function loadHmacKey(provided?: string): Buffer {
  if (provided !== undefined) {
    if (!/^[A-Fa-f0-9]+$/.test(provided)) {
      throw new Error('vasana-engine.boot: hmacKey must be hex-encoded (CSPRNG provenance)');
    }
    if (provided.length < 64) {
      throw new Error(`vasana-engine.boot: hmacKey must be ≥ 32 bytes / 64 hex chars (got ${provided.length / 2})`);
    }
    return Buffer.from(provided, 'hex');
  }
  return randomBytes(32);
}

export function createVasanaEngine(cfg: VasanaEngineConfig = {}): VasanaEngine {
  const hmacKey = loadHmacKey(cfg.hmacKeyHex);
  const nonceTtl = cfg.nonceTtlMs ?? 24 * 60 * 60 * 1000;
  const rotation = cfg.rotationOverlapMs ?? 24 * 60 * 60 * 1000;
  const nonceCache = cfg.sharedNonceCache ?? new NonceCache(nonceTtl, rotation);
  // Defensive copy: caller mutation of initialEntries must not affect engine state.
  const entries: VasanaDepositEntry[] = cfg.initialEntries ? [...cfg.initialEntries] : [];

  // Boot-time integrity verification per §9.
  if (entries.length > 0) {
    const result = verifyChain(entries, 0, entries.length, hmacKey);
    if (!result.ok) {
      throw new Error(
        `vasana-engine.boot: refuse-to-start — chain integrity violation at entry ${result.violation_index}: ${result.reason}`,
      );
    }
  }

  function deposit(rawReq: VasanaDepositRequest): VasanaDepositResult {
    const parsed = VasanaDepositRequestSchema.safeParse(rawReq);
    if (!parsed.success) {
      return VasanaDepositResultSchema.parse({ success: false, reason: 'invalid_request_schema' });
    }
    const req = parsed.data;

    // §5 replay defense (4-contributor prefix).
    const cacheKey = `${VASANA_REPLAY_CACHE_PREFIX}${req.nonce}`;
    if (!nonceCache.register(cacheKey)) {
      return VasanaDepositResultSchema.parse({ success: false, reason: 'nonce_replay' });
    }

    // §9 runtime re-verification before append.
    if (entries.length > 0) {
      const tail = verifyChain(entries, entries.length - 1, entries.length, hmacKey);
      if (!tail.ok) {
        return VasanaDepositResultSchema.parse({
          success: false,
          reason: 'chain_corruption_detected',
        });
      }
    }

    const prev_hash = entries.length === 0 ? VASANA_GENESIS_PREV_HASH : entries[entries.length - 1]!.entry_hash;
    const deposit_time_utc = new Date().toISOString();
    const content_redacted = redactPayload(req.content, 'vasana-deposit');
    const hmac_signature = computeHmacSignature({
      volition_id: req.volition_id,
      category: req.category,
      deposit_time_utc,
      content_redacted,
      nonce: req.nonce,
      prev_hash,
      hmacKey,
    });
    const baseEntry: Omit<VasanaDepositEntry, 'entry_hash'> = {
      volition_id: req.volition_id,
      category: req.category,
      deposit_time_utc,
      content_redacted,
      hmac_signature,
      nonce: req.nonce,
      prev_hash,
    };
    const entry_hash = computeEntryHash(baseEntry);
    const entry: VasanaDepositEntry = { ...baseEntry, entry_hash };
    entries.push(entry);

    return VasanaDepositResultSchema.parse({
      success: true,
      entry_hash,
      entry_index: entries.length - 1,
    });
  }

  return {
    deposit,
    verify_chain: (start = 0, end?: number) => verifyChain(entries, start, end, hmacKey),
    count: () => entries.length,
    latest_hash: () => (entries.length === 0 ? VASANA_GENESIS_PREV_HASH : entries[entries.length - 1]!.entry_hash),
  };
}
