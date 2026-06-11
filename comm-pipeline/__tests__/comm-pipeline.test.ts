/**
 * Tests for @openstarry-plugin/comm-pipeline
 *
 * Covers:
 * 1. Plugin factory returns commChannels hook with PipelineChannel
 * 2. Manifest declares skandha as 'rupa'
 * 3. PipelineChannel lifecycle: connect -> connected -> disconnect -> disconnected
 * 4. send() throws when not connected
 * 5. onMessage() returns unsubscribe function
 * 6. ZERO imports from @openstarry/core (purity check)
 */

import { describe, it, expect, vi } from 'vitest';
import { createCommPipelinePlugin, PipelineChannel } from '../src/index.js';
import type { IPluginContext } from '@openstarry/sdk';

// ---------------------------------------------------------------------------
// Minimal mock IPluginContext
// ---------------------------------------------------------------------------

function createMockContext(): IPluginContext {
  const handlers: Map<string, Array<(event: { payload: unknown }) => void>> = new Map();

  const bus = {
    emit: vi.fn((event: { type: string; timestamp: number; payload?: unknown }) => {
      const list = handlers.get(event.type) ?? [];
      for (const h of list) {
        h({ type: event.type, timestamp: event.timestamp, payload: event.payload });
      }
    }),
    on: vi.fn((eventType: string, handler: (event: { type: string; timestamp: number; payload?: unknown }) => void) => {
      const list = handlers.get(eventType) ?? [];
      list.push(handler);
      handlers.set(eventType, list);
      // Return unsubscribe function
      return () => {
        const updated = handlers.get(eventType) ?? [];
        const idx = updated.indexOf(handler);
        if (idx !== -1) updated.splice(idx, 1);
        handlers.set(eventType, updated);
      };
    }),
  };

  return {
    bus: bus as unknown as IPluginContext['bus'],
    workingDirectory: '/tmp',
    agentId: 'test-agent',
    config: {},
    pushInput: vi.fn(),
    sessions: {
      create: vi.fn(),
      get: vi.fn(),
      destroy: vi.fn(),
      list: vi.fn(),
    } as unknown as IPluginContext['sessions'],
  };
}

// ---------------------------------------------------------------------------
// Test 1: Plugin factory returns commChannels hook with PipelineChannel
// ---------------------------------------------------------------------------

describe('createCommPipelinePlugin', () => {
  it('factory returns hooks with commChannels containing a PipelineChannel', async () => {
    const plugin = createCommPipelinePlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);

    // commChannels slot must exist and contain at least one channel
    expect(hooks.commChannels).toBeDefined();
    expect(Array.isArray(hooks.commChannels)).toBe(true);
    expect(hooks.commChannels!.length).toBe(1);

    const channel = hooks.commChannels![0];
    expect(channel).toBeInstanceOf(PipelineChannel);
    expect(channel.name).toBe('pipeline');
    expect(channel.topology).toBe('pipeline');
    expect(channel.capabilities).toContain('messaging');
  });
});

// ---------------------------------------------------------------------------
// Test 2: Manifest declares skandha as 'rupa'
// ---------------------------------------------------------------------------

describe('plugin manifest', () => {
  it('declares skandha as rupa', () => {
    const plugin = createCommPipelinePlugin();

    expect(plugin.manifest.name).toBe('@openstarry-plugin/comm-pipeline');
    expect(plugin.manifest.skandha).toBe('rupa');
    expect(plugin.manifest.version).toBe('0.1.0-alpha');
  });
});

// ---------------------------------------------------------------------------
// Test 3: PipelineChannel lifecycle
// ---------------------------------------------------------------------------

describe('PipelineChannel lifecycle', () => {
  it('starts disconnected, transitions to connected on connect(), disconnected on disconnect()', async () => {
    const ctx = createMockContext();
    const channel = new PipelineChannel(ctx);

    expect(channel.getStatus()).toBe('disconnected');

    await channel.connect();
    expect(channel.getStatus()).toBe('connected');

    await channel.disconnect();
    expect(channel.getStatus()).toBe('disconnected');
  });

  it('connect() with target parameter still transitions to connected', async () => {
    const ctx = createMockContext();
    const channel = new PipelineChannel(ctx);

    await channel.connect('other-agent-id');
    expect(channel.getStatus()).toBe('connected');
  });
});

// ---------------------------------------------------------------------------
// Test 4: send() throws when not connected
// ---------------------------------------------------------------------------

describe('PipelineChannel.send', () => {
  it('throws when not connected (disconnected state)', async () => {
    const ctx = createMockContext();
    const channel = new PipelineChannel(ctx);

    await expect(
      channel.send('target-agent', {
        id: 'msg-1',
        timestamp: Date.now(),
        source: 'test-agent',
        target: 'target-agent',
        payload: { text: 'hello' },
      })
    ).rejects.toThrow('PipelineChannel not connected');
  });

  it('emits comm:send event via bus when connected', async () => {
    const ctx = createMockContext();
    const channel = new PipelineChannel(ctx);
    await channel.connect();

    const message = {
      id: 'msg-2',
      timestamp: Date.now(),
      source: 'test-agent',
      target: 'target-agent',
      payload: { text: 'hello' },
    };

    await channel.send('target-agent', message);

    expect(ctx.bus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'comm:send',
        payload: { target: 'target-agent', message },
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Test 5: onMessage() returns unsubscribe function
// ---------------------------------------------------------------------------

describe('PipelineChannel.onMessage', () => {
  it('returns a function that unsubscribes the handler', async () => {
    const ctx = createMockContext();
    const channel = new PipelineChannel(ctx);

    const handler = vi.fn();
    const unsubscribe = channel.onMessage(handler);

    expect(typeof unsubscribe).toBe('function');

    // Call unsubscribe — should not throw
    expect(() => unsubscribe()).not.toThrow();
  });

  it('handler is called when comm:message_received is emitted on bus', async () => {
    const ctx = createMockContext();
    const channel = new PipelineChannel(ctx);

    const handler = vi.fn();
    channel.onMessage(handler);

    const incomingMessage = {
      id: 'msg-3',
      timestamp: Date.now(),
      source: 'sender-agent',
      target: 'test-agent',
      payload: { text: 'incoming' },
    };

    // Simulate daemon delivering a message via EventBus
    ctx.bus.emit({
      type: 'comm:message_received',
      timestamp: Date.now(),
      payload: { message: incomingMessage, from: 'sender-agent' },
    });

    expect(handler).toHaveBeenCalledWith(incomingMessage, 'sender-agent');
  });

  it('handler is NOT called after unsubscribe', async () => {
    const ctx = createMockContext();
    const channel = new PipelineChannel(ctx);

    const handler = vi.fn();
    const unsubscribe = channel.onMessage(handler);
    unsubscribe();

    ctx.bus.emit({
      type: 'comm:message_received',
      timestamp: Date.now(),
      payload: {
        message: {
          id: 'msg-4',
          timestamp: Date.now(),
          source: 'sender-agent',
          payload: {},
        },
        from: 'sender-agent',
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 6: ZERO imports from @openstarry/core (purity check)
// ---------------------------------------------------------------------------

describe('microkernel purity', () => {
  it('plugin source has zero imports from @openstarry/core', async () => {
    // Read the source file content and verify no core imports exist.
    // This mirrors what the purity test script does.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const srcPath = join(__dirname, '..', 'src', 'index.ts');

    const source = readFileSync(srcPath, 'utf-8');

    // Must not have an import statement that references @openstarry/core
    // (Checks for 'from "@openstarry/core"' or "from '@openstarry/core'")
    expect(source).not.toMatch(/from\s+["']@openstarry\/core["']/);
  });
});
