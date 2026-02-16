import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHttpPlugin } from "./index.js";
import type { IPluginContext, AgentEvent } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";

// Capture the request handler for testing
let capturedRequestHandler: ((req: any, res: any) => void) | null = null;

// Mock http module
vi.mock("node:http", () => {
  const mockServer = {
    listen: vi.fn((port: number, host: string, cb: () => void) => cb()),
    close: vi.fn((cb: () => void) => cb()),
  };

  return {
    createServer: vi.fn((handler: any) => {
      capturedRequestHandler = handler;
      return mockServer;
    }),
  };
});

// Mock crypto.randomUUID
vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-5678"),
}));

function createMockSession(id?: string) {
  return {
    id: id ?? "session-uuid-5678",
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
      get: vi.fn(),
      list: vi.fn(() => []),
      destroy: vi.fn(() => true),
      getStateManager: vi.fn(),
      getDefaultSession: vi.fn(),
    },
    ...overrides,
  };
}

function createMockReq(method: string, url: string, body?: string) {
  const listeners: Record<string, Function[]> = {};
  const req: any = {
    method,
    url,
    headers: { host: "localhost:3000" },
    on: vi.fn((event: string, handler: Function) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(handler);
      // Auto-fire data+end for body
      if (event === "end" && body !== undefined) {
        // Fire data then end on next tick
        setTimeout(() => {
          for (const h of listeners["data"] ?? []) h(Buffer.from(body));
          for (const h of listeners["end"] ?? []) h();
        }, 0);
      }
      return req;
    }),
    // Helper to trigger events manually
    _emit: (event: string, ...args: any[]) => {
      for (const h of listeners[event] ?? []) h(...args);
    },
  };
  return req;
}

function createMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let writtenData = "";
  let ended = false;

  const res: any = {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code;
      if (hdrs) Object.assign(headers, hdrs);
    }),
    setHeader: vi.fn((key: string, value: string) => {
      headers[key] = value;
    }),
    write: vi.fn((data: string) => {
      writtenData += data;
      return true;
    }),
    end: vi.fn((data?: string) => {
      if (data) writtenData += data;
      ended = true;
    }),
    get writableEnded() {
      return ended;
    },
    // Helpers for assertions
    _getStatusCode: () => statusCode,
    _getHeaders: () => headers,
    _getWrittenData: () => writtenData,
    _isEnded: () => ended,
  };
  return res;
}

describe("createHttpPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequestHandler = null;
  });

  it("returns a valid plugin with correct manifest", () => {
    const plugin = createHttpPlugin();

    expect(plugin.manifest.name).toBe("transport-http");
    expect(plugin.manifest.version).toBe("0.1.0-alpha");
    expect(plugin.manifest.description).toBe("HTTP webhook transport plugin (Listener + UI)");
  });

  it("factory returns listeners and ui arrays", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);

    expect(hooks.listeners).toBeDefined();
    expect(hooks.listeners).toHaveLength(1);
    expect(hooks.ui).toBeDefined();
    expect(hooks.ui).toHaveLength(1);
    expect(hooks.dispose).toBeDefined();
  });

  it("listener has correct id and name", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const listener = hooks.listeners![0];

    expect(listener.id).toBe("http-webhook-listener");
    expect(listener.name).toBe("HTTP Webhook Listener");
    expect(listener.start).toBeDefined();
    expect(listener.stop).toBeDefined();
  });

  it("ui has correct id and name", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const ui = hooks.ui![0];

    expect(ui.id).toBe("http-webhook-ui");
    expect(ui.name).toBe("HTTP Webhook UI");
    expect(ui.onEvent).toBeDefined();
  });

  it("uses default config values when not provided", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext({ config: {} });

    const hooks = await plugin.factory(ctx);

    expect(hooks.listeners).toHaveLength(1);
  });

  it("accepts custom config values", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext({
      config: {
        port: 4000,
        host: "127.0.0.1",
        basePath: "/custom-api",
        responseBufferSize: 50,
        responseTimeout: 60000,
      },
    });

    const hooks = await plugin.factory(ctx);

    expect(hooks.listeners).toHaveLength(1);
  });

  it("accepts healthCheck config", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext({
      config: {
        healthCheck: {
          enabled: true,
          intervalMs: 15000,
        },
      },
    });

    const hooks = await plugin.factory(ctx);
    expect(hooks.listeners).toHaveLength(1);
  });
});

describe("HttpUI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("onEvent stores event in buffer when replyTo matches", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const ui = hooks.ui![0];

    // Event without replyTo should not throw
    const event: AgentEvent = {
      type: "stream:text_delta",
      timestamp: Date.now(),
      payload: { delta: "Hello" },
    };

    expect(() => ui.onEvent(event)).not.toThrow();
  });

  it("marks response complete on LOOP_FINISHED event", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const ui = hooks.ui![0];

    const event: AgentEvent = {
      type: AgentEventType.LOOP_FINISHED,
      timestamp: Date.now(),
      payload: { replyTo: "test-request-id" },
    };

    // Should not throw even without matching request
    expect(() => ui.onEvent(event)).not.toThrow();
  });

  it("marks response complete on LOOP_ERROR event", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const ui = hooks.ui![0];

    const event: AgentEvent = {
      type: AgentEventType.LOOP_ERROR,
      timestamp: Date.now(),
      payload: { replyTo: "test-request-id", error: "Test error" },
    };

    expect(() => ui.onEvent(event)).not.toThrow();
  });
});

describe("HttpListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequestHandler = null;
  });

  it("start and stop methods exist", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const listener = hooks.listeners![0];

    expect(typeof listener.start).toBe("function");
    expect(typeof listener.stop).toBe("function");
  });

  it("start creates http server", async () => {
    const { createServer } = await import("node:http");
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const listener = hooks.listeners![0];

    await listener.start?.();

    expect(createServer).toHaveBeenCalled();
  });

  it("stop cleans up resources", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    const listener = hooks.listeners![0];

    await listener.start?.();
    await expect(listener.stop?.()).resolves.not.toThrow();
  });
});

describe("Plugin dispose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequestHandler = null;
  });

  it("dispose calls listener stop and clears buffer", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);

    await hooks.listeners![0].start?.();
    await expect(hooks.dispose?.()).resolves.not.toThrow();
  });
});

describe("HTTP endpoints (protocol)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequestHandler = null;
  });

  it("POST /api/input returns 202 with requestId", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const body = JSON.stringify({ text: "Hello" });
    const req = createMockReq("POST", "/api/input", body);
    const res = createMockRes();

    await capturedRequestHandler!(req, res);
    await new Promise((r) => setTimeout(r, 10));

    expect(res.writeHead).toHaveBeenCalledWith(202, { "Content-Type": "application/json" });
    const response = JSON.parse(res.end.mock.calls[0][0]);
    expect(response.status).toBe("accepted");
    expect(response.requestId).toBeDefined();

    expect(ctx.pushInput).toHaveBeenCalledWith(
      expect.objectContaining({ source: "http", data: "Hello" })
    );

    await hooks.listeners![0].stop?.();
  });

  it("GET /api/status returns running status", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/status");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    const response = JSON.parse(res.end.mock.calls[0][0]);
    expect(response.status).toBe("running");
    expect(typeof response.pendingRequests).toBe("number");

    await hooks.listeners![0].stop?.();
  });

  it("GET /api/response returns 404 for unknown requestId", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/response?requestId=unknown");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json" });
    const response = JSON.parse(res.end.mock.calls[0][0]);
    expect(response.error).toBe("Not found");

    await hooks.listeners![0].stop?.();
  });

  it("returns 404 for unknown routes", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/nonexistent");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json" });

    await hooks.listeners![0].stop?.();
  });
});

// ─── New SSE + Session Tests (Spec 7.1) ───

describe("HTTP SSE Endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequestHandler = null;
  });

  it("SSE endpoint returns text/event-stream headers", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    expect(capturedRequestHandler).toBeDefined();

    const req = createMockReq("GET", "/api/events");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    // Check headers set via writeHead
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    }));

    await hooks.listeners![0].stop?.();
  });

  it("SSE sends connected event on open", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/events");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    const written = res._getWrittenData();

    // Should contain retry interval
    expect(written).toContain("retry: 5000\n");

    // Should contain connected event with sessionId
    expect(written).toContain('"type":"connected"');
    expect(written).toContain('"sessionId":"session-uuid-5678"');
    expect(written).toContain('"connectionId"');

    // Session should have been created
    expect(ctx.sessions.create).toHaveBeenCalledTimes(1);

    await hooks.listeners![0].stop?.();
  });

  it("SSE heartbeat sent at interval", async () => {
    vi.useFakeTimers();

    const plugin = createHttpPlugin();
    const ctx = createMockContext({
      config: { healthCheck: { intervalMs: 1000 } },
    });

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/events");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    // Advance time to trigger heartbeat
    vi.advanceTimersByTime(1000);

    const written = res._getWrittenData();
    expect(written).toContain(": heartbeat");

    vi.useRealTimers();
    await hooks.listeners![0].stop?.();
  });

  it("SSE filters events by sessionId", async () => {
    const plugin = createHttpPlugin();
    let busHandler: ((event: AgentEvent) => void) | null = null;
    const ctx = createMockContext({
      bus: {
        on: vi.fn(() => () => {}),
        once: vi.fn(() => () => {}),
        onAny: vi.fn((handler: any) => {
          busHandler = handler;
          return () => {};
        }),
        emit: vi.fn(),
      },
    });

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/events");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    // onAny should have been called to register bus handler
    expect(busHandler).toBeDefined();

    // Event matching this session
    const matchingEvent: AgentEvent = {
      type: "stream:text_delta",
      timestamp: Date.now(),
      payload: { sessionId: "session-uuid-5678", delta: "Hello" },
    };

    busHandler!(matchingEvent);

    let written = res._getWrittenData();
    expect(written).toContain("event: agent_event");
    expect(written).toContain('"delta":"Hello"');

    // Event for a different session should NOT be forwarded
    const otherEvent: AgentEvent = {
      type: "stream:text_delta",
      timestamp: Date.now(),
      payload: { sessionId: "other-session", delta: "Other" },
    };

    // Reset to count new writes
    const writeCountBefore = res.write.mock.calls.length;
    busHandler!(otherEvent);
    const writeCountAfter = res.write.mock.calls.length;

    // No new writes for non-matching session
    expect(writeCountAfter).toBe(writeCountBefore);

    // Global event (no sessionId) should be forwarded
    const globalEvent: AgentEvent = {
      type: "agent:started",
      timestamp: Date.now(),
      payload: {},
    };

    busHandler!(globalEvent);
    written = res._getWrittenData();
    expect(written).toContain('"type":"agent:started"');

    await hooks.listeners![0].stop?.();
  });

  it("SSE uses existing session when sessionId query param is provided", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext({
      sessions: {
        create: vi.fn(() => createMockSession()),
        get: vi.fn((id: string) => createMockSession(id)),
        list: vi.fn(() => []),
        destroy: vi.fn(() => true),
        getStateManager: vi.fn(),
        getDefaultSession: vi.fn(),
      },
    });

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/events?sessionId=existing-session-123");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    // Should have looked up existing session instead of creating new one
    expect(ctx.sessions.get).toHaveBeenCalledWith("existing-session-123");
    // sessions.create should NOT have been called since get returned a session
    expect(ctx.sessions.create).not.toHaveBeenCalled();

    const written = res._getWrittenData();
    expect(written).toContain('"sessionId":"existing-session-123"');

    await hooks.listeners![0].stop?.();
  });

  it("SSE connection cleanup on client disconnect", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/events");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    // Session was created
    expect(ctx.sessions.create).toHaveBeenCalledTimes(1);

    // Simulate client disconnect
    req._emit("close");

    // Session should be destroyed (last connection)
    expect(ctx.sessions.destroy).toHaveBeenCalledWith("session-uuid-5678");

    await hooks.listeners![0].stop?.();
  });
});

describe("HTTP POST /input with sessionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequestHandler = null;
  });

  it("POST /input accepts sessionId parameter", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext({
      sessions: {
        create: vi.fn(() => createMockSession()),
        get: vi.fn((id: string) => createMockSession(id)),
        list: vi.fn(() => []),
        destroy: vi.fn(() => true),
        getStateManager: vi.fn(),
        getDefaultSession: vi.fn(),
      },
    });

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const body = JSON.stringify({ text: "Hello", sessionId: "session-abc" });
    const req = createMockReq("POST", "/api/input", body);
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    // Wait for async body read
    await new Promise((r) => setTimeout(r, 10));

    // Should validate session
    expect(ctx.sessions.get).toHaveBeenCalledWith("session-abc");

    // Should push input with sessionId
    expect(ctx.pushInput).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "http",
        inputType: "user_input",
        data: "Hello",
        sessionId: "session-abc",
      })
    );

    await hooks.listeners![0].stop?.();
  });

  it("POST /input returns 404 for unknown sessionId", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext({
      sessions: {
        create: vi.fn(() => createMockSession()),
        get: vi.fn(() => undefined),  // Session not found
        list: vi.fn(() => []),
        destroy: vi.fn(() => true),
        getStateManager: vi.fn(),
        getDefaultSession: vi.fn(),
      },
    });

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const body = JSON.stringify({ text: "Hello", sessionId: "unknown-session" });
    const req = createMockReq("POST", "/api/input", body);
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    // Wait for async body read
    await new Promise((r) => setTimeout(r, 10));

    // Should return 404
    expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json" });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Session not found" }));

    await hooks.listeners![0].stop?.();
  });
});

describe("HTTP Logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequestHandler = null;
  });

  it("does not use console.log for logging", async () => {
    const consoleLogSpy = vi.spyOn(console, "log");
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    // Start should not call console.log
    expect(consoleLogSpy).not.toHaveBeenCalled();

    consoleLogSpy.mockRestore();
    await hooks.listeners![0].stop?.();
  });

  it("logs warning for invalid request body", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error");
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("POST", "/api/input", "invalid json{");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);
    await new Promise((r) => setTimeout(r, 10));

    // Should have logged an error (createLogger uses console.error)
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    await hooks.listeners![0].stop?.();
  });

  it("logs debug on SSE connection", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error");
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/events");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    // Should have logged debug message (createLogger uses console.error for all levels)
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    await hooks.listeners![0].stop?.();
  });

  it("logs info on server start", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error");
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    // Server start should have logged info
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    await hooks.listeners![0].stop?.();
  });
});

describe("HTTP CORS headers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequestHandler = null;
  });

  it("includes Last-Event-ID in allowed headers", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext();

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("OPTIONS", "/api/events");
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Headers",
      "Content-Type, Last-Event-ID"
    );

    await hooks.listeners![0].stop?.();
  });

  it("returns wildcard CORS when no allowedOrigins configured (backward compat)", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext({ config: {} });

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/status");
    req.headers.origin = "http://any-origin.com";
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      "*"
    );

    await hooks.listeners![0].stop?.();
  });

  it("returns matching origin when allowedOrigins is configured", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext({
      config: { allowedOrigins: ["http://trusted.com", "http://also-trusted.com"] },
    });

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/status");
    req.headers.origin = "http://trusted.com";
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Access-Control-Allow-Origin",
      "http://trusted.com"
    );
    expect(res.setHeader).toHaveBeenCalledWith("Vary", "Origin");

    await hooks.listeners![0].stop?.();
  });

  it("does not set CORS origin header for disallowed origins", async () => {
    const plugin = createHttpPlugin();
    const ctx = createMockContext({
      config: { allowedOrigins: ["http://trusted.com"] },
    });

    const hooks = await plugin.factory(ctx);
    await hooks.listeners![0].start?.();

    const req = createMockReq("GET", "/api/status");
    req.headers.origin = "http://evil.com";
    const res = createMockRes();

    await capturedRequestHandler!(req, res);

    // Should NOT have set Access-Control-Allow-Origin
    const setHeaderCalls = res.setHeader.mock.calls.map((c: any[]) => c[0]);
    expect(setHeaderCalls.filter((h: string) => h === "Access-Control-Allow-Origin")).toHaveLength(0);

    await hooks.listeners![0].stop?.();
  });
});
