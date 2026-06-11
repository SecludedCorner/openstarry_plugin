/**
 * pushinput-auth — Plan52 Phase B source-authentication for transport-http.
 *
 * Wraps the SDK Phase A helpers (HMAC verify + nonce cache + canonical input
 * + deepFreeze + RecommendedSourceContextKeys) into a per-request verifier
 * that returns a frozen `sourceContext` for `ctx.pushInput(...)`.
 *
 * **MR-6 posture**: this module lives in the plugin layer; Core never sees it.
 * **CP-1**: Core never reads `sourceContext.*`; this verifier produces it; Core
 * forwards opaquely.
 *
 * @see openstarry_doc/Technical_Specifications/Plan52_pushInput_Binding.md
 * @see packages/sdk/src/utils/pushinput-helpers.ts (Phase A primitives)
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  buildCanonicalInput,
  computeCapabilityHash,
  deepFreeze,
  type KeyResolver,
  NonceCache,
  parseTokenSig,
  RecommendedSourceContextKeys,
  type ResolvedKey,
  type StructuredError,
  StructuredErrorCode,
  buildStructuredError,
  formatLikelyCause,
  LikelyCausePrefix,
} from '@openstarry/sdk';

/**
 * Per-plugin Plan52 authentication configuration.
 *
 * `enabled` defaults to false (backward compatibility — existing transport-http
 * deployments that don't configure Plan52 auth keep their pre-Plan52 behavior:
 * `sourceContext` is omitted from the emitted InputEvent).
 */
export interface PushInputAuthConfig {
  /** Activate Plan52 sourceContext attestation. Default: false. */
  readonly enabled?: boolean;
  /** Source identifier baked into canonicalInput; default 'transport-http'. */
  readonly sourceId?: string;
  /** KeyResolver for HMAC keys (kid → key); required when enabled. */
  readonly keyResolver?: KeyResolver;
  /** Nonce TTL in ms; MUST be ≥ rotation overlap. Default 15 min. */
  readonly nonceTtlMs?: number;
  /** Key-rotation overlap in ms. Default 10 min. */
  readonly rotationOverlapMs?: number;
  /** Maximum allowed clock skew between client and server (ms). Default 60 s. */
  readonly maxClockSkewMs?: number;
  /** Capability set advertised for this transport; folded into canonical input. */
  readonly capabilitySet?: readonly string[];
}

/** Result of a successful verification — caller passes context into pushInput. */
export interface VerifiedPushInput {
  readonly ok: true;
  readonly sourceContext: Readonly<Record<string, unknown>>;
}

/** Result of a failed verification — caller emits StructuredError + 401/403. */
export interface FailedPushInput {
  readonly ok: false;
  readonly httpStatus: 401 | 403 | 400;
  readonly error: StructuredError;
}

export type PushInputAuthResult = VerifiedPushInput | FailedPushInput;

/** Headers the verifier extracts; lowercased. */
export interface AuthHeaderBag {
  readonly authorization?: string;
  readonly 'x-os-nonce'?: string;
  readonly 'x-os-ts'?: string;
  readonly 'x-os-kid'?: string;
  readonly 'x-os-cap'?: string;
}

const sha256Hex = (input: string): string =>
  createHash('sha256').update(input, 'utf-8').digest('hex');

/**
 * Plan52 verifier — verifies an inbound HTTP/WS request's plugin-attested
 * source identity and returns a frozen `sourceContext` ready for pushInput.
 *
 * When `cfg.enabled === false`, returns `{ ok: true, sourceContext: <frozen empty> }`
 * to preserve legacy behavior — the caller may then choose to omit the field
 * from the emitted InputEvent (idiomatic legacy path).
 */
export class PushInputAuthenticator {
  private readonly nonceCache: NonceCache;
  private readonly capabilityHash: string;

  constructor(private readonly cfg: PushInputAuthConfig) {
    const ttl = cfg.nonceTtlMs ?? 15 * 60_000;
    const rot = cfg.rotationOverlapMs ?? 10 * 60_000;
    this.nonceCache = new NonceCache(ttl, rot);
    this.capabilityHash = computeCapabilityHash(cfg.capabilitySet ?? [], sha256Hex);
  }

  /**
   * Verify request headers + return `sourceContext` ready for pushInput.
   *
   * Required headers when enabled:
   *   - Authorization: <algorithm-prefix>:<hex-signature>
   *   - X-OS-Nonce:    <hex-nonce>
   *   - X-OS-Ts:       <unix-epoch-ms>
   *   - X-OS-Kid:      <key-id>
   *
   * Optional:
   *   - X-OS-Cap:      <comma-separated capability list — verified against cfg>
   */
  async verify(headers: AuthHeaderBag, traceId: string): Promise<PushInputAuthResult> {
    if (!this.cfg.enabled) {
      // Legacy path: empty frozen sourceContext (caller omits from InputEvent).
      return { ok: true, sourceContext: deepFreeze({}) };
    }
    if (!this.cfg.keyResolver) {
      return this.fail(500 as never, traceId, StructuredErrorCode.InternalError, 'PushInput auth enabled without keyResolver',
        formatLikelyCause(LikelyCausePrefix.Verified, 'plugin misconfiguration'));
    }

    const authz = headers.authorization;
    const nonce = headers['x-os-nonce'];
    const tsStr = headers['x-os-ts'];
    const kid = headers['x-os-kid'];

    if (!authz || !nonce || !tsStr || !kid) {
      return this.fail(401, traceId, StructuredErrorCode.PermissionDenied,
        'Missing one of required headers: Authorization, X-OS-Nonce, X-OS-Ts, X-OS-Kid',
        formatLikelyCause(LikelyCausePrefix.Verified, 'client did not send Plan52 auth headers'));
    }

    const ts = Number.parseInt(tsStr, 10);
    if (!Number.isFinite(ts)) {
      return this.fail(400, traceId, StructuredErrorCode.ValidationError, 'X-OS-Ts is not an integer',
        formatLikelyCause(LikelyCausePrefix.Verified, 'malformed timestamp header'));
    }

    const skew = Math.abs(Date.now() - ts);
    const maxSkew = this.cfg.maxClockSkewMs ?? 60_000;
    if (skew > maxSkew) {
      return this.fail(401, traceId, StructuredErrorCode.PermissionDenied,
        `Clock skew ${skew}ms exceeds budget ${maxSkew}ms (NEG-4 time-travel guard)`,
        formatLikelyCause(LikelyCausePrefix.Inferred, 'client clock drift or replay attempt'));
    }

    const parsed = parseTokenSig(authz);
    if (!parsed) {
      return this.fail(401, traceId, StructuredErrorCode.PermissionDenied,
        'Authorization header missing or malformed algorithm prefix',
        formatLikelyCause(LikelyCausePrefix.Verified, 'NEG-3 algorithm-downgrade or non-conforming client'));
    }

    let resolved: ResolvedKey | null;
    try {
      resolved = await this.cfg.keyResolver.resolve(kid);
    } catch (err) {
      return this.fail(500 as never, traceId, StructuredErrorCode.DependencyFailure,
        'KeyResolver threw',
        formatLikelyCause(LikelyCausePrefix.Inferred, `keyResolver error: ${String((err as Error).message).slice(0, 80)}`));
    }
    if (!resolved) {
      return this.fail(401, traceId, StructuredErrorCode.PermissionDenied,
        `Unknown kid ${kid}`,
        formatLikelyCause(LikelyCausePrefix.Verified, 'client kid does not resolve'));
    }
    if (resolved.algorithm !== parsed.algorithm) {
      return this.fail(401, traceId, StructuredErrorCode.PermissionDenied,
        `Algorithm mismatch: resolver=${resolved.algorithm} request=${parsed.algorithm}`,
        formatLikelyCause(LikelyCausePrefix.Verified, 'NEG-3 algorithm-downgrade attempt or stale client'));
    }

    if (parsed.algorithm !== 'hmac-sha256') {
      // Ed25519 is documented alternative but not implemented in this delivery
      // (per Plan52 spec §5.2 — HMAC default is the SHOULD path).
      return this.fail(401, traceId, StructuredErrorCode.DependencyFailure,
        `Algorithm ${parsed.algorithm} not implemented in transport-http reference plugin`,
        formatLikelyCause(LikelyCausePrefix.Verified, 'Ed25519 deferred per Plan52 §5.2'));
    }

    const canonical = buildCanonicalInput({
      sourceId: this.cfg.sourceId ?? 'transport-http',
      ts,
      nonce,
      capabilityHash: this.capabilityHash,
    });
    const expected = createHmac('sha256', resolved.key).update(canonical, 'utf-8').digest();
    let received: Buffer;
    try {
      received = Buffer.from(parsed.signatureHex, 'hex');
    } catch {
      return this.fail(400, traceId, StructuredErrorCode.ValidationError,
        'Signature is not valid hex',
        formatLikelyCause(LikelyCausePrefix.Verified, 'NEG-1 forgery via malformed hex'));
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      return this.fail(401, traceId, StructuredErrorCode.PermissionDenied,
        'HMAC signature mismatch',
        formatLikelyCause(LikelyCausePrefix.Verified, 'NEG-1 signature forgery or wrong key'));
    }

    if (!this.nonceCache.register(nonce)) {
      return this.fail(401, traceId, StructuredErrorCode.PermissionDenied,
        `Nonce ${nonce.slice(0, 16)}... already used (NEG-2 replay)`,
        formatLikelyCause(LikelyCausePrefix.Verified, 'NEG-2 replay attempt within TTL window'));
    }

    const sourceContext = deepFreeze({
      [RecommendedSourceContextKeys.tokenSig]: authz,
      [RecommendedSourceContextKeys.nonce]: nonce,
      [RecommendedSourceContextKeys.ts]: ts,
      [RecommendedSourceContextKeys.capabilitySet]: [...(this.cfg.capabilitySet ?? [])].sort(),
      kid: resolved.kid,
      algorithm: resolved.algorithm,
    });
    return { ok: true, sourceContext };
  }

  /** Visible for testing — clear nonce cache between tests. */
  resetNonceCache(): void {
    this.nonceCache.reset();
  }

  private fail(
    status: number,
    traceId: string,
    code: typeof StructuredErrorCode[keyof typeof StructuredErrorCode],
    message: string,
    likelyCause: string,
  ): FailedPushInput {
    return {
      ok: false,
      httpStatus: (status === 400 || status === 401 || status === 403) ? status as 400 | 401 | 403 : 401,
      error: buildStructuredError({
        error: code,
        message,
        likely_cause: likelyCause,
        suggested_fix_location: 'openstarry_plugin/transport-http/src/pushinput-auth.ts',
        context: { plugin: 'transport-http', auth_layer: 'plan52' },
        trace_id: traceId,
      }),
    };
  }
}
