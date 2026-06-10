import { describe, it, expect } from "vitest";
import { createCommProxyPlugin, ProxiedChannel, CircuitBreaker, Bulkhead } from "../src/index.js";
import type { ICommChannel, ICommProxy, IPluginContext, CommMessage, CommCapability, CommTopology, CommChannelStatus } from "@openstarry/sdk";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Minimal mock ICommChannel for testing the decorator. */
class MockChannel implements ICommChannel {
  name = 'mock';
  version = '0.1.0';
  capabilities: readonly CommCapability[] = ['messaging'];
  topology: CommTopology = 'point-to-point';
  private status: CommChannelStatus = 'connected';
  sendCalls: Array<{ target: string; message: CommMessage }> = [];
  shouldFail = false;

  getStatus() { return this.status; }
  async connect() { this.status = 'connected'; }
  async disconnect() { this.status = 'disconnected'; }
  async send(target: string, message: CommMessage) {
    if (this.shouldFail) throw new Error("mock send failure");
    this.sendCalls.push({ target, message });
  }
  onMessage() { return () => {}; }
  async reply() {}
}

describe("comm-proxy Integration (Plan38 C10)", () => {
  it("plugin factory returns valid IPlugin structure", () => {
    const plugin = createCommProxyPlugin();
    expect(plugin.manifest.name).toBe("@openstarry-plugin/comm-proxy");
    expect(plugin.manifest.version).toBe("0.38.0-alpha");
    expect(plugin.manifest.skandha).toBe("samskara");
    expect(typeof plugin.factory).toBe("function");
  });

  it("ProxiedChannel delegates send to inner channel", async () => {
    const inner = new MockChannel();
    const cb = new CircuitBreaker();
    const bh = new Bulkhead();
    const proxy = new ProxiedChannel(inner, cb, bh, 30000);

    const msg: CommMessage = {
      id: "m1", source: "a", target: "b", payload: {}, timestamp: Date.now(),
    };
    await proxy.send("b", msg);
    expect(inner.sendCalls).toHaveLength(1);
    expect(inner.sendCalls[0].target).toBe("b");
  });

  it("ProxiedChannel opens circuit breaker on repeated failures", async () => {
    const inner = new MockChannel();
    inner.shouldFail = true;
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    const bh = new Bulkhead();
    const proxy = new ProxiedChannel(inner, cb, bh, 30000);

    const msg: CommMessage = {
      id: "m1", source: "a", target: "b", payload: {}, timestamp: Date.now(),
    };

    await expect(proxy.send("b", msg)).rejects.toThrow("mock send failure");
    await expect(proxy.send("b", msg)).rejects.toThrow("mock send failure");
    // Circuit now OPEN
    expect(cb.getState("b")).toBe("OPEN");
    await expect(proxy.send("b", msg)).rejects.toThrow(/Circuit breaker/);
  });

  it("CB-before-bulkhead: OPEN circuit doesn't consume bulkhead slot", async () => {
    const inner = new MockChannel();
    inner.shouldFail = true;
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    const bh = new Bulkhead({ maxConcurrent: 1 });
    const proxy = new ProxiedChannel(inner, cb, bh, 30000);

    const msg: CommMessage = {
      id: "m1", source: "a", target: "b", payload: {}, timestamp: Date.now(),
    };

    await expect(proxy.send("b", msg)).rejects.toThrow(); // Opens circuit
    // Now try again — CB should reject before bulkhead
    await expect(proxy.send("b", msg)).rejects.toThrow(/Circuit breaker/);
    expect(bh.getActive("b")).toBe(0); // No slot consumed
  });

  describe("ICommProxy interface", () => {
    it("ProxiedChannel satisfies ICommProxy: has inner, getCircuitBreakerState, getBulkheadUtilization", () => {
      const inner = new MockChannel();
      const cb = new CircuitBreaker();
      const bh = new Bulkhead();
      const proxy = new ProxiedChannel(inner, cb, bh, 30000);

      // ICommProxy contract
      expect(proxy.inner).toBe(inner);
      expect(typeof proxy.getCircuitBreakerState).toBe("function");
      expect(typeof proxy.getBulkheadUtilization).toBe("function");
    });

    it("getCircuitBreakerState returns CLOSED for a fresh target", () => {
      const proxy = new ProxiedChannel(new MockChannel(), new CircuitBreaker(), new Bulkhead(), 30000);
      expect(proxy.getCircuitBreakerState("agent-x")).toBe("CLOSED");
    });

    it("getCircuitBreakerState reflects actual CB state after failures", async () => {
      const inner = new MockChannel();
      inner.shouldFail = true;
      const cb = new CircuitBreaker({ failureThreshold: 2 });
      const proxy = new ProxiedChannel(inner, cb, new Bulkhead(), 30000);

      const msg: CommMessage = { id: "m1", source: "a", target: "b", payload: {}, timestamp: Date.now() };
      await expect(proxy.send("b", msg)).rejects.toThrow();
      await expect(proxy.send("b", msg)).rejects.toThrow();

      expect(proxy.getCircuitBreakerState("b")).toBe("OPEN");
    });

    it("getBulkheadUtilization returns {concurrent:0, queued:0} for idle target", () => {
      const proxy = new ProxiedChannel(new MockChannel(), new CircuitBreaker(), new Bulkhead(), 30000);
      const util = proxy.getBulkheadUtilization("agent-y");
      expect(util).toEqual({ concurrent: 0, queued: 0 });
    });

    it("getBulkheadUtilization tracks concurrent and queued accurately", async () => {
      /** SlowChannel holds the slot until explicitly released. */
      class SlowChannel implements ICommChannel {
        name = 'slow';
        version = '0.1.0';
        capabilities: readonly CommCapability[] = ['messaging'];
        topology: CommTopology = 'point-to-point';
        private _status: CommChannelStatus = 'connected';
        resolvers: Array<() => void> = [];
        getStatus() { return this._status; }
        async connect() {}
        async disconnect() {}
        async send(_target: string, _message: CommMessage) {
          await new Promise<void>(r => { this.resolvers.push(r); });
        }
        onMessage() { return () => {}; }
        async reply() {}
      }

      const inner = new SlowChannel();
      const bh = new Bulkhead({ maxConcurrent: 1, maxQueue: 2 });
      const proxy = new ProxiedChannel(inner, new CircuitBreaker(), bh, 30000);
      const msg: CommMessage = { id: "m1", source: "a", target: "t", payload: {}, timestamp: Date.now() };

      // Start first send (occupies the 1 concurrent slot)
      const first = proxy.send("t", msg);

      // Start second send (should queue)
      const second = proxy.send("t", msg);

      // Give microtasks a chance to settle
      await new Promise(r => setTimeout(r, 0));

      const util = proxy.getBulkheadUtilization("t");
      expect(util.concurrent).toBe(1);
      expect(util.queued).toBe(1);

      // Unblock first, then second
      inner.resolvers[0]();
      await first;
      await new Promise(r => setTimeout(r, 0));
      inner.resolvers[1]();
      await second;
    });

    it("inner field is readonly reference to original channel", () => {
      const innerChannel = new MockChannel();
      const proxy = new ProxiedChannel(innerChannel, new CircuitBreaker(), new Bulkhead(), 30000);
      // Type check: proxy satisfies ICommProxy
      const typed: ICommProxy = proxy;
      expect(typed.inner).toBe(innerChannel);
    });
  });

  describe("factory wiring (FAIL-2)", () => {
    /** Build a minimal IPluginContext stub for factory() testing. */
    function makeCtx(inner?: ICommChannel): IPluginContext {
      const services: Map<string, ICommChannel> = new Map();
      if (inner) services.set(inner.name, inner);
      const registry = {
        register(svc: ICommChannel) { services.set(svc.name, svc); },
        get(key: { name: string }) { return services.get(key.name); },
        has(key: { name: string }) { return services.has(key.name); },
        list() { return [...services.values()]; },
        unregister(key: { name: string }) { return services.delete(key.name); },
      };
      return {
        bus: {} as IPluginContext['bus'],
        workingDirectory: '/tmp',
        agentId: 'test-agent',
        config: {},
        pushInput: () => {},
        sessions: {} as IPluginContext['sessions'],
        services: registry as unknown as IPluginContext['services'],
      } as IPluginContext;
    }

    it("factory returns commChannels with ProxiedChannel when inner is provided directly", async () => {
      const inner = new MockChannel();
      const plugin = createCommProxyPlugin(undefined, inner);
      const ctx = makeCtx();
      const hooks = await plugin.factory(ctx);
      expect(hooks.commChannels).toBeDefined();
      expect(hooks.commChannels!).toHaveLength(1);
      const proxy = hooks.commChannels![0] as ICommProxy;
      expect(proxy.inner).toBe(inner);
      expect(typeof proxy.getCircuitBreakerState).toBe("function");
      expect(typeof proxy.getBulkheadUtilization).toBe("function");
    });

    it("factory returns commChannels with ProxiedChannel when inner is in ctx.services", async () => {
      const inner = new MockChannel();
      const plugin = createCommProxyPlugin();
      const ctx = makeCtx(inner);
      const hooks = await plugin.factory(ctx);
      expect(hooks.commChannels).toBeDefined();
      expect(hooks.commChannels!).toHaveLength(1);
      const proxy = hooks.commChannels![0] as ICommProxy;
      expect(proxy.inner).toBe(inner);
    });

    it("factory registers proxy back to ctx.services under the proxy name", async () => {
      const inner = new MockChannel();
      const plugin = createCommProxyPlugin(undefined, inner);
      // Use makeCtx with a pre-registered inner channel
      const ctx = makeCtx(inner);

      await plugin.factory(ctx);

      // After factory, services should have proxy (named 'proxy:mock') and inner removed
      expect(ctx.services!.has({ name: 'mock' } as any)).toBe(false);
      expect(ctx.services!.has({ name: 'proxy:mock' } as any)).toBe(true);
      const registered = ctx.services!.get({ name: 'proxy:mock' } as any) as ICommProxy;
      expect(registered!.inner).toBe(inner);
    });

    it("factory returns empty hooks (no crash) when no inner channel is available", async () => {
      const plugin = createCommProxyPlugin();
      const ctx = makeCtx(); // no inner channel
      const hooks = await plugin.factory(ctx);
      // No commChannels returned — graceful degradation
      expect(hooks.commChannels).toBeUndefined();
      expect(typeof hooks.dispose).toBe("function");
    });

    it("proxy.send applies L2/L3/L5 isolation when returned from factory", async () => {
      const inner = new MockChannel();
      const plugin = createCommProxyPlugin(undefined, inner);
      const ctx = makeCtx();
      const hooks = await plugin.factory(ctx);
      const proxy = hooks.commChannels![0];
      const msg: CommMessage = { id: "f1", source: "a", target: "b", payload: {}, timestamp: Date.now() };
      await proxy.send!("b", msg);
      expect(inner.sendCalls).toHaveLength(1);
    });
  });

  describe("microkernel purity", () => {
    it("plugin source has zero imports from @openstarry/core", () => {
      const srcDir = resolve(fileURLToPath(import.meta.url), "../../src");
      const files: string[] = [];
      function walk(dir: string) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name.endsWith('.ts')) files.push(p);
        }
      }
      walk(srcDir);
      for (const file of files) {
        const content = readFileSync(file, 'utf-8');
        expect(content).not.toMatch(/@openstarry\/core/);
      }
    });
  });
});
