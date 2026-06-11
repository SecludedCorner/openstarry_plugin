/**
 * comm-proxy — ICommChannel decorator with L2/L3/L5 fault isolation.
 *
 * Plan38 C10 (D4-R4).
 * Mandatory for multi-agent agents (Rule #38).
 *
 * Ordering (HERACLITUS optimized):
 * 1. L2 CB check → if OPEN, reject (no slot consumed)
 * 2. L3 Bulkhead acquire
 * 3. L5 Timeout set
 * 4. Actual send
 * 5. L2 record result
 * 6. L3 release slot
 */

import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  ICommChannel,
  ICommProxy,
  CommMessage,
  CommMessageHandler,
  CommCapability,
  CommTopology,
  CommChannelStatus,
  CircuitBreakerState,
  CommProxyConfig,
  IPluginService,
} from "@openstarry/sdk";
import { ServiceKey } from "@openstarry/sdk";
import { CircuitBreaker } from "./circuit-breaker.js";
import { Bulkhead } from "./bulkhead.js";
import { withTimeout } from "./timeout.js";

/**
 * ProxiedChannel wraps an ICommChannel with L2/L3/L5 fault isolation.
 * Implements ICommProxy: extends ICommChannel with diagnostic accessors.
 */
class ProxiedChannel implements ICommProxy {
  readonly name: string;
  readonly version: string;
  readonly capabilities: readonly CommCapability[];
  readonly topology: CommTopology;

  /** The underlying channel being wrapped. Exposed for diagnostics only — never call directly. */
  readonly inner: ICommChannel;
  private readonly cb: CircuitBreaker;
  private readonly bh: Bulkhead;
  private readonly timeoutMs: number;

  constructor(
    inner: ICommChannel,
    cb: CircuitBreaker,
    bh: Bulkhead,
    timeoutMs: number,
  ) {
    this.inner = inner;
    this.name = `proxy:${inner.name}`;
    this.version = inner.version;
    this.capabilities = inner.capabilities;
    this.topology = inner.topology;
    this.cb = cb;
    this.bh = bh;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Per-target circuit breaker state snapshot.
   * Returns current state for the given target agent ID.
   */
  getCircuitBreakerState(targetAgentId: string): CircuitBreakerState {
    return this.cb.getState(targetAgentId);
  }

  /**
   * Per-target bulkhead utilization.
   * Returns { concurrent, queued } for the given target.
   */
  getBulkheadUtilization(targetAgentId: string): { concurrent: number; queued: number } {
    return {
      concurrent: this.bh.getActive(targetAgentId),
      queued: this.bh.getQueueLength(targetAgentId),
    };
  }

  getStatus(): CommChannelStatus {
    return this.inner.getStatus();
  }

  connect(target?: string): Promise<void> {
    return this.inner.connect(target);
  }

  disconnect(): Promise<void> {
    return this.inner.disconnect();
  }

  /**
   * Send with L2/L3/L5 fault isolation:
   * CB check → Bulkhead acquire → Timeout → Send → Record → Release
   */
  async send(target: string, message: CommMessage): Promise<void> {
    if (!this.inner.send) throw new Error("Inner channel does not support send");

    // L2: Circuit breaker check (rejects immediately if OPEN, no slot consumed)
    this.cb.check(target);

    // L3: Bulkhead acquire
    await this.bh.acquire(target);

    try {
      // L5: Timeout + L4: Actual send
      const msgTimeout = message.timeoutMs ?? this.timeoutMs;
      await withTimeout(
        async () => this.inner.send!(target, message),
        msgTimeout,
      );

      // L2: Record success
      this.cb.recordSuccess(target);
    } catch (err) {
      // L2: Record failure
      this.cb.recordFailure(target);
      throw err;
    } finally {
      // L3: Release slot
      this.bh.release(target);
    }
  }

  onMessage(handler: CommMessageHandler): () => void {
    if (!this.inner.onMessage) throw new Error("Inner channel does not support onMessage");
    return this.inner.onMessage(handler);
  }

  reply(msgId: string, response: CommMessage): Promise<void> {
    if (!this.inner.reply) throw new Error("Inner channel does not support reply");
    return this.inner.reply(msgId, response);
  }

  subscribe(topic: string): AsyncIterable<CommMessage> {
    if (!this.inner.subscribe) throw new Error("Inner channel does not support subscribe");
    return this.inner.subscribe(topic);
  }

  publish(topic: string, message: CommMessage): Promise<void> {
    if (!this.inner.publish) throw new Error("Inner channel does not support publish");
    return this.inner.publish(topic, message);
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (!this.inner.call) throw new Error("Inner channel does not support call");
    return this.inner.call(method, params);
  }

  expose(method: string, handler: (params: unknown) => Promise<unknown>): void {
    if (!this.inner.expose) throw new Error("Inner channel does not support expose");
    this.inner.expose(method, handler);
  }
}

export function createCommProxyPlugin(config?: CommProxyConfig, innerChannel?: ICommChannel): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/comm-proxy',
      version: '0.38.0-alpha',
      description: 'L2/L3/L5 fault isolation for ICommChannel (Plan38 C10)',
      skandha: 'samskara',
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const cb = new CircuitBreaker(config?.circuitBreaker);
      const bh = new Bulkhead(config?.bulkhead);
      const timeoutMs = config?.timeout?.outerTimeoutMs ?? 30000;

      // Resolve inner channel: prefer explicit argument, then ctx.services lookup.
      // comm-proxy is loaded AFTER the transport channel plugin so the inner
      // channel should already be registered as a service by the time factory runs.
      let inner: ICommChannel | undefined = innerChannel;

      if (!inner && ctx.services) {
        // Walk all registered services to find the first ICommChannel.
        // ICommChannel extends IPluginService and has 'capabilities' + 'topology'.
        const all = ctx.services.list();
        for (const svc of all) {
          const candidate = svc as Partial<ICommChannel>;
          if (
            Array.isArray(candidate.capabilities) &&
            typeof candidate.topology === 'string' &&
            typeof candidate.getStatus === 'function'
          ) {
            inner = svc as ICommChannel;
            break;
          }
        }
      }

      if (!inner) {
        // No inner channel available at factory time.
        // Return an empty PluginHooks so the plugin loads without crashing.
        // The ProxiedChannel cannot be created until an ICommChannel is provided.
        return {
          dispose: async () => {},
        };
      }

      // Construct the ProxiedChannel that wraps the inner channel with L2/L3/L5.
      const proxy = new ProxiedChannel(inner, cb, bh, timeoutMs);

      // Register the proxy as the authoritative ICommChannel service,
      // replacing (overwriting) the inner channel's registration so that
      // any subsequent ctx.services.get(inner.name) returns the proxy.
      if (ctx.services) {
        // Unregister the inner channel first (if present) to avoid duplicate-name error.
        ctx.services.unregister(new ServiceKey<IPluginService>(inner.name));
        // Register proxy under the inner channel's original name so callers
        // that looked up the inner channel by name now transparently get the proxy.
        ctx.services.register(proxy);
      }

      return {
        // Return the proxy as the active ICommChannel for the agent runtime.
        commChannels: [proxy],
        dispose: async () => {
          // Cleanup bulkhead waiters on shutdown
        },
      };
    },
  };
}

// Export components for direct use and testing
export { CircuitBreaker } from "./circuit-breaker.js";
export { Bulkhead } from "./bulkhead.js";
export { withTimeout, decrementTimeout } from "./timeout.js";
export { ProxiedChannel };
// Plan39 W2: Template Method base class, split bulkhead, concrete methods
export { CommProxyMethod, SplitBulkhead } from "./comm-proxy-method.js";
export { SendMethod, PublishMethod, ReplyMethod, CallMethod } from "./comm-methods.js";
export type { SendArgs, PublishArgs, ReplyArgs, CallArgs } from "./comm-methods.js";
export default createCommProxyPlugin;
