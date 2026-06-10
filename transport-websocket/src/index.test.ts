import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWebSocketPlugin } from "./index.js";
import type { IPluginContext, AgentEvent } from "@openstarry/sdk";

// Track all created WSS instances for test assertions
const wssInstances: any[] = [];

// Mock WebSocketServer — use function keyword so it works as a constructor
vi.mock("ws", () => {
  return {
    WebSocketServer: function WebSocketServer(this: any) {
      this.on = vi.fn();
      this.close = vi.fn(function (cb: () => void) { cb(); });
      wssInstances.push(this);
    },
    WebSocket: {
      OPEN: 1,
      CLOSED: 3,
    },
  };
});

// Mock crypto.randomUUID — preserve the rest of node:crypto for Plan52
// Phase C dependencies (createHash / createHmac / timingSafeEqual).
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: vi.fn(() => "test-uuid-1234"),
  };
});

function createMockSession(id?: string) {
  return {
    id: id ?? "session-uuid-1234",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {},
  };
}

function createMockContext(overrides?: Partial<IPluginContext>): IPluginContext {
  return {
    bus: {
      on: vi.fn(() => () => {}),
      once: vi.fn(() => () => {}),
      onAny: vi.fn(() => () => {}),
      emit: vi.fn(),
    },
    workingDirectory: "/test",
    agentId: "test-agent",
    config: {},
    pushInput: vi.fn(),
    sessions: {
      create: vi.fn(() => createMockSession()),
      get: vi.fn((id: string) => createMockSession(id)),
      list: vi.fn(() => []),
      destroy: vi.fn(() => true),
      getStateManager: vi.fn(),
      getDefaultSession: vi.fn(),
    },
    ...overrides,
  };
}

/** Create a mock IncomingMessage (HTTP upgrade request) */
function createMockRequest(overrides?: Record<string, any>): any {
  return {
    url: "/ws",
    headers: {},
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
  };
}

/** Helper: start listener and simulate a connection, returning the mock client + wss */
async function startAndConnect(ctx: IPluginContext, reqOverrides?: Record<string, any>) {
  const plugin = createWebSocketPlugin();
  const hooks = await plugin.factory(ctx);
  const listener = hooks.listeners![0];
  await listener.start?.();

  const wss = wssInstances[wssInstances.length - 1];
  const connectionHandler = wss.on.mock.calls.find(
    (c: any[]) => c[0] === "connection"
  )?.[1];

  const mockClient: any = {
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn(),
    ping: vi.fn(),
    readyState: 1,
  };

  const mockReq = createMockRequest(reqOverrides);
  connectionHandler(mockClient, mockReq);

  return { hooks, listener, wss, mockClient, mockReq };
}

/** Helper: get a specific event handler from a mock ws client */
function getHandler(mockClient: any, event: string) {
  return mockClient.on.mock.calls.find((c: any[]) => c[0] === event)?.[1];
}

describe("createWebSocketPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wssInstances.length = 0;
  });

  it("returns a valid plugin with correct manifest", () => {
    const plugin = createWebSocketPlugin();

    expect(plugin.manifest.name).toBe("transport-websocket");
    expect(plugin.manifest.version).toBe("0.1.0-alpha");
    expect(plugin.manifest.description).toBe("WebSocket transport plugin (Listener + UI)");
  });

  it("factory returns listeners and ui arrays", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);

    expect(hooks.listeners).toBeDefined();
    expect(hooks.listeners).toHaveLength(1);
    expect(hooks.ui).toBeDefined();
    expect(hooks.ui).toHaveLength(1);
    expect(hooks.dispose).toBeDefined();
  });

  it("listener has correct id and name", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const listener = hooks.listeners![0];

    expect(listener.id).toBe("websocket-listener");
    expect(listener.name).toBe("WebSocket Listener");
    expect(listener.start).toBeDefined();
    expect(listener.stop).toBeDefined();
  });

  it("ui has correct id and name", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const ui = hooks.ui![0];

    expect(ui.id).toBe("websocket-ui");
    expect(ui.name).toBe("WebSocket UI");
    expect(ui.onEvent).toBeDefined();
  });

  it("uses default config values when not provided", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext({ config: {} });

    const hooks = await plugin.factory(ctx);

    expect(hooks.listeners).toHaveLength(1);
  });

  it("accepts custom config values", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext({
      config: {
        port: 9000,
        host: "127.0.0.1",
        path: "/custom-ws",
      },
    });

    const hooks = await plugin.factory(ctx);

    expect(hooks.listeners).toHaveLength(1);
  });

  it("accepts healthCheck config", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext({
      config: {
        healthCheck: {
          enabled: false,
          intervalMs: 10000,
          staleThreshold: 3,
        },
      },
    });

    const hooks = await plugin.factory(ctx);
    expect(hooks.listeners).toHaveLength(1);
  });
});

describe("WebSocketUI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wssInstances.length = 0;
  });

  it("onEvent serializes event to JSON format", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const ui = hooks.ui![0];

    const event: AgentEvent = {
      type: "stream:text_delta",
      timestamp: Date.now(),
      payload: { delta: "Hello" },
    };

    expect(() => ui.onEvent(event)).not.toThrow();
  });

  it("routes events by sessionId when replyTo does not match", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const ui = hooks.ui![0];

    const event: AgentEvent = {
      type: "stream:text_delta",
      timestamp: Date.now(),
      payload: { sessionId: "session-123", delta: "Hello" },
    };

    expect(() => ui.onEvent(event)).not.toThrow();
  });
});

describe("WebSocketListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wssInstances.length = 0;
  });

  it("start and stop methods exist", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const listener = hooks.listeners![0];

    expect(typeof listener.start).toBe("function");
    expect(typeof listener.stop).toBe("function");
  });

  it("stop cleans up resources", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const listener = hooks.listeners![0];

    await expect(listener.stop?.()).resolves.not.toThrow();
  });
});

describe("Plugin dispose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wssInstances.length = 0;
  });

  it("dispose calls listener stop", async () => {
    const plugin = createWebSocketPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);

    await expect(hooks.dispose?.()).resolves.not.toThrow();
  });
});

// ─── New Session + Health Check Tests (Spec 7.1) ───

describe("WebSocket Session Handshake", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wssInstances.length = 0;
  });

  it("new connection creates session via ctx.sessions.create()", async () => {
    const ctx = createMockContext();
    const { mockClient } = await startAndConnect(ctx);

    // Session should have been created
    expect(ctx.sessions.create).toHaveBeenCalledTimes(1);

    // Welcome message should include sessionId
    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const welcomeMsg = JSON.parse(mockClient.send.mock.calls[0][0]);
    expect(welcomeMsg.type).toBe("connected");
    expect(welcomeMsg.sessionId).toBe("session-uuid-1234");
    expect(welcomeMsg.clientId).toBeDefined();
  });

  it("pushInput includes sessionId from connection", async () => {
    const ctx = createMockContext();
    const { mockClient } = await startAndConnect(ctx);

    const messageHandler = getHandler(mockClient, "message");
    expect(messageHandler).toBeDefined();

    await messageHandler(JSON.stringify({ type: "user_input", payload: { text: "Hello" } }));

    expect(ctx.pushInput).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "websocket",
        inputType: "user_input",
        data: "Hello",
        sessionId: "session-uuid-1234",
      })
    );
  });
});

describe("WebSocket Protocol Ping/Pong", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wssInstances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pong handler marks connection as alive", async () => {
    const ctx = createMockContext({
      config: { healthCheck: { enabled: true, intervalMs: 1000 } },
    });
    const { listener, mockClient } = await startAndConnect(ctx);

    const pongHandler = getHandler(mockClient, "pong");
    expect(pongHandler).toBeDefined();

    // Advance time: alive=true -> alive=false, ping sent
    vi.advanceTimersByTime(1000);
    expect(mockClient.ping).toHaveBeenCalledTimes(1);

    // Simulate pong response -> alive=true
    pongHandler();

    // Advance again: alive=true -> alive=false, ping sent (not terminated)
    vi.advanceTimersByTime(1000);
    expect(mockClient.ping).toHaveBeenCalledTimes(2);
    expect(mockClient.terminate).not.toHaveBeenCalled();

    await listener.stop?.();
  });

  it("stale connections are terminated after staleThreshold missed pongs (default 2)", async () => {
    const ctx = createMockContext({
      config: { healthCheck: { enabled: true, intervalMs: 1000 } },
    });
    const { listener, mockClient } = await startAndConnect(ctx);

    // First ping: alive=true -> alive=false, missedPongs=0, ping
    vi.advanceTimersByTime(1000);
    expect(mockClient.ping).toHaveBeenCalledTimes(1);

    // No pong — missedPongs increments to 1 (below threshold 2)

    // Second ping: alive=false -> missedPongs=1, still below threshold, ping again
    vi.advanceTimersByTime(1000);
    expect(mockClient.ping).toHaveBeenCalledTimes(2);
    expect(mockClient.terminate).not.toHaveBeenCalled();

    // Third ping: alive=false -> missedPongs=2, reaches threshold -> terminate
    vi.advanceTimersByTime(1000);
    expect(mockClient.terminate).toHaveBeenCalledTimes(1);

    // Session should be destroyed
    expect(ctx.sessions.destroy).toHaveBeenCalledWith("session-uuid-1234");

    await listener.stop?.();
  });

  it("custom staleThreshold=1 terminates after first missed pong", async () => {
    const ctx = createMockContext({
      config: { healthCheck: { enabled: true, intervalMs: 1000, staleThreshold: 1 } },
    });
    const { listener, mockClient } = await startAndConnect(ctx);

    // First ping: alive=true -> alive=false, ping
    vi.advanceTimersByTime(1000);
    expect(mockClient.ping).toHaveBeenCalledTimes(1);

    // Second ping: alive=false, missedPongs=1 >= threshold=1 -> terminate
    vi.advanceTimersByTime(1000);
    expect(mockClient.terminate).toHaveBeenCalledTimes(1);

    await listener.stop?.();
  });

  it("missedPongs resets when pong is received", async () => {
    const ctx = createMockContext({
      config: { healthCheck: { enabled: true, intervalMs: 1000 } },
    });
    const { listener, mockClient } = await startAndConnect(ctx);

    const pongHandler = getHandler(mockClient, "pong");

    // First ping: alive=true -> alive=false
    vi.advanceTimersByTime(1000);
    expect(mockClient.ping).toHaveBeenCalledTimes(1);

    // No pong — missedPongs becomes 1

    // Second ping: missedPongs=1 (below 2), ping again
    vi.advanceTimersByTime(1000);
    expect(mockClient.ping).toHaveBeenCalledTimes(2);
    expect(mockClient.terminate).not.toHaveBeenCalled();

    // Now pong arrives — resets missedPongs
    pongHandler();

    // Third ping: alive=true -> missedPongs=0, alive=false, ping
    vi.advanceTimersByTime(1000);
    expect(mockClient.ping).toHaveBeenCalledTimes(3);
    expect(mockClient.terminate).not.toHaveBeenCalled();

    await listener.stop?.();
  });
});

describe("WebSocket Session Cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wssInstances.length = 0;
  });

  it("orphaned session destroyed on session resume", async () => {
    const ctx = createMockContext();
    const { hooks, listener, mockClient } = await startAndConnect(ctx);

    const messageHandler = getHandler(mockClient, "message");

    // Client sends a message with a different sessionId (session resume)
    messageHandler(JSON.stringify({
      type: "user_input",
      sessionId: "other-session-id",
      payload: { text: "Resuming" },
    }));

    // Old session should be destroyed (no other connections reference it)
    expect(ctx.sessions.destroy).toHaveBeenCalledWith("session-uuid-1234");

    await listener.stop?.();
  });

  it("session destroyed on last connection close", async () => {
    const ctx = createMockContext();
    const { listener, mockClient } = await startAndConnect(ctx);

    const closeHandler = getHandler(mockClient, "close");
    expect(closeHandler).toBeDefined();

    closeHandler();

    expect(ctx.sessions.destroy).toHaveBeenCalledWith("session-uuid-1234");

    await listener.stop?.();
  });
});

describe("WebSocket Logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wssInstances.length = 0;
  });

  it("does not use console.log for logging", async () => {
    const consoleLogSpy = vi.spyOn(console, "log");
    const ctx = createMockContext();
    const { listener } = await startAndConnect(ctx);

    // Start should not call console.log
    expect(consoleLogSpy).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
    await listener.stop?.();
  });
});

describe("WebSocket Session-Aware UI Routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wssInstances.length = 0;
  });

  it("sessionId event sent only to matching session connections", async () => {
    const ctx = createMockContext();
    const { hooks, mockClient } = await startAndConnect(ctx);
    const ui = hooks.ui![0];

    // mockClient has sessionId "session-uuid-1234" (from createMockSession)
    const event: AgentEvent = {
      type: "stream:text_delta",
      timestamp: Date.now(),
      payload: { sessionId: "session-uuid-1234", delta: "Hello" },
    };

    // Reset send count after welcome message
    mockClient.send.mockClear();
    ui.onEvent(event);

    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockClient.send.mock.calls[0][0]);
    expect(sent.type).toBe("agent_event");
    expect(sent.event.payload.delta).toBe("Hello");

    await hooks.listeners![0].stop?.();
  });

  it("event with non-matching sessionId is NOT sent to connection", async () => {
    const ctx = createMockContext();
    const { hooks, mockClient } = await startAndConnect(ctx);
    const ui = hooks.ui![0];

    const event: AgentEvent = {
      type: "stream:text_delta",
      timestamp: Date.now(),
      payload: { sessionId: "other-session", delta: "Nope" },
    };

    mockClient.send.mockClear();
    ui.onEvent(event);

    expect(mockClient.send).not.toHaveBeenCalled();

    await hooks.listeners![0].stop?.();
  });

  it("replyTo event sent only to targeted connection", async () => {
    const ctx = createMockContext();
    const { hooks, mockClient } = await startAndConnect(ctx);
    const ui = hooks.ui![0];

    // replyTo uses the clientId "ws-test-uuid-1234"
    const event: AgentEvent = {
      type: "stream:text_delta",
      timestamp: Date.now(),
      payload: { replyTo: "ws-test-uuid-1234", delta: "Direct" },
    };

    mockClient.send.mockClear();
    ui.onEvent(event);

    expect(mockClient.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockClient.send.mock.calls[0][0]);
    expect(sent.event.payload.delta).toBe("Direct");

    await hooks.listeners![0].stop?.();
  });

  it("global broadcast sent to all connections", async () => {
    const ctx = createMockContext();
    const { hooks, mockClient } = await startAndConnect(ctx);
    const ui = hooks.ui![0];

    const event: AgentEvent = {
      type: "agent:started",
      timestamp: Date.now(),
      payload: {},
    };

    mockClient.send.mockClear();
    ui.onEvent(event);

    expect(mockClient.send).toHaveBeenCalledTimes(1);

    await hooks.listeners![0].stop?.();
  });
});
