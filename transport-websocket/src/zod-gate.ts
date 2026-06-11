/**
 * Plan51 Module 1 — WebSocket Zod Gate (rollout #1).
 *
 * **R3 D-§5-A**: 推薦 21/2/0 (highest GUARDIAN priority).
 * **D-§5-C UNANIMOUS 23/0**: GUARDIAN-priority rollout — WebSocket first.
 *
 * Schema artefact: `WebSocketMessage` discriminated union over message-type.
 *
 * **Critical invariant per CV-§5-04 UNANIMOUS** (Plan52 opaque sourceContext
 * non-interference): if a message envelope carries a sourceContext-typed
 * field, the schema MUST mark that field as `z.unknown()`. Failure violates
 * the cycle 03-14 ratified opacity invariant.
 *
 * **Mode discipline (per Plan51 §4.1)**:
 *   - Inbound: `safeParse` with mode fallback per Plan49 SCHEMA_DRIFT_MODE.
 *     Initial mode = shadow/audited for ≥1 W2 round; then progress
 *     audited → strict.
 *   - Outbound: `parse` (assertion-style; we control the producer).
 *
 * **MR-6 posture**: lives in plugin layer, NOT `packages/core/`.
 *
 * @see openstarry_doc/Technical_Specifications/Plan51_Zod_Gate_Binding.md §4.1
 */

import { z, type ZodType } from 'zod';

/**
 * Plugin-local shadow of the Plan51 shared `ZodGateMiddleware` utility.
 *
 * Plan51 spec says the same dispatcher pattern applies; we keep this local
 * to avoid the WS plugin depending on `@openstarry/runner` (which is an
 * application, not a library export). The runner-side mode dispatcher
 * (Plan49 `resolveSchemaDriftMode()`) is consulted at the boundary by
 * runner-internal callers; in-plugin we use `safeParse` directly with the
 * mode falling back to env-var when the host wires it.
 *
 * **Plan49 single-process-global integrity** is preserved: this helper only
 * calls `schema.safeParse`; the dispatcher pattern is honoured by the
 * runner-side caller surrounding the plugin.
 */
type SchemaDriftResultLite<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function validateInbound<T>(schema: ZodType<T>, input: unknown, _context: string): SchemaDriftResultLite<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: parsed.error.message };
}

function assertOutbound<T>(schema: ZodType<T>, value: unknown, context: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`zod-gate assertOutbound[${context}]: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Inbound message types — matches existing WS protocol. */
const InboundUserInput = z.object({
  type: z.literal('user_input'),
  /** Plan52 opacity: sourceContext sub-field is `z.unknown()` (CP-1). */
  sessionId: z.string().min(1).optional(),
  payload: z.object({
    text: z.string(),
    /** Plan52 opaque sourceContext envelope (auth field arrives nested in payload). */
    auth: z.unknown().optional(),
  }),
});

const InboundPing = z.object({
  type: z.literal('ping'),
  sessionId: z.string().min(1).optional(),
});

/** Discriminated union over inbound WS message types. */
export const WebSocketInbound = z.discriminatedUnion('type', [
  InboundUserInput,
  InboundPing,
]);
export type WebSocketInboundType = z.infer<typeof WebSocketInbound>;

/** Outbound message envelope (we control the producer; assertion-style). */
const OutboundConnected = z.object({
  type: z.literal('connected'),
  clientId: z.string().min(1),
  sessionId: z.string().min(1),
  message: z.string(),
});

const OutboundAgentEvent = z.object({
  type: z.literal('agent_event'),
  event: z.object({
    type: z.string().min(1),
    timestamp: z.number().int().nonnegative(),
    /** Plan52 opacity: any sourceContext-bearing payload remains opaque. */
    payload: z.unknown(),
  }),
});

const OutboundPong = z.object({
  type: z.literal('pong'),
  timestamp: z.number().int().nonnegative(),
});

const OutboundError = z.object({
  type: z.literal('error'),
  error: z.string(),
});

const OutboundAuthRejected = z.object({
  type: z.literal('auth_rejected'),
  error: z.unknown(),
});

export const WebSocketOutbound = z.discriminatedUnion('type', [
  OutboundConnected,
  OutboundAgentEvent,
  OutboundPong,
  OutboundError,
  OutboundAuthRejected,
]);
export type WebSocketOutboundType = z.infer<typeof WebSocketOutbound>;

/**
 * Validate an inbound WS message string after JSON parsing.
 *
 * Returns the SchemaDriftResult per Plan49 dispatcher; caller handles per
 * the active mode (`tolerant` / `audited` / `strict`). On invalid frames
 * the existing `index.ts` already responds with `{ type: 'error' }`; this
 * gate adds Plan51 schema-drift policy on top.
 */
export function validateInboundMessage(rawJson: unknown) {
  return validateInbound(WebSocketInbound, rawJson, 'transport-websocket.inbound');
}

/** Assert an outbound message before `ws.send`; throws on mismatch. */
export function assertOutboundMessage(value: unknown): WebSocketOutboundType {
  return assertOutbound(WebSocketOutbound, value, 'transport-websocket.outbound');
}
