/**
 * distributed-alaya / plan60-addendum — Plan60 Blackboard-Alaya forward addendum.
 *
 * **Plan60 §2 Option A reuse**: existing `BijaStore` + `seed-signature` +
 * vector-clock + SEC-002 + late-joiner-snapshot remain UNCHANGED (MR-12
 * 既有不破壞). This module is a forward-only addendum providing:
 *   - HMAC-SHA256 attestation on seed deposit requests
 *   - 7th-contributor `aly:` replay-cache prefix (Phase 6 完工 final N=7)
 *   - 5-vector defence-in-depth threat-model surface (Plan60 §6)
 *
 * **Plan52~Plan60 isomorph (Plan60 §3 11-dimension)**: ε-surface delta vs
 * Plan52 baseline = 0 fields, 0 const. Canonical signing input is
 * `seed_id|payload_hash|nonce|ts_utc` — strict 4-field tuple, NO pushInput
 * envelope agent-identity / capability-set fields.
 *
 * **Boundary invariant per Plan60 §5**: signatures of `AlayaSeedAttestor`
 * and helpers stay strictly inside the canonical tuple. Static-analysis
 * grep over this file confirms the pushInput envelope's agent-identity and
 * capability-set tokens are absent (KERNEL R2 sub-check #7 set-disjointness
 * PASS).
 *
 * @see openstarry_doc/Technical_Specifications/Plan60_Blackboard_Alaya_Binding.md
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  ALAYA_REPLAY_CACHE_PREFIX,
  AlayaSeedDepositRequestSchema,
  AlayaSeedDepositResultSchema,
  NonceCache,
  parseTokenSig,
  type AlayaSeedDepositRequest,
  type AlayaSeedDepositResult,
} from '@openstarry/sdk';

/**
 * Default upper bound on `payload_hash` length validated by Zod (64 hex
 * chars = SHA-256). Plan60 §6 vector-1 size-limit is the schema regex.
 */

/** Canonical signing input — `seed_id|payload_hash|nonce|ts_utc`. */
export function buildAlayaCanonical(
  req: Pick<AlayaSeedDepositRequest, 'seed_id' | 'payload_hash' | 'nonce' | 'ts_utc'>,
): string {
  return `${req.seed_id}|${req.payload_hash}|${req.nonce}|${req.ts_utc}`;
}

function verifyAlayaHmac(req: AlayaSeedDepositRequest, key: Buffer): boolean {
  const canonical = buildAlayaCanonical(req);
  const expected = createHmac('sha256', key).update(canonical, 'utf-8').digest();
  let received: Buffer;
  try {
    received = Buffer.from(req.hmac_signature, 'hex');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/**
 * Boot-time HMAC key loader — refuse-to-start on key < 32 bytes / non-hex.
 * Inherits Plan54 / Plan58 / Plan59 `loadHmacKey` discipline verbatim.
 */
export function loadAlayaHmacKey(provided?: string): Buffer {
  if (provided !== undefined) {
    if (!/^[A-Fa-f0-9]+$/.test(provided)) {
      throw new Error('plan60-addendum.boot: hmacKey must be hex-encoded (CSPRNG provenance)');
    }
    if (provided.length < 64) {
      throw new Error(
        `plan60-addendum.boot: hmacKey must be ≥ 32 bytes / 64 hex chars (got ${provided.length / 2})`,
      );
    }
    return Buffer.from(provided, 'hex');
  }
  return randomBytes(32);
}

/** Function shape returned to plugin consumers. */
export type AlayaSeedAttestor = (raw: unknown) => AlayaSeedDepositResult;

export interface AlayaSeedAttestorConfig {
  /** Hex-encoded HMAC key (≥ 32 bytes). MUST come from CSPRNG. */
  readonly hmacKeyHex?: string;
  /** Optional shared nonce cache (7-contributor opt-in). */
  readonly sharedNonceCache?: NonceCache;
  /** Replay cache TTL (default 24h). */
  readonly nonceTtlMs?: number;
  /** Key-rotation overlap window (default 24h). */
  readonly rotationOverlapMs?: number;
}

/**
 * Build a seed-deposit attestor — attests an incoming seed deposit
 * request against:
 *   1. schema (rejects malformed / under-length nonce / bad hmac hex)
 *   2. HMAC-SHA256 over canonical input
 *   3. `aly:` 7th-contributor replay-cache (NonceCache)
 *
 * On success, the caller (existing distributed-alaya plugin) proceeds to
 * append the seed via the unchanged BijaStore path.
 */
export function createAlayaSeedAttestor(cfg: AlayaSeedAttestorConfig = {}): AlayaSeedAttestor {
  const hmacKey = loadAlayaHmacKey(cfg.hmacKeyHex);
  const ttl = cfg.nonceTtlMs ?? 24 * 60 * 60 * 1000;
  const rotation = cfg.rotationOverlapMs ?? 24 * 60 * 60 * 1000;
  const nonceCache = cfg.sharedNonceCache ?? new NonceCache(ttl, rotation);

  return function attest(raw: unknown): AlayaSeedDepositResult {
    const parsed = AlayaSeedDepositRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return AlayaSeedDepositResultSchema.parse({ success: false, reason: 'invalid_request_schema' });
    }
    const req = parsed.data;

    // Algo-prefix discipline (Plan52 CV-04 inheritance).
    if (parseTokenSig(`hmac-sha256:${req.hmac_signature}`) === null) {
      return AlayaSeedDepositResultSchema.parse({ success: false, reason: 'invalid_request_schema' });
    }

    if (!verifyAlayaHmac(req, hmacKey)) {
      return AlayaSeedDepositResultSchema.parse({ success: false, reason: 'tokenSig_verification_failed' });
    }

    // Replay defense — 7th contributor `aly:` prefix; Phase 6 完工 final N=7.
    const cacheKey = `${ALAYA_REPLAY_CACHE_PREFIX}${req.nonce}`;
    if (!nonceCache.register(cacheKey)) {
      return AlayaSeedDepositResultSchema.parse({ success: false, reason: 'nonce_replay' });
    }

    return AlayaSeedDepositResultSchema.parse({ success: true });
  };
}

/**
 * Plan60 §4 R2-C item #4 — 7-contributor topology audit.
 * Returned as a frozen list so production code may reference it for prefix-
 * collision audit (cross-prefix Hamming distance ≥ 2 verification at boot).
 */
export const REPLAY_CACHE_TOPOLOGY_N7 = Object.freeze([
  'psh:', // Plan52 pushInput
  'ac9:', // Plan54 AC-9
  'mvq:', // Plan56 D-30-4
  'vsn:', // Plan57 D-30-5 plugin form
  'msh:', // Plan58 Mesh
  'apr:', // Plan59 API Runtime
  'aly:', // Plan60 Blackboard-Alaya — Phase 6 完工 final
]) as readonly string[];
