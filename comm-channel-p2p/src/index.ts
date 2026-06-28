/**
 * comm-channel-p2p — a REAL point-to-point ICommChannel over the daemon transport.
 *
 * Five Aggregates Mapping: ICommChannel (色蘊 / IRupa — multi-agent communication
 * channel; see PluginHooks.commChannels).
 *
 * Closes the Doc 53 gap (verified by audit): `ICommChannel` was a frozen contract
 * with a populated-but-never-consumed `commChannelRegistry` — `send()`/`onMessage()`
 * did real work nowhere (comm-pipeline's channel was an EventBus stub). This plugin
 * provides the first ICommChannel whose `send()` actually delivers cross-daemon via
 * the real transport (SERVICE_KEYS.DAEMON_COMM, Fractal Society C/T1) and whose
 * `onMessage()` fires on real inbound traffic — the daemon dispatches every received
 * CommMessage to registered channels (consuming the registry).
 *
 * Capability: 'messaging' (send / onMessage / reply). Topology: point-to-point. All
 * security (capability lattice, HMAC, replay) is enforced by the daemon MessageRouter
 * underneath — Doc 53 §8.1 ("all messages route through the Daemon's MessageRouter").
 *
 * Honest scope: same-host, same-state-dir cluster (inherited from the transport).
 * Outside daemon mode the DAEMON_COMM service is absent and send()/reply() throw.
 *
 * Purity: imports @openstarry/sdk only.
 */

import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  ICommChannel,
  CommCapability,
  CommChannelStatus,
  CommTopology,
  CommMessage,
  CommMessageHandler,
} from "@openstarry/sdk";
import { SERVICE_KEYS } from "@openstarry/sdk";

const NO_DAEMON =
  "comm-channel-p2p: the DAEMON_COMM service is unavailable (daemon mode only).";

/**
 * Real point-to-point channel. `deliverInbound` is a non-interface method the
 * daemon calls to feed received messages (the frozen ICommChannel has no inbound
 * injection method; channels self-source inbound — here via the daemon dispatch).
 */
export class DaemonP2PChannel implements ICommChannel {
  readonly name = "p2p";
  readonly version = "0.1.0-alpha";
  readonly capabilities: readonly CommCapability[] = ["messaging"];
  readonly topology: CommTopology = "point-to-point";

  private status: CommChannelStatus = "disconnected";
  private readonly handlers = new Set<CommMessageHandler>();
  private readonly received: CommMessage[] = [];
  private static readonly MAX_RECEIVED = 1000;

  constructor(private readonly ctx: IPluginContext) {}

  getStatus(): CommChannelStatus {
    return this.status;
  }

  async connect(): Promise<void> {
    this.status = "connected";
  }

  async disconnect(): Promise<void> {
    this.status = "disconnected";
  }

  async send(target: string, message: CommMessage): Promise<void> {
    if (this.status !== "connected") {
      throw new Error(`comm-channel-p2p: channel not connected (status: ${this.status})`);
    }
    const svc = this.ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
    if (!svc) throw new Error(NO_DAEMON);
    // Routes through the daemon MessageRouter (validateOutbound + HMAC) — Doc 53 §8.1.
    await svc.send({
      target,
      payload: message.payload,
      ...(message.performative !== undefined ? { performative: message.performative } : {}),
    });
  }

  onMessage(handler: CommMessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async reply(msgId: string, response: CommMessage): Promise<void> {
    const svc = this.ctx.services?.get(SERVICE_KEYS.DAEMON_COMM);
    if (!svc) throw new Error(NO_DAEMON);
    if (!response.target) throw new Error("comm-channel-p2p: reply requires response.target");
    await svc.reply(response.target, msgId, response.payload);
  }

  /**
   * Daemon-only entry point: feed a received CommMessage into this channel. Records
   * it (bounded) and invokes every registered onMessage handler (errors isolated).
   * Not part of the frozen ICommChannel — the daemon duck-types this on inbound.
   */
  deliverInbound(message: CommMessage, from: string): void {
    if (this.received.length >= DaemonP2PChannel.MAX_RECEIVED) this.received.shift();
    this.received.push(message);
    for (const h of this.handlers) {
      try {
        h(message, from);
      } catch {
        /* a handler error must not break delivery to the others */
      }
    }
  }

  /** Daemon-only: messages this channel has received (for inspection / e2e). */
  getReceived(): CommMessage[] {
    return this.received.slice();
  }
}

export function createCommChannelP2pPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/comm-channel-p2p",
      version: "0.1.0-alpha",
      description:
        "A real point-to-point ICommChannel ('messaging') over the daemon cross-process transport — closes the Doc 53 gap where the commChannelRegistry was populated but never consumed (Tenet #10; daemon mode only)",
      skandha: "rupa" as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      return {
        commChannels: [new DaemonP2PChannel(ctx)],
      };
    },
  };
}

export default createCommChannelP2pPlugin;
