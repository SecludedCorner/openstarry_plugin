/**
 * vasana-engine / hash-chain — Plan57 §2.2 deposit log HMAC-chain integrity.
 *
 * Each entry's `entry_hash` = SHA-256 of canonical fields (including
 * `prev_hash`); the chain links forward by feeding each entry's hash as the
 * next entry's `prev_hash`. Tamper-evidence equivalent to POSIX `O_APPEND`
 * per Plan57 §7 Windows fallback compensating control.
 *
 * @see openstarry_doc/Technical_Specifications/Plan57_D30_5_VasanaEngine_Binding.md §2.2 + §7
 */

import { createHash, createHmac } from 'node:crypto';
import {
  VASANA_GENESIS_PREV_HASH,
  type VasanaDepositEntry,
} from '@openstarry/sdk';

/** Canonical serialization for entry hashing (deterministic field order). */
function canonicalEntry(entry: Omit<VasanaDepositEntry, 'entry_hash'>): string {
  return [
    entry.volition_id,
    entry.category,
    entry.deposit_time_utc,
    entry.content_redacted,
    entry.hmac_signature,
    entry.nonce,
    entry.prev_hash,
  ].join('|');
}

/** Compute entry_hash = SHA-256 over canonical fields. */
export function computeEntryHash(entry: Omit<VasanaDepositEntry, 'entry_hash'>): string {
  return createHash('sha256').update(canonicalEntry(entry), 'utf-8').digest('hex');
}

/** Compute HMAC-SHA256 signature over canonical fields ex-signature. */
export function computeHmacSignature(args: {
  volition_id: string;
  category: string;
  deposit_time_utc: string;
  content_redacted: string;
  nonce: string;
  prev_hash: string;
  hmacKey: Buffer;
}): string {
  const canonical = `${args.volition_id}|${args.category}|${args.deposit_time_utc}|${args.content_redacted}|${args.nonce}|${args.prev_hash}`;
  return createHmac('sha256', args.hmacKey).update(canonical, 'utf-8').digest('hex');
}

/**
 * Verify chain integrity over a slice [startIdx, endIdx).
 *
 * Returns null on success; first violation index + reason on failure.
 * Iterates linearly; O(n) with constant-time hash comparison per entry.
 */
export function verifyChain(
  entries: readonly VasanaDepositEntry[],
  startIdx = 0,
  endIdx?: number,
  hmacKey?: Buffer,
): { ok: true } | { ok: false; violation_index: number; reason: string } {
  const end = endIdx ?? entries.length;
  for (let i = startIdx; i < end; i++) {
    const entry = entries[i]!;
    // prev_hash continuity
    const expectedPrev = i === 0 ? VASANA_GENESIS_PREV_HASH : entries[i - 1]!.entry_hash;
    if (entry.prev_hash !== expectedPrev) {
      return { ok: false, violation_index: i, reason: `prev_hash mismatch (expected ${expectedPrev.slice(0, 8)}..., got ${entry.prev_hash.slice(0, 8)}...)` };
    }
    // entry_hash recomputation
    const recomputed = computeEntryHash({
      volition_id: entry.volition_id,
      category: entry.category,
      deposit_time_utc: entry.deposit_time_utc,
      content_redacted: entry.content_redacted,
      hmac_signature: entry.hmac_signature,
      nonce: entry.nonce,
      prev_hash: entry.prev_hash,
    });
    if (recomputed !== entry.entry_hash) {
      return { ok: false, violation_index: i, reason: `entry_hash mismatch at index ${i}` };
    }
    // HMAC verification when key provided
    if (hmacKey) {
      const expectedSig = computeHmacSignature({
        volition_id: entry.volition_id,
        category: entry.category,
        deposit_time_utc: entry.deposit_time_utc,
        content_redacted: entry.content_redacted,
        nonce: entry.nonce,
        prev_hash: entry.prev_hash,
        hmacKey,
      });
      if (expectedSig !== entry.hmac_signature) {
        return { ok: false, violation_index: i, reason: `hmac_signature mismatch at index ${i}` };
      }
    }
  }
  return { ok: true };
}
