/**
 * pushinput-auth — Plan52 Phase C source-authentication for transport-websocket.
 *
 * Two-layer auth:
 *  1. **Handshake-time** (HTTP upgrade headers): pre-shared secret OR
 *     handshake-time HMAC tokenSig — same primitives as transport-http.
 *  2. **Per-message** (WS frames): each user_input frame may carry a tokenSig
 *     in the payload `auth` field; verifier ensures nonce + ts uniqueness.
 *
 * **MR-6 posture**: plugin layer; Core never sees this.
 *
 * @see openstarry_doc/Technical_Specifications/Plan52_pushInput_Binding.md §C
 * @see packages/sdk/src/utils/pushinput-helpers.ts (Phase A primitives)
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  buildCanonicalInput,
  buildStructuredError,
  computeCapabilityHash,
  deepFreeze,
  formatLikelyCause,
  type KeyResolver,
  LikelyCausePrefix,
  NonceCache,
  parseTokenSig,
  RecommendedSourceContextKeys,
  type ResolvedKey,
  type StructuredError,
  StructuredErrorCode,
} from '@openstarry/sdk';

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf-8').digest('hex');

/** Per-plugin Plan52 WS authentication configuration. */
export interface WsPushInputAuthConfig {
  readonly enabled?: boolean;
  readonly sourceId?: string;
  readonly keyResolver?: KeyResolver;
  readonly nonceTtlMs?: number;
  readonly rotationOverlapMs?: number;
  readonly maxClockSkewMs?: number;
  readonly capabilitySet?: readonly string[];
}

/** Per-message auth envelope carried in WS payload (caller produces). */
export interface WsAuthEnvelope {
  readonly kid?: string;
  readonly nonce?: string;
  readonly ts?: number;
  readonly tokenSig?: string;
}

export type WsAuthResult =
  | { ok: true; sourceContext: Readonly<Record<string, unknown>> }
  | { ok: false; error: StructuredError };

export class WsPushInputAuthenticator {
  private readonly nonceCache: NonceCache;
  private readonly capabilityHash: string;

  constructor(private readonly cfg: WsPushInputAuthConfig) {
    const ttl = cfg.nonceTtlMs ?? 15 * 60_000;
    const rot = cfg.rotationOverlapMs ?? 10 * 60_000;
    this.nonceCache = new NonceCache(ttl, rot);
    this.capabilityHash = computeCapabilityHash(cfg.capabilitySet ?? [], sha256Hex);
  }

  async verifyMessage(envelope: WsAuthEnvelope, traceId: string): Promise<WsAuthResult> {
    if (!this.cfg.enabled) {
      return { ok: true, sourceContext: deepFreeze({}) };
    }
    if (!this.cfg.keyResolver) {
      return this.fail(traceId, StructuredErrorCode.InternalError,
        'WS pushInput auth enabled without keyResolver',
        formatLikelyCause(LikelyCausePrefix.Verified, 'plugin misconfiguration'));
    }

    const { kid, nonce, ts, tokenSig } = envelope;
    if (!kid || !nonce || ts === undefined || !tokenSig) {
      return this.fail(traceId, StructuredErrorCode.PermissionDenied,
        'WS message missing one of: auth.kid, auth.nonce, auth.ts, auth.tokenSig',
        formatLikelyCause(LikelyCausePrefix.Verified, 'client did not include Plan52 auth envelope'));
    }
    if (!Number.isFinite(ts)) {
      return this.fail(traceId, StructuredErrorCode.ValidationError, 'auth.ts is not finite',
        formatLikelyCause(LikelyCausePrefix.Verified, 'malformed timestamp'));
    }
    const skew = Math.abs(Date.now() - ts);
    const maxSkew = this.cfg.maxClockSkewMs ?? 60_000;
    if (skew > maxSkew) {
      return this.fail(traceId, StructuredErrorCode.PermissionDenied,
        `Clock skew ${skew}ms exceeds ${maxSkew}ms (NEG-4)`,
        formatLikelyCause(LikelyCausePrefix.Inferred, 'clock drift or replay'));
    }

    const parsed = parseTokenSig(tokenSig);
    if (!parsed) {
      return this.fail(traceId, StructuredErrorCode.PermissionDenied,
        'auth.tokenSig missing or malformed algorithm prefix',
        formatLikelyCause(LikelyCausePrefix.Verified, 'NEG-3 algorithm-downgrade'));
    }

    let resolved: ResolvedKey | null;
    try {
      resolved = await this.cfg.keyResolver.resolve(kid);
    } catch (err) {
      return this.fail(traceId, StructuredErrorCode.DependencyFailure, 'KeyResolver threw',
        formatLikelyCause(LikelyCausePrefix.Inferred, `keyResolver: ${String((err as Error).message).slice(0, 80)}`));
    }
    if (!resolved) {
      return this.fail(traceId, StructuredErrorCode.PermissionDenied, `Unknown kid ${kid}`,
        formatLikelyCause(LikelyCausePrefix.Verified, 'kid does not resolve'));
    }
    if (resolved.algorithm !== parsed.algorithm) {
      return this.fail(traceId, StructuredErrorCode.PermissionDenied,
        `Algorithm mismatch: resolver=${resolved.algorithm} request=${parsed.algorithm}`,
        formatLikelyCause(LikelyCausePrefix.Verified, 'NEG-3 downgrade'));
    }
    if (parsed.algorithm !== 'hmac-sha256') {
      return this.fail(traceId, StructuredErrorCode.DependencyFailure,
        `Algorithm ${parsed.algorithm} not implemented in transport-websocket reference`,
        formatLikelyCause(LikelyCausePrefix.Verified, 'Ed25519 deferred per Plan52 §5.2'));
    }

    const canonical = buildCanonicalInput({
      sourceId: this.cfg.sourceId ?? 'transport-websocket',
      ts,
      nonce,
      capabilityHash: this.capabilityHash,
    });
    const expected = createHmac('sha256', resolved.key).update(canonical, 'utf-8').digest();
    let received: Buffer;
    try {
      received = Buffer.from(parsed.signatureHex, 'hex');
    } catch {
      return this.fail(traceId, StructuredErrorCode.ValidationError, 'Signature not valid hex',
        formatLikelyCause(LikelyCausePrefix.Verified, 'NEG-1 forgery'));
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return this.fail(traceId, StructuredErrorCode.PermissionDenied, 'HMAC signature mismatch',
        formatLikelyCause(LikelyCausePrefix.Verified, 'NEG-1 forgery or wrong key'));
    }
    if (!this.nonceCache.register(nonce)) {
      return this.fail(traceId, StructuredErrorCode.PermissionDenied,
        `Nonce ${nonce.slice(0, 16)}... already used (NEG-2 replay)`,
        formatLikelyCause(LikelyCausePrefix.Verified, 'NEG-2 replay attempt'));
    }

    return {
      ok: true,
      sourceContext: deepFreeze({
        [RecommendedSourceContextKeys.tokenSig]: tokenSig,
        [RecommendedSourceContextKeys.nonce]: nonce,
        [RecommendedSourceContextKeys.ts]: ts,
        [RecommendedSourceContextKeys.capabilitySet]: [...(this.cfg.capabilitySet ?? [])].sort(),
        kid: resolved.kid,
        algorithm: resolved.algorithm,
      }),
    };
  }

  resetNonceCache(): void {
    this.nonceCache.reset();
  }

  private fail(
    traceId: string,
    code: typeof StructuredErrorCode[keyof typeof StructuredErrorCode],
    message: string,
    likelyCause: string,
  ): { ok: false; error: StructuredError } {
    return {
      ok: false,
      error: buildStructuredError({
        error: code,
        message,
        likely_cause: likelyCause,
        suggested_fix_location: 'openstarry_plugin/transport-websocket/src/pushinput-auth.ts',
        context: { plugin: 'transport-websocket', auth_layer: 'plan52' },
        trace_id: traceId,
      }),
    };
  }
}
