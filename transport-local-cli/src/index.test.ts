/**
 * Plan52 Phase D — transport-local-cli tests.
 * Covers I-3 (transport-local-cli) UID + PID attestation + sourceContext shape.
 */

import { userInfo } from 'node:os';
import { describe, expect, it } from 'vitest';
import { RecommendedSourceContextKeys } from '@openstarry/sdk';
import { buildLocalCliSourceContext } from './index.js';

describe('Plan52 Phase D — buildLocalCliSourceContext', () => {
  it('includes UID + GID + username from os.userInfo()', () => {
    const u = userInfo();
    const ctx = buildLocalCliSourceContext({});
    expect(ctx.uid).toBe(u.uid);
    expect(ctx.gid).toBe(u.gid);
    expect(ctx.username).toBe(u.username);
  });

  it('includes process PID', () => {
    const ctx = buildLocalCliSourceContext({});
    expect(ctx.pid).toBe(process.pid);
  });

  it('uses RecommendedSourceContextKeys for ts + capabilitySet (CR-SCK convention)', () => {
    const ctx = buildLocalCliSourceContext({ nowMs: 1_700_000_000_000 });
    expect(ctx[RecommendedSourceContextKeys.ts]).toBe(1_700_000_000_000);
    expect(ctx[RecommendedSourceContextKeys.capabilitySet]).toEqual(['read', 'write']);
  });

  it('sorts capabilitySet deterministically', () => {
    const ctx = buildLocalCliSourceContext({ capabilitySet: ['z', 'a', 'm'] });
    expect(ctx[RecommendedSourceContextKeys.capabilitySet]).toEqual(['a', 'm', 'z']);
  });

  it('omits tokenSig when not provided (D-§1-09 MAY-omit)', () => {
    const ctx = buildLocalCliSourceContext({});
    expect(ctx[RecommendedSourceContextKeys.tokenSig]).toBeUndefined();
  });

  it('includes tokenSig when provided', () => {
    const ctx = buildLocalCliSourceContext({ tokenSig: 'hmac-sha256:abc' });
    expect(ctx[RecommendedSourceContextKeys.tokenSig]).toBe('hmac-sha256:abc');
  });

  it('returns a deeply frozen sourceContext (CP-4)', () => {
    const ctx = buildLocalCliSourceContext({ capabilitySet: ['x'] });
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(Object.isFrozen(ctx[RecommendedSourceContextKeys.capabilitySet])).toBe(true);
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ctx as any).uid = -1;
    }).toThrow();
  });

  it('declares transport=local-cli for downstream routing', () => {
    const ctx = buildLocalCliSourceContext({});
    expect(ctx.transport).toBe('local-cli');
  });
});
