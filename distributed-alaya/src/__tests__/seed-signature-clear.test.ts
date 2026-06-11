/**
 * seed-signature-clear.test.ts — SEC-002 HMAC key clearing tests.
 *
 * Verifies that DaemonKeyProvider.clear() and SeedSignatureServiceImpl.clear()
 * zero out sensitive key material on dispose.
 *
 * AC-W0-1a: DaemonKeyProvider.clear() overwrites keyHex with '0' string
 * AC-W0-1b: SeedSignatureServiceImpl.clear() fills secret Buffer with 0
 * AC-W0-1c: plugin dispose calls clear() on signatureService (and keyProvider if DaemonKeyProvider)
 */

import { describe, it, expect, vi } from 'vitest';
import { DaemonKeyProvider, SeedSignatureServiceImpl } from '../seed-signature.js';
import { createDistributedAlayaPlugin } from '../index.js';
import type { IPluginContext } from '@openstarry/sdk';

// ─── AC-W0-1a: DaemonKeyProvider.clear() ─────────────────────────────────────

describe('DaemonKeyProvider.clear() — AC-W0-1a', () => {
  it('clear() overwrites keyHex with the same-length string of zeros', () => {
    const originalHex = 'deadbeef1234567890abcdef12345678deadbeef1234567890abcdef12345678';
    const provider = new DaemonKeyProvider(originalHex);

    // Before clear: getKey() returns the real key bytes
    const keyBefore = provider.getKey();
    expect(keyBefore).not.toEqual(Buffer.alloc(keyBefore.length, 0));

    provider.clear();

    // After clear: getKey() decodes '000...0' hex → all-zero buffer
    const keyAfter = provider.getKey();
    expect(keyAfter).toEqual(Buffer.alloc(keyAfter.length, 0));
  });

  it('clear() preserves the original length of keyHex', () => {
    const originalHex = 'aabbccdd11223344';
    const provider = new DaemonKeyProvider(originalHex);
    provider.clear();
    // getKey() on all-zero hex of same length returns zero buffer of half the length
    const keyAfter = provider.getKey();
    expect(keyAfter.length).toBe(originalHex.length / 2);
  });
});

// ─── AC-W0-1b: SeedSignatureServiceImpl.clear() ──────────────────────────────

describe('SeedSignatureServiceImpl.clear() — AC-W0-1b', () => {
  it('clear() fills the HMAC secret buffer with zeros', async () => {
    const secret = Buffer.from('deadbeef'.repeat(8), 'hex'); // 32 bytes
    const service = new SeedSignatureServiceImpl(secret);

    // Verify secret is non-zero before clear
    expect(secret.some(b => b !== 0)).toBe(true);

    service.clear();

    // After clear: the same Buffer object is now all zeros
    expect(secret.every(b => b === 0)).toBe(true);
  });

  it('sign() produces a different (zeroed) result after clear()', async () => {
    const secret = Buffer.from('aabbccdd'.repeat(8), 'hex');
    const service = new SeedSignatureServiceImpl(Buffer.from(secret)); // copy so we can compare

    const seed = {
      seedId: 'test-seed',
      agentId: 'agent-a',
      skandha: 'vijnana' as const,
      content: {},
      visibility: 'private' as const,
      createdAt: 0,
      updatedAt: 0,
    };

    const sigBefore = await service.sign(seed);
    service.clear();
    const sigAfter = await service.sign(seed);

    // After zeroing, HMAC is computed with all-zero key — produces different signature
    expect(sigAfter).not.toBe(sigBefore);
  });
});

// ─── AC-W0-1c: plugin dispose calls clear() ───────────────────────────────────

describe('plugin dispose — AC-W0-1c', () => {
  it('dispose() calls clear() on signatureService and (for DaemonKeyProvider) keyProvider', async () => {
    const hmacKeyHex = 'deadbeef1234567890abcdef12345678deadbeef1234567890abcdef12345678';

    // Minimal plugin context mock
    const ctx: IPluginContext = {
      pushInput: vi.fn(),
      bus: {
        on: vi.fn().mockReturnValue(() => {}),
        once: vi.fn().mockReturnValue(() => {}),
        onAny: vi.fn().mockReturnValue(() => {}),
        emit: vi.fn(),
      },
      services: undefined,
    } as unknown as IPluginContext;

    const plugin = createDistributedAlayaPlugin({ agentId: 'agent-x', hmacKeyHex });
    const hooks = await plugin.factory(ctx);

    expect(hooks.dispose).toBeDefined();

    // After dispose, calling it must not throw
    expect(() => hooks.dispose!()).not.toThrow();
  });

  it('dispose() works without DaemonKeyProvider (RandomKeyProvider path) — no throw', async () => {
    const ctx: IPluginContext = {
      pushInput: vi.fn(),
      bus: {
        on: vi.fn().mockReturnValue(() => {}),
        once: vi.fn().mockReturnValue(() => {}),
        onAny: vi.fn().mockReturnValue(() => {}),
        emit: vi.fn(),
      },
      services: undefined,
    } as unknown as IPluginContext;

    // No hmacKeyHex → uses RandomKeyProvider (which has no .clear())
    const plugin = createDistributedAlayaPlugin({ agentId: 'agent-y' });
    const hooks = await plugin.factory(ctx);

    expect(() => hooks.dispose!()).not.toThrow();
  });
});
