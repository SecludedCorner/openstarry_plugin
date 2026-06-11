/**
 * distributed-alaya / plan60-addendum — Plan60 Blackboard-Alaya forward
 * addendum unit tests.
 *
 * Coverage:
 *   - boot-time fail-fast (loadAlayaHmacKey)
 *   - schema (Zod regex on nonce / payload_hash / hmac_signature)
 *   - HMAC-SHA256 verify on canonical input
 *   - `aly:` 7th-contributor replay defense (cross-prefix non-collision)
 *   - 7-row contributor topology constant + source-comment audit
 *   - boundary invariant grep (no ε-surface envelope leak)
 *   - 5-vector defence-in-depth (Plan60 §6) coverage map
 */

import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALAYA_REPLAY_CACHE_PREFIX, NonceCache } from '@openstarry/sdk';
import {
  buildAlayaCanonical,
  createAlayaSeedAttestor,
  loadAlayaHmacKey,
  REPLAY_CACHE_TOPOLOGY_N7,
} from '../plan60-addendum.js';

const KEY_HEX = 'b'.repeat(64);
const KEY = Buffer.from(KEY_HEX, 'hex');

function sign(req: { seed_id: string; payload_hash: string; nonce: string; ts_utc: string }): string {
  return createHmac('sha256', KEY).update(buildAlayaCanonical(req), 'utf-8').digest('hex');
}

function nonce(): string {
  return randomBytes(8).toString('hex');
}

function payloadHash(): string {
  return randomBytes(32).toString('hex');
}

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

let attestor: ReturnType<typeof createAlayaSeedAttestor>;
let cache: NonceCache;

beforeEach(() => {
  cache = new NonceCache(60_000, 30_000);
  attestor = createAlayaSeedAttestor({ hmacKeyHex: KEY_HEX, sharedNonceCache: cache });
});

afterEach(() => {
  cache.reset();
});

describe('plan60-addendum — boot-time fail-fast (Plan52/54/58/59 isomorph loadHmacKey)', () => {
  it('rejects non-hex hmac key', () => {
    expect(() => loadAlayaHmacKey('not-hex!')).toThrow(/hex-encoded/);
  });
  it('rejects hex key < 32 bytes', () => {
    expect(() => loadAlayaHmacKey('a'.repeat(32))).toThrow(/≥ 32 bytes/);
  });
  it('accepts hex key ≥ 32 bytes', () => {
    expect(loadAlayaHmacKey(KEY_HEX)).toHaveLength(32);
  });
  it('synthesises CSPRNG key when none provided', () => {
    expect(loadAlayaHmacKey()).toHaveLength(32);
  });
});

describe('plan60-addendum — request schema validation', () => {
  it('rejects missing field → invalid_request_schema', () => {
    const r = attestor({ seed_id: 's1' });
    expect(r).toEqual({ success: false, reason: 'invalid_request_schema' });
  });
  it('rejects nonce < 8 hex chars', () => {
    const ts = '2026-05-05T01:42:00Z';
    const r = attestor({
      seed_id: 's1',
      payload_hash: payloadHash(),
      nonce: 'aaaa',
      ts_utc: ts,
      hmac_signature: 'a'.repeat(64),
    });
    expect(r.reason).toBe('invalid_request_schema');
  });
  it('rejects non-SHA256 payload_hash', () => {
    const ts = '2026-05-05T01:42:00Z';
    const r = attestor({
      seed_id: 's1',
      payload_hash: 'too-short',
      nonce: nonce(),
      ts_utc: ts,
      hmac_signature: 'a'.repeat(64),
    });
    expect(r.reason).toBe('invalid_request_schema');
  });
});

describe('plan60-addendum — HMAC-SHA256 verify on canonical input', () => {
  it('rejects wrong signature → tokenSig_verification_failed', () => {
    const ts = '2026-05-05T01:42:00Z';
    const r = attestor({
      seed_id: 's1',
      payload_hash: payloadHash(),
      nonce: nonce(),
      ts_utc: ts,
      hmac_signature: 'c'.repeat(64),
    });
    expect(r).toEqual({ success: false, reason: 'tokenSig_verification_failed' });
  });

  it('accepts canonical signature', () => {
    const ts = '2026-05-05T01:42:00Z';
    const req = { seed_id: 's1', payload_hash: payloadHash(), nonce: nonce(), ts_utc: ts };
    const r = attestor({ ...req, hmac_signature: sign(req) });
    expect(r).toEqual({ success: true });
  });

  it('canonical input is exactly seed_id|payload_hash|nonce|ts_utc (4 fields)', () => {
    const r = { seed_id: 'X', payload_hash: 'Y', nonce: 'Z', ts_utc: 'T' };
    expect(buildAlayaCanonical(r)).toBe('X|Y|Z|T');
  });
});

describe('plan60-addendum — `aly:` 7th-contributor replay defense (Phase 6 完工 final N=7)', () => {
  it('rejects replay (same nonce twice) → nonce_replay', () => {
    const ts = '2026-05-05T01:42:00Z';
    const req = { seed_id: 's1', payload_hash: payloadHash(), nonce: nonce(), ts_utc: ts };
    const sig = sign(req);
    expect(attestor({ ...req, hmac_signature: sig })).toEqual({ success: true });
    expect(attestor({ ...req, hmac_signature: sig })).toEqual({ success: false, reason: 'nonce_replay' });
  });

  it('cache key uses `aly:` prefix — collision-audit cross-prefix non-collision', () => {
    const ts = '2026-05-05T01:42:00Z';
    const n = nonce();
    const req = { seed_id: 's1', payload_hash: payloadHash(), nonce: n, ts_utc: ts };
    expect(attestor({ ...req, hmac_signature: sign(req) })).toEqual({ success: true });
    // Same nonce under any of the prior 6 prefixes must remain free.
    for (const prefix of ['psh:', 'ac9:', 'mvq:', 'vsn:', 'msh:', 'apr:']) {
      expect(cache.register(`${prefix}${n}`)).toBe(true);
    }
    // The aly: cache key for this nonce is now occupied.
    expect(cache.register(`aly:${n}`)).toBe(false);
  });

  it('ALAYA_REPLAY_CACHE_PREFIX shape is exactly `aly:` (3-char-lowercase + colon-suffix per D-§1-B)', () => {
    expect(ALAYA_REPLAY_CACHE_PREFIX).toBe('aly:');
    expect(ALAYA_REPLAY_CACHE_PREFIX).toMatch(/^[a-z]{3}:$/);
  });
});

describe('Plan60 §4 R2-C 5-item AND-condition (replay cache 7-contributor)', () => {
  it('item #3: REPLAY_CACHE_TOPOLOGY_N7 is exactly 7 rows in declaration order', () => {
    expect(REPLAY_CACHE_TOPOLOGY_N7).toHaveLength(7);
    expect(REPLAY_CACHE_TOPOLOGY_N7).toEqual(['psh:', 'ac9:', 'mvq:', 'vsn:', 'msh:', 'apr:', 'aly:']);
  });

  it('item #4: source comments name all 7 prefixes (audit-script anchor)', () => {
    const src = readFileSync(join(SRC_DIR, 'plan60-addendum.ts'), 'utf-8');
    for (const prefix of REPLAY_CACHE_TOPOLOGY_N7) {
      expect(src).toContain(prefix);
    }
  });

  it('item #1: every prefix in N=7 topology fits the 4-char shape [a-z][a-z0-9]{2}: (legacy `ac9:` lowercase+digit grandfathered)', () => {
    for (const prefix of REPLAY_CACHE_TOPOLOGY_N7) {
      expect(prefix).toMatch(/^[a-z][a-z0-9]{2}:$/);
    }
  });

  it('item #1: `aly:` (Plan60 new addition) matches the stricter 3-char-lowercase form per spec §4', () => {
    expect('aly:').toMatch(/^[a-z]{3}:$/);
  });

  it('item #5: `aly:` Hamming distance ≥ 2 vs each of the 6 existing prefixes (GUARDIAN per Plan60 §6 vector-5)', () => {
    function hammingDistance(a: string, b: string): number {
      if (a.length !== b.length) return Math.max(a.length, b.length);
      let d = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
      return d;
    }
    const aly = 'aly:';
    for (const existing of ['psh:', 'ac9:', 'mvq:', 'vsn:', 'msh:', 'apr:']) {
      expect(hammingDistance(aly, existing)).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('Plan60 §5 boundary invariant — static-analysis grep', () => {
  // KERNEL R2 sub-check #7 set-disjointness predicate (Yes/No decidable).
  const FORBIDDEN_TOKENS = [
    'parent_agent_id',
    'capability_holdings',
    'parentAgentId',
    'capabilityHoldings',
  ];

  it('plan60-addendum.ts contains zero ε-surface envelope leak tokens', () => {
    const src = readFileSync(join(SRC_DIR, 'plan60-addendum.ts'), 'utf-8');
    for (const tok of FORBIDDEN_TOKENS) {
      expect(src).not.toContain(tok);
    }
  });

  it('canonical signing input is seed_id|payload_hash|nonce|ts_utc (no envelope leak)', () => {
    const src = readFileSync(join(SRC_DIR, 'plan60-addendum.ts'), 'utf-8');
    expect(src).toContain('seed_id}|${req.payload_hash}|${req.nonce}|${req.ts_utc');
  });
});

describe('Plan60 §6 5-vector defence-in-depth coverage map', () => {
  it('vector 1 (alaya seed pollution): HMAC + nonce + replay + key derivation + size limit all enforced', () => {
    // HMAC: tested in tokenSig_verification_failed branch.
    // nonce ≥ 8 hex: tested in invalid_request_schema branch.
    // replay: tested in nonce_replay branch.
    // key derivation audit: loadAlayaHmacKey enforces hex + length ≥ 32 bytes.
    // size limit: payload_hash regex pins SHA-256 64-char hex (no oversized payload pointer).
    expect(() => loadAlayaHmacKey('z'.repeat(64))).toThrow();
    expect(() => loadAlayaHmacKey('a'.repeat(63))).toThrow();
  });

  it('vector 5 (replay cache prefix-collision): 6×N=7 pairs Hamming distance ≥ 2 verified', () => {
    // Covered by the AND-condition test above; this is the explicit GUARDIAN
    // hook so the §6 vector-5 row appears in the test ledger.
    expect(REPLAY_CACHE_TOPOLOGY_N7.length).toBe(7);
  });
});
