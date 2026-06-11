/**
 * Plan52 Phase C — WS pushinput-auth tests.
 * Covers I-2 (transport-websocket) per-message auth + NEG-1..NEG-4 + NEG-7.
 */

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  buildCanonicalInput,
  computeCapabilityHash,
  type KeyResolver,
} from '@openstarry/sdk';
import { WsPushInputAuthenticator } from './pushinput-auth.js';

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf-8').digest('hex');
const KEY = Buffer.alloc(32, 0x33);
const CAPS = ['stream', 'control'] as const;

const resolver: KeyResolver = {
  resolve(kid: string) {
    if (kid === 'ws-2026-04') return { kid, key: KEY, algorithm: 'hmac-sha256' as const };
    return null;
  },
};

const buildEnvelope = (over?: { ts?: number; nonce?: string; kid?: string; key?: Buffer; mangle?: boolean }) => {
  const ts = over?.ts ?? Date.now();
  const nonce = over?.nonce ?? `ws-nonce-${Math.random().toString(36).slice(2)}`;
  const kid = over?.kid ?? 'ws-2026-04';
  const key = over?.key ?? KEY;
  const capabilityHash = computeCapabilityHash(CAPS, sha256Hex);
  const canonical = buildCanonicalInput({ sourceId: 'transport-websocket', ts, nonce, capabilityHash });
  let sig = createHmac('sha256', key).update(canonical, 'utf-8').digest('hex');
  if (over?.mangle) {
    // Flip the first hex digit to a guaranteed-different value.
    const first = sig.charAt(0);
    const flipped = first === '0' ? 'f' : '0';
    sig = flipped + sig.slice(1);
  }
  return { kid, nonce, ts, tokenSig: `hmac-sha256:${sig}` };
};

describe('Plan52 Phase C — WsPushInputAuthenticator', () => {
  describe('Legacy passthrough', () => {
    it('returns frozen-empty sourceContext when enabled=false', async () => {
      const auth = new WsPushInputAuthenticator({ enabled: false });
      const result = await auth.verifyMessage({}, 'trace-ws-legacy');
      expect(result.ok).toBe(true);
      if (result.ok) expect(Object.keys(result.sourceContext)).toHaveLength(0);
    });
  });

  describe('Happy path', () => {
    let auth: WsPushInputAuthenticator;
    beforeEach(() => {
      auth = new WsPushInputAuthenticator({
        enabled: true,
        keyResolver: resolver,
        capabilitySet: CAPS,
      });
    });

    it('verifies a fresh per-message envelope', async () => {
      const env = buildEnvelope();
      const result = await auth.verifyMessage(env, 'trace-ws-ok');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.sourceContext.tokenSig).toBe(env.tokenSig);
        expect(Object.isFrozen(result.sourceContext)).toBe(true);
      }
    });
  });

  describe('Adversarial', () => {
    let auth: WsPushInputAuthenticator;
    beforeEach(() => {
      auth = new WsPushInputAuthenticator({
        enabled: true,
        keyResolver: resolver,
        capabilitySet: CAPS,
      });
    });

    it('NEG-1: rejects mangled signature', async () => {
      const result = await auth.verifyMessage(buildEnvelope({ mangle: true }), 'trace-ws-neg1');
      expect(result.ok).toBe(false);
    });

    it('NEG-2: rejects nonce replay', async () => {
      const env = buildEnvelope({ nonce: 'fixed-ws-nonce' });
      expect((await auth.verifyMessage(env, 't-1')).ok).toBe(true);
      expect((await auth.verifyMessage(env, 't-2')).ok).toBe(false);
    });

    it('NEG-4: rejects clock skew beyond budget', async () => {
      const env = buildEnvelope({ ts: Date.now() + 10 * 60_000 });
      const result = await auth.verifyMessage(env, 'trace-ws-neg4');
      expect(result.ok).toBe(false);
    });

    it('NEG-5: rejects missing envelope fields', async () => {
      const result = await auth.verifyMessage({ kid: 'ws-2026-04' }, 'trace-ws-neg5');
      expect(result.ok).toBe(false);
    });

    it('NEG-7: rejects unknown kid', async () => {
      const env = buildEnvelope({ kid: 'unknown-kid' });
      const result = await auth.verifyMessage(env, 'trace-ws-neg7');
      expect(result.ok).toBe(false);
    });
  });
});
