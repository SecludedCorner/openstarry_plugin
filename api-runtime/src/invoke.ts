/**
 * api-runtime / invoke — bounded mutating intervention path.
 *
 * **Plan59 §6.1 file-level separation (R3 D-§1-R2-D 23/0)**: this module
 * contains the mutating path. Replay defense via the `apr:` prefix
 * (6th replay cache contributor; Plan52→Plan54→Plan56→Plan57→Plan58→**Plan59**).
 *
 * **Plan52/54/56/57/58/59 isomorph (Plan59 §3 dimension matrix)**:
 *   - HMAC-SHA256 verify (canonical input: target_plugin|intervention.kind|nonce|ts_utc)
 *   - CSPRNG nonce N≥8 hex (DSS-CY21-§1-B + DSS-CY22-§1-B preferred)
 *   - `apr:` prefix replay defense (Plan59 §4 R2-C 5-item AND-condition)
 *   - Tri-party MR-6 audit pattern (TANENBAUM + KERNEL + GUARDIAN AND-condition)
 *
 * **Bounded intervention 4-tuple (Plan59 §6.3 R3 D-§1-Clarif C3 23/0)**:
 *   1. log_level (info|warn|error|debug)
 *   2. debug_flag (boolean)
 *   3. soft_tracing (boolean)
 *   4. ANY other kind → reject `intervention_kind_out_of_scope`.
 *      The Zod `discriminatedUnion('kind', ...)` schema rejects unknown
 *      kinds at parse → result.reason = 'invalid_request_schema'; this
 *      explicit reason is reserved for any future widening that bypasses
 *      schema parsing (defence in depth).
 *
 * **Boundary invariant per Plan59 §6.2**: signatures of `InvokeFn` and
 * helpers stay strictly inside the canonical (target_plugin|kind|nonce|ts_utc)
 * tuple. The pushInput envelope's agent-identity and capability-set
 * fields are NEVER touched by this file (KERNEL R2 sub-check #7
 * set-disjointness PASS by static analysis).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  API_RUNTIME_REPLAY_CACHE_PREFIX,
  ApiRuntimeInvokeRequestSchema,
  ApiRuntimeInvokeResultSchema,
  INTERVENTION_KINDS,
  NonceCache,
  parseTokenSig,
  type ApiRuntimeInvokeRequest,
  type ApiRuntimeInvokeResult,
} from '@openstarry/sdk';
import type { PluginStateRegistry } from './state.js';

/** Canonical signing input — `target_plugin|kind|nonce|ts_utc` (pipe-separated). */
export function buildCanonical(req: Pick<ApiRuntimeInvokeRequest, 'target_plugin' | 'intervention' | 'nonce' | 'ts_utc'>): string {
  return `${req.target_plugin}|${req.intervention.kind}|${req.nonce}|${req.ts_utc}`;
}

function verifyHmac(req: ApiRuntimeInvokeRequest, key: Buffer): boolean {
  const canonical = buildCanonical(req);
  const expected = createHmac('sha256', key).update(canonical, 'utf-8').digest();
  let received: Buffer;
  try {
    received = Buffer.from(req.hmac_signature, 'hex');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

/**
 * Boot-time HMAC key loader — refuse-to-start on key < 32 bytes.
 * Inherits Plan54 / Plan58 `loadHmacKey` discipline verbatim.
 */
export function loadHmacKey(provided?: string): Buffer {
  if (provided !== undefined) {
    if (!/^[A-Fa-f0-9]+$/.test(provided)) {
      throw new Error('api-runtime.boot: hmacKey must be hex-encoded (CSPRNG provenance)');
    }
    if (provided.length < 64) {
      throw new Error(
        `api-runtime.boot: hmacKey must be ≥ 32 bytes / 64 hex chars (got ${provided.length / 2})`,
      );
    }
    return Buffer.from(provided, 'hex');
  }
  return randomBytes(32);
}

/** Function shape returned to plugin consumers. */
export type InvokeFn = (raw: unknown) => ApiRuntimeInvokeResult;

export interface InvokeFactoryArgs {
  readonly registry: PluginStateRegistry;
  readonly hmacKey: Buffer;
  readonly nonceCache: NonceCache;
}

/**
 * Build the invoke function. All four reject reasons are exhaustively
 * exposed via `ApiRuntimeInvokeResultSchema` and round-tripped through Zod
 * to keep ε-surface envelope strictly opaque to callers.
 */
export function createInvoke(args: InvokeFactoryArgs): InvokeFn {
  return function invoke(raw: unknown): ApiRuntimeInvokeResult {
    const parsed = ApiRuntimeInvokeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return ApiRuntimeInvokeResultSchema.parse({ success: false, reason: 'invalid_request_schema' });
    }
    const req = parsed.data;

    // Defence in depth: even though the Zod discriminatedUnion already rejects
    // unknown kinds at parse, a future schema widening would still trip this
    // explicit allow-list (Plan59 §6.3 4th row "ANY other kind requires R-input").
    if (!INTERVENTION_KINDS.includes(req.intervention.kind)) {
      return ApiRuntimeInvokeResultSchema.parse({
        success: false,
        reason: 'intervention_kind_out_of_scope',
      });
    }

    // Algo-prefix discipline (Plan52 CV-04 inheritance).
    if (parseTokenSig(`hmac-sha256:${req.hmac_signature}`) === null) {
      return ApiRuntimeInvokeResultSchema.parse({ success: false, reason: 'invalid_request_schema' });
    }

    if (!verifyHmac(req, args.hmacKey)) {
      return ApiRuntimeInvokeResultSchema.parse({ success: false, reason: 'tokenSig_verification_failed' });
    }

    // Replay defense — 6th contributor `apr:` prefix.
    const cacheKey = `${API_RUNTIME_REPLAY_CACHE_PREFIX}${req.nonce}`;
    if (!args.nonceCache.register(cacheKey)) {
      return ApiRuntimeInvokeResultSchema.parse({ success: false, reason: 'nonce_replay' });
    }

    if (!args.registry.has(req.target_plugin)) {
      return ApiRuntimeInvokeResultSchema.parse({ success: false, reason: 'plugin_unregistered' });
    }

    // Apply the bounded intervention.
    const ok = (() => {
      switch (req.intervention.kind) {
        case 'log_level':
          return args.registry.mutate(req.target_plugin, { log_level: req.intervention.level });
        case 'debug_flag':
          return args.registry.mutate(req.target_plugin, { debug_flag: req.intervention.enabled });
        case 'soft_tracing':
          return args.registry.mutate(req.target_plugin, { soft_tracing: req.intervention.enabled });
      }
    })();

    if (!ok) {
      return ApiRuntimeInvokeResultSchema.parse({ success: false, reason: 'plugin_internal_error' });
    }
    return ApiRuntimeInvokeResultSchema.parse({ success: true });
  };
}
