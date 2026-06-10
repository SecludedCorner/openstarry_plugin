import { describe, it, expect, vi } from "vitest";
import { createModelSelectorPlugin } from "./index.js";
import type {
  IPluginContext,
  ISessionManager,
  ISession,
  ICognitionConfigService,
  IServiceRegistry,
  IPluginService,
} from "@openstarry/sdk";

function createMockSession(id: string): ISession {
  return {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {},
  };
}

let sessionCounter = 0;

function createMockSessionManager(): ISessionManager & { _sessions: Map<string, ISession> } {
  const sessions = new Map<string, ISession>();
  const defaultSession = createMockSession("default");
  return {
    _sessions: sessions,
    create(metadata?: Record<string, unknown>): ISession {
      const s = createMockSession(`session-${++sessionCounter}`);
      if (metadata) s.metadata = metadata;
      sessions.set(s.id, s);
      return s;
    },
    get(id: string): ISession | undefined {
      return sessions.get(id);
    },
    list(): ISession[] {
      return Array.from(sessions.values());
    },
    destroy(id: string): boolean {
      return sessions.delete(id);
    },
    getStateManager() {
      return { getMessages: () => [], addMessage: () => {}, clear: () => {}, snapshot: () => [], restore: () => {} };
    },
    getDefaultSession(): ISession {
      return defaultSession;
    },
  };
}

function createMockServiceRegistry(): IServiceRegistry {
  const services = new Map<string, IPluginService>();
  return {
    register<T extends IPluginService>(svc: T): void {
      services.set(svc.name, svc);
    },
    get<T extends IPluginService>(name: string): T | undefined {
      return services.get(name) as T | undefined;
    },
    has(name: string): boolean {
      return services.has(name);
    },
    list(): IPluginService[] {
      return Array.from(services.values());
    },
  };
}

function createMockPluginContext(overrides?: Partial<IPluginContext>): IPluginContext {
  const sessionManager = createMockSessionManager();
  const serviceRegistry = createMockServiceRegistry();
  return {
    bus: {
      emit: vi.fn(),
      on: vi.fn(() => () => {}),
      once: vi.fn(() => () => {}),
      onAny: vi.fn(() => () => {}),
    },
    workingDirectory: "/test",
    agentId: "test-agent",
    config: {},
    pushInput: vi.fn(),
    sessions: sessionManager,
    services: serviceRegistry,
    providers: {
      list: () => [],
      get: () => undefined,
    },
    ...overrides,
  };
}

describe("standard-model-selector per-session", () => {
  it("registers cognition-config service on factory()", async () => {
    const ctx = createMockPluginContext();
    const plugin = createModelSelectorPlugin();
    await plugin.factory(ctx);

    expect(ctx.services!.has("cognition-config")).toBe(true);
  });

  it("setModel/getModel works globally (no sessionId)", async () => {
    const ctx = createMockPluginContext();
    const plugin = createModelSelectorPlugin();
    await plugin.factory(ctx);

    const svc = ctx.services!.get<ICognitionConfigService>("cognition-config")!;
    expect(svc.getModel()).toBeUndefined();

    svc.setModel("gemini-pro");
    expect(svc.getModel()).toBe("gemini-pro");
  });

  it("setModel with sessionId stores in session metadata", async () => {
    const ctx = createMockPluginContext();
    const plugin = createModelSelectorPlugin();
    await plugin.factory(ctx);

    const s1 = ctx.sessions.create();
    const svc = ctx.services!.get<ICognitionConfigService>("cognition-config")!;

    svc.setModel("claude-3", s1.id);
    expect(svc.getModel(s1.id)).toBe("claude-3");

    // Global should still be undefined
    expect(svc.getModel()).toBeUndefined();
  });

  it("session model takes priority over global model", async () => {
    const ctx = createMockPluginContext();
    const plugin = createModelSelectorPlugin();
    await plugin.factory(ctx);

    const s1 = ctx.sessions.create();
    const svc = ctx.services!.get<ICognitionConfigService>("cognition-config")!;

    svc.setModel("global-model");
    svc.setModel("session-model", s1.id);

    expect(svc.getModel(s1.id)).toBe("session-model");
    expect(svc.getModel()).toBe("global-model");
  });

  it("session without model falls back to global", async () => {
    const ctx = createMockPluginContext();
    const plugin = createModelSelectorPlugin();
    await plugin.factory(ctx);

    const s1 = ctx.sessions.create();
    const svc = ctx.services!.get<ICognitionConfigService>("cognition-config")!;

    svc.setModel("global-model");
    // s1 has no session-level model set
    expect(svc.getModel(s1.id)).toBe("global-model");
  });

  it("two sessions have independent models", async () => {
    const ctx = createMockPluginContext();
    const plugin = createModelSelectorPlugin();
    await plugin.factory(ctx);

    const s1 = ctx.sessions.create();
    const s2 = ctx.sessions.create();
    const svc = ctx.services!.get<ICognitionConfigService>("cognition-config")!;

    svc.setModel("model-for-s1", s1.id);
    svc.setModel("model-for-s2", s2.id);

    expect(svc.getModel(s1.id)).toBe("model-for-s1");
    expect(svc.getModel(s2.id)).toBe("model-for-s2");
  });

  it("setProvider/getProvider works per-session", async () => {
    const ctx = createMockPluginContext();
    const plugin = createModelSelectorPlugin();
    await plugin.factory(ctx);

    const s1 = ctx.sessions.create();
    const svc = ctx.services!.get<ICognitionConfigService>("cognition-config")!;

    svc.setProvider("openai", s1.id);
    svc.setProvider("gemini");

    expect(svc.getProvider(s1.id)).toBe("openai");
    expect(svc.getProvider()).toBe("gemini");
  });

  it("unknown sessionId falls back to global", async () => {
    const ctx = createMockPluginContext();
    const plugin = createModelSelectorPlugin();
    await plugin.factory(ctx);

    const svc = ctx.services!.get<ICognitionConfigService>("cognition-config")!;
    svc.setModel("global-model");

    // Non-existent session ID → falls back to global
    expect(svc.getModel("nonexistent-session")).toBe("global-model");
  });
});
