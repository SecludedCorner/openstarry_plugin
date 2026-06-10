/**
 * comm-pipeline — PipelineChannel communication plugin.
 *
 * Provides:
 * - PipelineChannel (色蘊 / rupa) — sequential agent-to-agent messaging via ICommChannel
 *
 * Five Aggregates: rupa (IUI + IListener category)
 * Plan37 MVP: implements 'messaging' capability only.
 * Reuses existing IPC infrastructure — no new transport layer needed.
 *
 * Doc 57 Section 7 reference implementation.
 * Imports only from @openstarry/sdk — never from the core package.
 */

import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  ICommChannel,
  CommMessage,
  CommMessageHandler,
  CommChannelStatus,
  CommCapability,
  CommTopology,
} from "@openstarry/sdk";

// ---------------------------------------------------------------------------
// PipelineChannel implementation
// ---------------------------------------------------------------------------

/**
 * PipelineChannel — Plan37 MVP.
 *
 * Implements 'messaging' capability only.
 * Routes through Daemon's MessageRouter via EventBus.
 * No new transport layer — reuses existing IPC infrastructure.
 *
 * State machine: disconnected -> connecting -> connected -> draining -> disconnected
 */
export class PipelineChannel implements ICommChannel {
  readonly name = 'pipeline';
  readonly version = '0.1.0-alpha';
  readonly capabilities: readonly CommCapability[] = ['messaging'];
  readonly topology: CommTopology = 'pipeline';

  private status: CommChannelStatus = 'disconnected';
  private handlers: Set<CommMessageHandler> = new Set();
  private ctx: IPluginContext;

  constructor(ctx: IPluginContext) {
    this.ctx = ctx;
  }

  getStatus(): CommChannelStatus {
    return this.status;
  }

  async connect(_target?: string): Promise<void> {
    this.status = 'connecting';
    // PipelineChannel reuses existing IPC infrastructure.
    // No new transport needed for Plan37 MVP.
    this.status = 'connected';
  }

  async disconnect(): Promise<void> {
    this.status = 'draining';
    // In real impl: wait for in-flight messages up to grace period.
    // For Plan37 MVP: clear immediately.
    this.handlers.clear();
    this.status = 'disconnected';
  }

  async send(target: string, message: CommMessage): Promise<void> {
    if (this.status !== 'connected') {
      throw new Error(`PipelineChannel not connected (status: ${this.status})`);
    }
    // Route through Daemon's MessageRouter via EventBus.
    // Daemon picks up via IPC on 'comm:send'.
    this.ctx.bus.emit({ type: 'comm:send', timestamp: Date.now(), payload: { target, message } });
  }

  onMessage(handler: CommMessageHandler): () => void {
    this.handlers.add(handler);

    // Subscribe to incoming messages delivered by the Daemon via EventBus.
    const unsub = this.ctx.bus.on('comm:message_received', (event) => {
      const data = event.payload as { message: CommMessage; from: string };
      handler(data.message, data.from);
    });

    return () => {
      this.handlers.delete(handler);
      unsub();
    };
  }

  async reply(msgId: string, response: CommMessage): Promise<void> {
    const replyMessage: CommMessage = {
      ...response,
      correlationId: msgId,
    };
    if (replyMessage.target) {
      await this.send(replyMessage.target, replyMessage);
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

/**
 * Creates the comm-pipeline plugin.
 *
 * Factory pattern: createCommPipelinePlugin() -> IPlugin
 * Five Aggregates: skandha 'rupa' (ICommChannel participates in the Rupa/色蘊 category)
 * Registers PipelineChannel via hooks.commChannels.
 *
 * Purity: imports only @openstarry/sdk, never the core package.
 */
export function createCommPipelinePlugin(): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/comm-pipeline',
      version: '0.1.0-alpha',
      description: 'Pipeline communication channel for sequential agent messaging',
      skandha: 'rupa',
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const channel = new PipelineChannel(ctx);

      return {
        commChannels: [channel],
        dispose: async () => {
          if (channel.getStatus() === 'connected') {
            await channel.disconnect();
          }
        },
      };
    },
  };
}

export default createCommPipelinePlugin;
