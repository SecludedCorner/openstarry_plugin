/**
 * api-runtime / invoke — mutating intervention path tests.
 *
 * Plan59 §6.1 + §4 + §6.3:
 *   - HMAC-SHA256 verify (canonical input)
 *   - `apr:` 6-contributor replay defense
 *   - bounded intervention 4-tuple (3 valid kinds + reject all others)
 *   - boot-time fail-fast on bad HMAC key
 */

import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NonceCache } from '@openstarry/sdk';
import { buildCanonical, createInvoke, loadHmacKey } from '../src/invoke.js';
import { PluginStateRegistry } from '../src/state.js';

const KEY_HEX = 'a'.repeat(64);
const KEY = Buffer.from(KEY_HEX, 'hex');

function sign(req: { target_plugin: string; intervention: { kind: string }; nonce: string; ts_utc: string }): string {
  return createHmac('sha256', KEY)
    .update(buildCanonical(req as Parameters<typeof buildCanonical>[0]), 'utf-8')
    .digest('hex');
}

function nonce(): string {
  return randomBytes(8).toString('hex');
}

function setup() {
  const registry = new PluginStateRegistry();
  registry.register('p1');
  const nonceCache = new NonceCache(60_000, 30_000);
  const invoke = createInvoke({ registry, hmacKey: KEY, nonceCache });
  return { registry, nonceCache, invoke };
}

let env: ReturnType<typeof setup>;
beforeEach(() => { env = setup(); });
afterEach(() => { env.nonceCache.reset(); });

describe('invoke — boot-time fail-fast (Plan52/54/58 isomorph loadHmacKey)', () => {
  it('rejects non-hex hmac key', () => {
    expect(() => loadHmacKey('not-hex!')).toThrow(/hex-encoded/);
  });
  it('rejects hex key < 32 bytes (64 chars)', () => {
    expect(() => loadHmacKey('a'.repeat(32))).toThrow(/≥ 32 bytes/);
  });
  it('accepts hex key ≥ 32 bytes', () => {
    expect(loadHmacKey('a'.repeat(64))).toHaveLength(32);
  });
  it('synthesises CSPRNG key when none provided', () => {
    expect(loadHmacKey()).toHaveLength(32);
  });
});

describe('invoke — request schema validation', () => {
  it('rejects missing field → invalid_request_schema', () => {
    const r = env.invoke({ target_plugin: 'p1' });
    expect(r).toEqual({ success: false, reason: 'invalid_request_schema' });
  });
  it('rejects unknown intervention kind → invalid_request_schema (Zod parse rejects)', () => {
    const ts = '2026-05-04T03:30:00Z';
    const n = nonce();
    const r = env.invoke({
      target_plugin: 'p1',
      intervention: { kind: 'restart_plugin' },  // out-of-scope
      nonce: n,
      ts_utc: ts,
      hmac_signature: 'a'.repeat(64),
    });
    expect(r.success).toBe(false);
    expect(r.reason).toBe('invalid_request_schema');
  });
  it('rejects nonce < 8 hex chars', () => {
    const ts = '2026-05-04T03:30:00Z';
    const r = env.invoke({
      target_plugin: 'p1',
      intervention: { kind: 'debug_flag', enabled: true },
      nonce: 'aaaa',
      ts_utc: ts,
      hmac_signature: 'a'.repeat(64),
    });
    expect(r.reason).toBe('invalid_request_schema');
  });
});

describe('invoke — HMAC verify', () => {
  it('rejects wrong signature → tokenSig_verification_failed', () => {
    const ts = '2026-05-04T03:30:00Z';
    const n = nonce();
    const r = env.invoke({
      target_plugin: 'p1',
      intervention: { kind: 'debug_flag', enabled: true },
      nonce: n,
      ts_utc: ts,
      hmac_signature: 'b'.repeat(64),
    });
    expect(r).toEqual({ success: false, reason: 'tokenSig_verification_failed' });
  });

  it('accepts canonical signature', () => {
    const ts = '2026-05-04T03:30:00Z';
    const n = nonce();
    const req = {
      target_plugin: 'p1',
      intervention: { kind: 'debug_flag' as const, enabled: true },
      nonce: n,
      ts_utc: ts,
    };
    const r = env.invoke({ ...req, hmac_signature: sign(req) });
    expect(r).toEqual({ success: true });
  });
});

describe('invoke — `apr:` replay defense (6th contributor)', () => {
  it('rejects replay (same nonce twice) → nonce_replay', () => {
    const ts = '2026-05-04T03:30:00Z';
    const n = nonce();
    const req = {
      target_plugin: 'p1',
      intervention: { kind: 'debug_flag' as const, enabled: true },
      nonce: n,
      ts_utc: ts,
    };
    const sig = sign(req);
    expect(env.invoke({ ...req, hmac_signature: sig })).toEqual({ success: true });
    expect(env.invoke({ ...req, hmac_signature: sig })).toEqual({ success: false, reason: 'nonce_replay' });
  });

  it('cache key uses `apr:` prefix (forensic test — no collision with msh:/psh:/etc)', () => {
    const ts = '2026-05-04T03:30:00Z';
    const n = nonce();
    const req = {
      target_plugin: 'p1',
      intervention: { kind: 'debug_flag' as const, enabled: true },
      nonce: n,
      ts_utc: ts,
    };
    env.invoke({ ...req, hmac_signature: sign(req) });
    // Manually probe the same nonce under a different prefix — should be free.
    expect(env.nonceCache.register(`msh:${n}`)).toBe(true);
    expect(env.nonceCache.register(`psh:${n}`)).toBe(true);
    expect(env.nonceCache.register(`apr:${n}`)).toBe(false);
  });
});

describe('invoke — bounded intervention 4-tuple (Plan59 §6.3)', () => {
  function send(kind: 'log_level', level: 'info' | 'warn' | 'error' | 'debug'): ReturnType<typeof env.invoke>;
  function send(kind: 'debug_flag' | 'soft_tracing', enabled: boolean): ReturnType<typeof env.invoke>;
  function send(kind: string, val: unknown) {
    const ts = '2026-05-04T03:30:00Z';
    const n = nonce();
    const intervention =
      kind === 'log_level' ? { kind, level: val } :
      { kind, enabled: val };
    const req = { target_plugin: 'p1', intervention, nonce: n, ts_utc: ts };
    return env.invoke({ ...req, hmac_signature: sign(req as Parameters<typeof buildCanonical>[0]) });
  }

  it('row 1: log_level toggle (info|warn|error|debug) all accepted', () => {
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      const r = send('log_level', level);
      expect(r.success).toBe(true);
      expect(env.registry.snapshot('p1')!.log_level).toBe(level);
    }
  });

  it('row 2: debug_flag toggle', () => {
    expect(send('debug_flag', true).success).toBe(true);
    expect(env.registry.snapshot('p1')!.debug_flag).toBe(true);
    expect(send('debug_flag', false).success).toBe(true);
    expect(env.registry.snapshot('p1')!.debug_flag).toBe(false);
  });

  it('row 3: soft_tracing toggle', () => {
    expect(send('soft_tracing', true).success).toBe(true);
    expect(env.registry.snapshot('p1')!.soft_tracing).toBe(true);
  });

  it('row 4: any other kind rejected at schema parse', () => {
    for (const kind of ['restart_plugin', 'force_unload', 'mutate_capability', 'arbitrary']) {
      const ts = '2026-05-04T03:30:00Z';
      const n = nonce();
      const r = env.invoke({
        target_plugin: 'p1',
        intervention: { kind, value: 'whatever' },
        nonce: n,
        ts_utc: ts,
        hmac_signature: 'a'.repeat(64),
      });
      expect(r.success).toBe(false);
      // Zod discriminatedUnion catches at parse — defence in depth taxonomy
      // 'intervention_kind_out_of_scope' is reserved for future widening.
      expect(['invalid_request_schema', 'intervention_kind_out_of_scope']).toContain(r.reason);
    }
  });
});

describe('invoke — registry coverage', () => {
  it('rejects unknown target_plugin → plugin_unregistered', () => {
    const ts = '2026-05-04T03:30:00Z';
    const n = nonce();
    const req = {
      target_plugin: 'unknown',
      intervention: { kind: 'debug_flag' as const, enabled: true },
      nonce: n,
      ts_utc: ts,
    };
    const r = env.invoke({ ...req, hmac_signature: sign(req) });
    expect(r).toEqual({ success: false, reason: 'plugin_unregistered' });
  });
});
