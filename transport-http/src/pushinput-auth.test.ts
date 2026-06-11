/**
 * Plan52 Phase B + integration audits — pushinput-auth tests.
 * Covers I-1 (transport-http) + A-1..A-4 reflexive + NEG-1..NEG-7 adversarial.
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildCanonicalInput,
  computeCapabilityHash,
  type KeyResolver,
} from '@openstarry/sdk';
import { PushInputAuthenticator } from './pushinput-auth.js';

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf-8').digest('hex');
const KEY = Buffer.alloc(32, 0xab);
const ALT_KEY = Buffer.alloc(32, 0xcd);
const CAPS = ['read', 'write'] as const;

const resolver: KeyResolver = {
  resolve(kid: string) {
    if (kid === 'k-2026-04') return { kid, key: KEY, algorithm: 'hmac-sha256' as const };
    if (kid === 'k-rotated') return { kid, key: ALT_KEY, algorithm: 'hmac-sha256' as const };
    if (kid === 'k-ed25519') return { kid, key: KEY, algorithm: 'ed25519' as const };
    return null;
  },
};

const buildHmacHeaders = (args: {
  ts?: number;
  nonce?: string;
  kid?: string;
  key?: Buffer;
  caps?: readonly string[];
  algorithm?: 'hmac-sha256' | 'ed25519';
  capOverride?: string;
}) => {
  const ts = args.ts ?? Date.now();
  const nonce = args.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`;
  const kid = args.kid ?? 'k-2026-04';
  const key = args.key ?? KEY;
  const caps = args.caps ?? CAPS;
  const capabilityHash = computeCapabilityHash(caps, sha256Hex);
  const canonical = buildCanonicalInput({ sourceId: 'transport-http', ts, nonce, capabilityHash });
  const algorithm = args.algorithm ?? 'hmac-sha256';
  const sig = createHmac('sha256', key).update(canonical, 'utf-8').digest('hex');
  return {
    authorization: `${algorithm}:${sig}`,
    'x-os-nonce': nonce,
    'x-os-ts': String(ts),
    'x-os-kid': kid,
  };
};

describe('Plan52 Phase B — PushInputAuthenticator (transport-http)', () => {
  describe('Legacy passthrough (auth disabled)', () => {
    it('returns frozen-empty sourceContext when enabled=false', async () => {
      const auth = new PushInputAuthenticator({ enabled: false });
      const result = await auth.verify({}, 'trace-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Object.keys(result.sourceContext)).toHaveLength(0);
        expect(Object.isFrozen(result.sourceContext)).toBe(true);
      }
    });
  });

  describe('Happy path (HMAC-SHA256 verify success)', () => {
    let auth: PushInputAuthenticator;
    beforeEach(() => {
      auth = new PushInputAuthenticator({
        enabled: true,
        keyResolver: resolver,
        capabilitySet: CAPS,
      });
    });

    it('verifies a fresh HMAC tokenSig + builds frozen sourceContext', async () => {
      const headers = buildHmacHeaders({});
      const result = await auth.verify(headers, 'trace-ok');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sourceContext.tokenSig).toBe(headers.authorization);
        expect(result.sourceContext.nonce).toBe(headers['x-os-nonce']);
        expect(result.sourceContext.kid).toBe('k-2026-04');
        expect(result.sourceContext.algorithm).toBe('hmac-sha256');
        expect(Object.isFrozen(result.sourceContext)).toBe(true);
      }
    });

    it('A-3: deepFreeze blocks downstream mutation (CP-4 invariant)', async () => {
      const headers = buildHmacHeaders({});
      const result = await auth.verify(headers, 'trace-cp4');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (result.sourceContext as any).tokenSig = 'tampered';
        }).toThrow();
      }
    });
  });

  describe('Adversarial NEG-1..NEG-7', () => {
    let auth: PushInputAuthenticator;
    beforeEach(() => {
      auth = new PushInputAuthenticator({
        enabled: true,
        keyResolver: resolver,
        capabilitySet: CAPS,
      });
    });

    it('NEG-1: rejects forged signature (tampered hex)', async () => {
      const h = buildHmacHeaders({});
      const result = await auth.verify({ ...h, authorization: 'hmac-sha256:00'.padEnd(64, '0') }, 'trace-neg1');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.httpStatus).toBe(401);
    });

    it('NEG-1: rejects malformed-hex signature', async () => {
      const result = await auth.verify({
        ...buildHmacHeaders({}),
        authorization: 'hmac-sha256:not-hex-at-all',
      }, 'trace-neg1b');
      expect(result.ok).toBe(false);
      if (!result.ok) expect([400, 401]).toContain(result.httpStatus);
    });

    it('NEG-2: rejects nonce replay within TTL window', async () => {
      const headers = buildHmacHeaders({ nonce: 'fixed-nonce-value' });
      const first = await auth.verify(headers, 'trace-neg2-first');
      expect(first.ok).toBe(true);
      const replay = await auth.verify(headers, 'trace-neg2-replay');
      expect(replay.ok).toBe(false);
      if (!replay.ok) {
        expect(replay.httpStatus).toBe(401);
        expect(replay.error.message).toMatch(/already used|replay/i);
      }
    });

    it('NEG-3: rejects algorithm-downgrade (verifier=hmac, request=ed25519 prefix)', async () => {
      // Build a body that says ed25519 but use a kid that resolves to hmac-sha256.
      const headers = buildHmacHeaders({});
      const downgrade = headers.authorization.replace('hmac-sha256:', 'ed25519:');
      const result = await auth.verify({ ...headers, authorization: downgrade }, 'trace-neg3');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.httpStatus).toBe(401);
    });

    it('NEG-3: rejects unknown algorithm prefix', async () => {
      const result = await auth.verify({
        ...buildHmacHeaders({}),
        authorization: 'rsa:abcdef',
      }, 'trace-neg3b');
      expect(result.ok).toBe(false);
    });

    it('NEG-4: rejects time-travel (clock skew beyond budget)', async () => {
      const future = Date.now() + 10 * 60_000; // 10 minutes ahead, beyond default 60s
      const headers = buildHmacHeaders({ ts: future });
      const result = await auth.verify(headers, 'trace-neg4');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.httpStatus).toBe(401);
        expect(result.error.message).toMatch(/skew/i);
      }
    });

    it('NEG-5: rejects malformed schema (missing required headers)', async () => {
      const result = await auth.verify({}, 'trace-neg5');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.httpStatus).toBe(401);
    });

    it('NEG-6: rejects HMAC verified with wrong key (algorithm preserved)', async () => {
      const headers = buildHmacHeaders({ key: ALT_KEY }); // signed with ALT, kid points to KEY
      const result = await auth.verify(headers, 'trace-neg6');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.httpStatus).toBe(401);
    });

    it('NEG-7: rejects unknown kid (no resolver match)', async () => {
      const headers = buildHmacHeaders({ kid: 'nonexistent-kid' });
      const result = await auth.verify(headers, 'trace-neg7');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.httpStatus).toBe(401);
    });
  });

  describe('Key rotation (D-§1-06: nonce TTL ≥ rotation overlap)', () => {
    it('accepts in-flight signatures from old key during rotation overlap', async () => {
      // Two resolvers active "simultaneously" — simulate by passing different kid.
      const auth = new PushInputAuthenticator({
        enabled: true,
        keyResolver: resolver,
        capabilitySet: CAPS,
      });
      // Old key sig
      const oldHeaders = buildHmacHeaders({ kid: 'k-2026-04', key: KEY });
      const oldResult = await auth.verify(oldHeaders, 'trace-rot-old');
      expect(oldResult.ok).toBe(true);
      // Newly rotated key sig (different nonce so no replay collision)
      const newHeaders = buildHmacHeaders({ kid: 'k-rotated', key: ALT_KEY });
      const newResult = await auth.verify(newHeaders, 'trace-rot-new');
      expect(newResult.ok).toBe(true);
    });
  });

  describe('Error emission via F-16 StructuredError schema', () => {
    it('F-16 conforming: failed verification produces a valid StructuredError record', async () => {
      const auth = new PushInputAuthenticator({
        enabled: true,
        keyResolver: resolver,
        capabilitySet: CAPS,
      });
      const result = await auth.verify({}, 'trace-f16');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error).toBeDefined();
        expect(result.error.message.length).toBeGreaterThan(0);
        expect(result.error.likely_cause).toMatch(/^(verified|inferred|speculation):/);
        expect(result.error.trace_id).toBe('trace-f16');
        expect(result.error.context).toMatchObject({ plugin: 'transport-http', auth_layer: 'plan52' });
      }
    });
  });
});
