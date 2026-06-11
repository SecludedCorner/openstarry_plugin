/**
 * mesh / broker — Plan58 Option B Centralized Hub broker.
 *
 * **Plan52/54/56/57/58 isomorph**: HMAC-SHA256 verify + nonce cache replay
 * defense + tri-party MR-6 audit pattern. Replay cache `msh:` prefix
 * (5th contributor).
 *
 * **Forward constraints (D-§1-R2-E)**:
 *   - Fan-out only this cycle (DSS-CY21-§1-D aggregation-now preserved as
 *     Phase 7 deferred minority)
 *   - In-process single-host this cycle (cross-process Phase 7 forward-binding)
 *
 * **Boot-time fail-fast** inheriting Plan54 + Plan57 §5.5 four verifications.
 *
 * @see openstarry_doc/Technical_Specifications/Plan58_Mesh_Binding.md §2 + §6
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  MESH_REPLAY_CACHE_PREFIX,
  MeshMessageSchema,
  MeshPublishResultSchema,
  NonceCache,
  parseTokenSig,
  type MeshMessage,
  type MeshPublishResult,
} from '@openstarry/sdk';
import { compileRoutingTable, computeManifestIntegrityHash, type PluginManifestEntry, type RoutingTable } from './routing.js';

/** Per-target delivery handler — caller wires to plugin-side ingestion. */
export type MeshDeliveryHandler = (target_plugin: string, message: MeshMessage) => void;

/** Broker configuration. */
export interface MeshBrokerConfig {
  /** Hex-encoded HMAC key (≥ 32 bytes). MUST come from CSPRNG. */
  readonly hmacKeyHex?: string;
  /** Plugin manifests for boot-time routing-table compilation. */
  readonly manifests: readonly PluginManifestEntry[];
  /** Plan58 §5 replay cache (5-contributor opt-in). */
  readonly sharedNonceCache?: NonceCache;
  readonly nonceTtlMs?: number;
  readonly rotationOverlapMs?: number;
  /** Per-target delivery sink. */
  readonly delivery: MeshDeliveryHandler;
}

/** Broker public surface. */
export interface MeshBroker {
  publish(raw: unknown): MeshPublishResult;
  /** Manifest integrity SHA-256 attestation (Plan58 §2.4 verification 7). */
  readonly manifestIntegrityHash: string;
  /** Compiled routing table (read-only access for forensic / observability). */
  readonly routingTable: ReadonlyMap<string, ReadonlySet<string>>;
}

function loadHmacKey(provided?: string): Buffer {
  if (provided !== undefined) {
    if (!/^[A-Fa-f0-9]+$/.test(provided)) {
      throw new Error('mesh.boot: hmacKey must be hex-encoded (CSPRNG provenance)');
    }
    if (provided.length < 64) {
      throw new Error(`mesh.boot: hmacKey must be ≥ 32 bytes / 64 hex chars (got ${provided.length / 2})`);
    }
    return Buffer.from(provided, 'hex');
  }
  return randomBytes(32);
}

function verifyMessageHmac(msg: MeshMessage, key: Buffer): boolean {
  // Canonical input: topic|source_plugin|nonce|ts_utc|payload-hash
  const payloadHash = createHash('sha256').update(JSON.stringify(msg.payload ?? null), 'utf-8').digest('hex');
  const canonical = `${msg.topic}|${msg.source_plugin}|${msg.nonce}|${msg.ts_utc}|${payloadHash}`;
  const expected = createHmac('sha256', key).update(canonical, 'utf-8').digest();
  let received: Buffer;
  try {
    received = Buffer.from(msg.hmac_signature, 'hex');
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

export function createMeshBroker(cfg: MeshBrokerConfig): MeshBroker {
  const hmacKey = loadHmacKey(cfg.hmacKeyHex);
  const nonceTtl = cfg.nonceTtlMs ?? 24 * 60 * 60 * 1000;
  const rotation = cfg.rotationOverlapMs ?? 24 * 60 * 60 * 1000;
  const nonceCache = cfg.sharedNonceCache ?? new NonceCache(nonceTtl, rotation);

  // Boot-time: compile routing table + integrity hash. Fail-fast on cycles
  // or unresolved targets.
  const routingTable: RoutingTable = compileRoutingTable(cfg.manifests);
  const manifestIntegrityHash = computeManifestIntegrityHash(cfg.manifests);

  function publish(raw: unknown): MeshPublishResult {
    const parsed = MeshMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return MeshPublishResultSchema.parse({ success: false, fanout_count: 0, reason: 'invalid_request_schema' });
    }
    const msg = parsed.data;

    // Algo-prefix discipline (Plan52 CV-04 inheritance applied at sig parse).
    if (parseTokenSig(`hmac-sha256:${msg.hmac_signature}`) === null) {
      return MeshPublishResultSchema.parse({ success: false, fanout_count: 0, reason: 'invalid_request_schema' });
    }

    // HMAC verify.
    if (!verifyMessageHmac(msg, hmacKey)) {
      return MeshPublishResultSchema.parse({ success: false, fanout_count: 0, reason: 'tokenSig_verification_failed' });
    }

    // Replay defense (5-contributor `msh:` prefix).
    const cacheKey = `${MESH_REPLAY_CACHE_PREFIX}${msg.nonce}`;
    if (!nonceCache.register(cacheKey)) {
      return MeshPublishResultSchema.parse({ success: false, fanout_count: 0, reason: 'nonce_replay' });
    }

    // Topic lookup.
    const targets = routingTable.get(msg.topic);
    if (!targets || targets.size === 0) {
      return MeshPublishResultSchema.parse({ success: false, fanout_count: 0, reason: 'topic_unregistered' });
    }

    // Fan-out delivery (D-§1-R2-E forward constraint: fan-out only this cycle).
    let count = 0;
    for (const tgt of targets) {
      // Don't deliver back to source.
      if (tgt === msg.source_plugin) continue;
      cfg.delivery(tgt, msg);
      count++;
    }

    return MeshPublishResultSchema.parse({ success: true, fanout_count: count });
  }

  return {
    publish,
    manifestIntegrityHash,
    routingTable,
  };
}
