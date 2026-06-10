/**
 * Plan57 §2.2 — hash-chain integrity tests.
 */

import { describe, expect, it } from 'vitest';
import { VASANA_GENESIS_PREV_HASH, type VasanaDepositEntry } from '@openstarry/sdk';
import {
  computeEntryHash,
  computeHmacSignature,
  verifyChain,
} from '../src/hash-chain.js';

const KEY = Buffer.alloc(32, 0xab);

function buildEntry(over: Partial<Omit<VasanaDepositEntry, 'entry_hash'>>): VasanaDepositEntry {
  const base: Omit<VasanaDepositEntry, 'entry_hash'> = {
    volition_id: over.volition_id ?? 'v1',
    category: over.category ?? 'observation',
    deposit_time_utc: over.deposit_time_utc ?? '2026-05-01T00:00:00Z',
    content_redacted: over.content_redacted ?? '<redacted-vasana-deposit len:5 first4:abcd>',
    nonce: over.nonce ?? 'a'.repeat(32),
    prev_hash: over.prev_hash ?? VASANA_GENESIS_PREV_HASH,
    hmac_signature: '',
  };
  base.hmac_signature = computeHmacSignature({ ...base, hmacKey: KEY });
  const entry_hash = computeEntryHash(base);
  return { ...base, entry_hash };
}

describe('Plan57 §2.2 — hash-chain integrity', () => {
  it('verifies a single genesis entry', () => {
    const entries = [buildEntry({})];
    const result = verifyChain(entries, 0, undefined, KEY);
    expect(result.ok).toBe(true);
  });

  it('verifies a multi-entry chain (3 entries)', () => {
    const e1 = buildEntry({});
    const e2 = buildEntry({ volition_id: 'v2', prev_hash: e1.entry_hash });
    const e3 = buildEntry({ volition_id: 'v3', prev_hash: e2.entry_hash });
    const result = verifyChain([e1, e2, e3], 0, undefined, KEY);
    expect(result.ok).toBe(true);
  });

  it('detects prev_hash mismatch (chain break)', () => {
    const e1 = buildEntry({});
    const e2 = buildEntry({ volition_id: 'v2', prev_hash: 'f'.repeat(64) });
    const result = verifyChain([e1, e2], 0, undefined, KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violation_index).toBe(1);
      expect(result.reason).toContain('prev_hash mismatch');
    }
  });

  it('detects entry_hash tampering', () => {
    const e1 = buildEntry({});
    const tampered: VasanaDepositEntry = { ...e1, entry_hash: '0'.repeat(64) };
    const result = verifyChain([tampered], 0, undefined, KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('entry_hash mismatch');
  });

  it('detects hmac_signature tampering when key provided', () => {
    const e1 = buildEntry({});
    const tampered: VasanaDepositEntry = { ...e1, hmac_signature: 'f'.repeat(64) };
    // Recompute entry_hash to bypass entry_hash check; only hmac fails.
    const recomputed = { ...tampered, entry_hash: computeEntryHash(tampered) };
    const result = verifyChain([recomputed], 0, undefined, KEY);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('hmac_signature mismatch');
  });

  it('skips hmac verification when key omitted', () => {
    const e1 = buildEntry({});
    const tampered: VasanaDepositEntry = { ...e1, hmac_signature: 'f'.repeat(64) };
    const recomputed = { ...tampered, entry_hash: computeEntryHash(tampered) };
    const result = verifyChain([recomputed], 0); // no key
    expect(result.ok).toBe(true);
  });

  it('genesis entry has prev_hash = 64-zero sentinel', () => {
    expect(VASANA_GENESIS_PREV_HASH).toBe('0'.repeat(64));
    const e1 = buildEntry({});
    expect(e1.prev_hash).toBe(VASANA_GENESIS_PREV_HASH);
  });

  it('verifies a slice [startIdx, endIdx)', () => {
    const e1 = buildEntry({});
    const e2 = buildEntry({ volition_id: 'v2', prev_hash: e1.entry_hash });
    const e3 = buildEntry({ volition_id: 'v3', prev_hash: e2.entry_hash });
    // Verify only the last entry slice
    const result = verifyChain([e1, e2, e3], 2, 3, KEY);
    expect(result.ok).toBe(true);
  });
});
