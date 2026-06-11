/**
 * Plan51 Module 1 — WebSocket Zod gate tests.
 *
 * Critical invariant CV-§5-04: sourceContext-bearing fields treated as opaque
 * (`z.unknown()`) to preserve Plan52 ratified opacity.
 */

import { describe, expect, it } from 'vitest';
import {
  WebSocketInbound,
  WebSocketOutbound,
  assertOutboundMessage,
  validateInboundMessage,
} from './zod-gate.js';

describe('Plan51 §4.1 — WebSocket Zod gate', () => {
  describe('Inbound discriminated union', () => {
    it('accepts user_input with optional payload.text', () => {
      const r = validateInboundMessage({ type: 'user_input', payload: { text: 'hello' } });
      expect(r.ok).toBe(true);
    });

    it('accepts user_input with sessionId + nested auth (Plan52 opacity preserved)', () => {
      const r = validateInboundMessage({
        type: 'user_input',
        sessionId: 'sess-1',
        payload: {
          text: 'hi',
          auth: { kid: 'k', nonce: 'n', ts: 1, tokenSig: 'hmac-sha256:abc' },
        },
      });
      expect(r.ok).toBe(true);
      // CV-§5-04: auth field is opaque (z.unknown); not interpreted by the gate.
      if (r.ok) {
        const msg = r.data as { type: 'user_input'; payload: { auth?: unknown } };
        expect(msg.payload.auth).toBeDefined();
      }
    });

    it('accepts ping', () => {
      expect(validateInboundMessage({ type: 'ping' }).ok).toBe(true);
    });

    it('rejects unknown message type', () => {
      expect(validateInboundMessage({ type: 'malicious', payload: {} }).ok).toBe(false);
    });

    it('rejects user_input missing payload.text', () => {
      expect(validateInboundMessage({ type: 'user_input', payload: {} }).ok).toBe(false);
    });

    it('rejects empty sessionId (boundary fuzz)', () => {
      expect(validateInboundMessage({
        type: 'user_input',
        sessionId: '',
        payload: { text: 'x' },
      }).ok).toBe(false);
    });
  });

  describe('Outbound discriminated union (assertion-style)', () => {
    it('accepts a connected envelope', () => {
      expect(assertOutboundMessage({
        type: 'connected',
        clientId: 'c-1',
        sessionId: 's-1',
        message: 'ok',
      }).type).toBe('connected');
    });

    it('accepts pong / agent_event / error / auth_rejected', () => {
      expect(WebSocketOutbound.safeParse({ type: 'pong', timestamp: 1 }).success).toBe(true);
      expect(WebSocketOutbound.safeParse({
        type: 'agent_event',
        event: { type: 'loop:finished', timestamp: 1, payload: {} },
      }).success).toBe(true);
      expect(WebSocketOutbound.safeParse({ type: 'error', error: 'boom' }).success).toBe(true);
      expect(WebSocketOutbound.safeParse({ type: 'auth_rejected', error: { code: 401 } }).success).toBe(true);
    });

    it('throws on outbound assertion failure (we control the producer)', () => {
      expect(() => assertOutboundMessage({ type: 'connected' } as never)).toThrow(/transport-websocket\.outbound/);
    });
  });

  describe('CV-§5-04 invariant: agent_event payload remains opaque (z.unknown)', () => {
    it('arbitrarily-shaped agent_event.payload passes outbound assertion', () => {
      const result = assertOutboundMessage({
        type: 'agent_event',
        event: {
          type: 'audit:completed',
          timestamp: 1,
          payload: { sourceContext: { tokenSig: 'hmac-sha256:opaque' } },
        },
      });
      expect(result.type).toBe('agent_event');
    });
  });

  describe('Plan51 + Plan52 integration: WebSocketInbound treats nested auth as opaque', () => {
    it('does not crack open auth subfields', () => {
      // Even invalid-looking auth shapes pass — Plan52 says Core/transport are opaque.
      const r = WebSocketInbound.safeParse({
        type: 'user_input',
        payload: { text: 'hi', auth: 'arbitrary-string-not-an-object' },
      });
      expect(r.success).toBe(true);
    });
  });
});
