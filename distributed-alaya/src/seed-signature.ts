/**
 * SeedSignatureService — HMAC-SHA256 seed integrity implementation.
 *
 * Signs seeds at plant() time using a cluster-shared secret (HMAC Option A, Plan40).
 * Verifies signatures at receipt time (fail-closed: invalid sig → false).
 *
 * Security properties (Plan39 W1 + Plan40 W3-C):
 * - Key is sourced via ISeedKeyProvider (swappable abstraction, C5)
 * - In production: Daemon-distributed cluster-wide key (DaemonKeyProvider)
 * - In standalone/test: random per-instance key (RandomKeyProvider, pre-Plan40 behavior)
 * - With shared key, cross-agent verification is genuine, not tautological
 * - Signatures are authentication tokens, not encryption
 * - Missing or invalid signature returns false (fail-closed)
 */

import { createHmac, randomBytes } from "node:crypto";
import type { ISeed, ISeedSignatureService } from "@openstarry/sdk";

/**
 * ISeedKeyProvider — swappable HMAC key injection abstraction.
 *
 * Separates key sourcing from key usage. Enables future migration
 * from Daemon-distributed shared key (Option A, Plan40) to
 * per-pair keys or PKI (Plan41+) without modifying SeedSignatureServiceImpl.
 *
 * Constraint: C5 (D5-Q1)
 */
export interface ISeedKeyProvider {
  /**
   * Returns the HMAC key to be used by SeedSignatureServiceImpl.
   * Called once at construction time. Must return a Buffer of at least 32 bytes.
   * Implementations MUST NOT log the returned key.
   */
  getKey(): Buffer;
}

/**
 * DaemonKeyProvider — production implementation of ISeedKeyProvider.
 * Wraps the cluster-wide HMAC key distributed by the Daemon at spawn time.
 *
 * The key arrives as a hex string in the spawn payload and is decoded here.
 * This is the only production implementation shipped in Plan40.
 */
export class DaemonKeyProvider implements ISeedKeyProvider {
  private keyHex: string; // no longer readonly (SEC-002)

  constructor(keyHex: string) {
    this.keyHex = keyHex;
  }

  getKey(): Buffer {
    return Buffer.from(this.keyHex, 'hex');
  }

  /** Zero out the stored key hex string (SEC-002). */
  clear(): void {
    this.keyHex = '0'.repeat(this.keyHex.length);
  }
}

/**
 * RandomKeyProvider — fallback implementation for standalone/test usage.
 * Generates a fresh random key when no Daemon-distributed key is available.
 * Preserves pre-Plan40 behavior for single-agent scenarios.
 */
export class RandomKeyProvider implements ISeedKeyProvider {
  private readonly key: Buffer = randomBytes(32);

  getKey(): Buffer {
    return this.key;
  }
}

function seedCanonical(seed: ISeed): string {
  // Deterministic serialization: exclude signature field, sort all keys recursively
  const { signature: _sig, ...rest } = seed;
  return JSON.stringify(sortedKeys(rest));
}

function sortedKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    sorted[key] = sortedKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

export class SeedSignatureServiceImpl implements ISeedSignatureService {
  private readonly secret: Buffer;
  /**
   * SEC-001 (Plan46 W0): monotonic nonce counter per agent for replay protection.
   * Keyed by agentId; value is last-seen nonce. Enforcement is opt-in via
   * verifyNonce() — existing verify(seed) callers remain unaffected (backward
   * compat preserved; ISeedSignatureService SDK interface unchanged and FROZEN).
   */
  private readonly lastNonce = new Map<string, number>();

  /**
   * @deprecated Use ISeedKeyProvider abstraction instead (Plan40 W3-C).
   * Raw Buffer constructor bypasses ISeedKeyProvider — retained only for
   * backward compatibility with existing tests. New code should use
   * `new SeedSignatureServiceImpl(keyProvider.getKey())`.
   */
  constructor(secret?: Buffer) {
    this.secret = secret ?? randomBytes(32);
  }

  async sign(seed: ISeed): Promise<string> {
    const canonical = seedCanonical(seed);
    return createHmac("sha256", this.secret).update(canonical).digest("hex");
  }

  async verify(seed: ISeed): Promise<boolean> {
    if (!seed.signature) return false;
    const expected = await this.sign(seed);
    // Constant-time comparison to prevent timing attacks
    if (expected.length !== seed.signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) {
      diff |= expected.charCodeAt(i) ^ seed.signature.charCodeAt(i);
    }
    return diff === 0;
  }

  /**
   * SEC-001 (Plan46 W0): verify nonce is strictly greater than the last seen
   * value for a given agentId, providing replay protection.
   *
   * Returns true (and advances the counter) if nonce > lastSeen for this agent.
   * Returns false if nonce <= lastSeen (replay / reorder rejected).
   *
   * Callers opt into replay protection by invoking this method alongside
   * verify(). Agents that never send nonces remain on the pre-Plan46 path.
   */
  verifyNonce(agentId: string, nonce: number): boolean {
    if (!Number.isFinite(nonce)) return false;
    const last = this.lastNonce.get(agentId);
    if (last !== undefined && nonce <= last) return false;
    this.lastNonce.set(agentId, nonce);
    return true;
  }

  /**
   * Returns the last-seen nonce for an agent, or undefined if none recorded.
   * Exposed for test/diagnostic use only (SEC-001).
   */
  getLastNonce(agentId: string): number | undefined {
    return this.lastNonce.get(agentId);
  }

  /** Zero out the HMAC secret buffer (SEC-002) and reset nonce counters (SEC-001). */
  clear(): void {
    this.secret.fill(0);
    this.lastNonce.clear();
  }
}

/**
 * @deprecated Use ISeedKeyProvider + SeedSignatureServiceImpl constructor instead.
 * This factory bypasses the ISeedKeyProvider abstraction introduced in Plan40.
 */
export function createSeedSignatureService(secret?: Buffer): ISeedSignatureService {
  if (secret) {
    console.warn('[DEPRECATED] createSeedSignatureService(Buffer): use ISeedKeyProvider abstraction instead (Plan40 W3-C).');
  }
  return new SeedSignatureServiceImpl(secret);
}
