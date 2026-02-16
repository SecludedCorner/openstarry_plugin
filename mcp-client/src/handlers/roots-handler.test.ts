import { describe, it, expect, vi, beforeEach } from "vitest";
import { RootsHandler } from "./roots-handler.js";
import type { IPluginContext, EventBus, ISessionManager, ISession } from "@openstarry/sdk";
import { AgentEventType, setSessionConfig } from "@openstarry/sdk";
import type { McpTransport } from "../transport/types.js";
import { pathToFileURL } from "node:url";

function makeMockCtx(workingDirectory = "/tmp/test"): IPluginContext {
  const sessions = new Map<string, ISession>();
  return {
    bus: { on: vi.fn(), once: vi.fn(), onAny: vi.fn(), emit: vi.fn() } as unknown as EventBus,
    workingDirectory,
    agentId: "test-agent",
    config: {},
    pushInput: vi.fn(),
    sessions: {
      create: (metadata = {}) => {
        const session: ISession = {
          id: `session-${sessions.size}`,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata,
        };
        sessions.set(session.id, session);
        return session;
      },
      get: (id: string) => sessions.get(id),
      list: () => Array.from(sessions.values()),
      destroy: (id: string) => sessions.delete(id),
      getStateManager: vi.fn() as any,
      getDefaultSession: vi.fn() as any,
    } as ISessionManager,
  };
}

function makeMockTransport(): McpTransport {
  return {
    connect: vi.fn(),
    send: vi.fn(),
    notify: vi.fn(),
    close: vi.fn(),
    onMessage: vi.fn(),
    onRequest: vi.fn(),
    onNotification: vi.fn(),
  };
}

describe("RootsHandler", () => {
  let ctx: IPluginContext;
  let handler: RootsHandler;

  beforeEach(() => {
    ctx = makeMockCtx();
    handler = new RootsHandler(ctx, "test-server");
  });

  describe("roots/list response", () => {
    it("should return workingDirectory as single root", async () => {
      const result = await handler.handleRootsListRequest();

      expect(result.roots).toHaveLength(1);
      expect(result.roots[0].uri).toBe(pathToFileURL("/tmp/test").href);
      expect(result.roots[0].name).toBe("test");
    });

    it("should convert path to file:// URI", async () => {
      const result = await handler.handleRootsListRequest();

      expect(result.roots[0].uri).toMatch(/^file:\/\//);
    });

    it("should use last segment as name", async () => {
      const ctx2 = makeMockCtx("/home/user/projects/myproject");
      const handler2 = new RootsHandler(ctx2, "test-server");

      const result = await handler2.handleRootsListRequest();

      expect(result.roots[0].name).toBe("myproject");
    });

    it("should use 'Root' as fallback name for empty segment", async () => {
      const ctx2 = makeMockCtx("/");
      const handler2 = new RootsHandler(ctx2, "test-server");

      const result = await handler2.handleRootsListRequest();

      expect(result.roots[0].name).toBe("Root");
    });
  });

  describe("event emission", () => {
    it("should emit MCP_ROOTS_REQUESTED event", async () => {
      await handler.handleRootsListRequest();

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_ROOTS_REQUESTED,
        })
      );
    });

    it("should include server name and root count in event", async () => {
      await handler.handleRootsListRequest();

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_ROOTS_REQUESTED,
          payload: {
            serverName: "test-server",
            rootCount: 1,
          },
        })
      );
    });

    it("should emit event with valid timestamp", async () => {
      const beforeTimestamp = Date.now();
      await handler.handleRootsListRequest();
      const afterTimestamp = Date.now();

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.any(Number),
        })
      );

      const emitCall = (ctx.bus.emit as any).mock.calls[0];
      expect(emitCall[0].timestamp).toBeGreaterThanOrEqual(beforeTimestamp);
      expect(emitCall[0].timestamp).toBeLessThanOrEqual(afterTimestamp);
    });
  });

  describe("URI formatting", () => {
    it("should handle Unix-style paths", async () => {
      const ctx2 = makeMockCtx("/home/user/workspace");
      const handler2 = new RootsHandler(ctx2, "test-server");

      const result = await handler2.handleRootsListRequest();

      expect(result.roots[0].uri).toBe(pathToFileURL("/home/user/workspace").href);
    });

    it("should handle relative-looking paths by normalizing", async () => {
      const ctx2 = makeMockCtx("/tmp/test/../final");
      const handler2 = new RootsHandler(ctx2, "test-server");

      const result = await handler2.handleRootsListRequest();

      expect(result.roots[0].uri).toContain("file://");
    });

    it("should handle paths with spaces", async () => {
      const ctx2 = makeMockCtx("/tmp/my project");
      const handler2 = new RootsHandler(ctx2, "test-server");

      const result = await handler2.handleRootsListRequest();

      expect(result.roots[0].uri).toBe(pathToFileURL("/tmp/my project").href);
    });

    it("should handle paths with special characters", async () => {
      const ctx2 = makeMockCtx("/tmp/test-project_123");
      const handler2 = new RootsHandler(ctx2, "test-server");

      const result = await handler2.handleRootsListRequest();

      expect(result.roots[0].uri).toBe(pathToFileURL("/tmp/test-project_123").href);
    });
  });

  describe("listChanged notification", () => {
    it("should set up event listener for session config updates", () => {
      const transport = makeMockTransport();
      handler.setupListChangedNotification(transport);

      expect(ctx.bus.on).toHaveBeenCalledWith(
        "session:config_updated",
        expect.any(Function)
      );
    });

    it("should send notification when session config updates", () => {
      const transport = makeMockTransport();
      handler.setupListChangedNotification(transport);

      // Get the registered callback
      const onCall = (ctx.bus.on as any).mock.calls.find(
        (call: any) => call[0] === "session:config_updated"
      );
      expect(onCall).toBeDefined();

      const callback = onCall[1];
      callback();

      expect(transport.notify).toHaveBeenCalledWith("notifications/roots/listChanged");
    });

    it("should emit MCP_ROOTS_CHANGED event when config updates", () => {
      const transport = makeMockTransport();
      handler.setupListChangedNotification(transport);

      // Trigger the callback
      const onCall = (ctx.bus.on as any).mock.calls.find(
        (call: any) => call[0] === "session:config_updated"
      );
      const callback = onCall[1];
      callback();

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_ROOTS_CHANGED,
        })
      );
    });

    it("should include session ID and root count in change event", () => {
      const transport = makeMockTransport();
      handler.setupListChangedNotification(transport);

      // Trigger the callback
      const onCall = (ctx.bus.on as any).mock.calls.find(
        (call: any) => call[0] === "session:config_updated"
      );
      const callback = onCall[1];
      callback();

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_ROOTS_CHANGED,
          payload: {
            sessionId: "default",
            rootCount: 1,
          },
        })
      );
    });
  });

  describe("server name tracking", () => {
    it("should include server name in roots requested event", async () => {
      await handler.handleRootsListRequest();

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            serverName: "test-server",
          }),
        })
      );
    });

    it("should track different server names correctly", async () => {
      const handler1 = new RootsHandler(ctx, "server-1");
      const handler2 = new RootsHandler(ctx, "server-2");

      await handler1.handleRootsListRequest();
      await handler2.handleRootsListRequest();

      const emitCalls = (ctx.bus.emit as any).mock.calls;
      expect(emitCalls[0][0].payload.serverName).toBe("server-1");
      expect(emitCalls[1][0].payload.serverName).toBe("server-2");
    });
  });

  describe("cross-platform support", () => {
    it("should handle forward slashes in paths", async () => {
      const ctx2 = makeMockCtx("/home/user/project");
      const handler2 = new RootsHandler(ctx2, "test-server");

      const result = await handler2.handleRootsListRequest();

      expect(result.roots[0].uri).toBe(pathToFileURL("/home/user/project").href);
    });

    it("should extract correct name from path with forward slashes", async () => {
      const ctx2 = makeMockCtx("/home/user/project");
      const handler2 = new RootsHandler(ctx2, "test-server");

      const result = await handler2.handleRootsListRequest();

      expect(result.roots[0].name).toBe("project");
    });

    it("should handle trailing slash in path", async () => {
      const ctx2 = makeMockCtx("/home/user/project/");
      const handler2 = new RootsHandler(ctx2, "test-server");

      const result = await handler2.handleRootsListRequest();

      // pathToFileURL normalizes this
      expect(result.roots[0].uri).toContain("file://");
    });
  });

  // ─── NEW TESTS: Session Config Integration ───

  describe("session config integration", () => {
    it("should expose session-level allowedPaths as roots", async () => {
      const metadata = {};
      setSessionConfig(metadata, { allowedPaths: ["/project/a", "/project/b"] });
      const session = ctx.sessions.create(metadata);
      const handler2 = new RootsHandler(ctx, "test-server");

      const result = await handler2.handleRootsListRequest(session.id);

      expect(result.roots).toHaveLength(2);
      expect(result.roots[0].uri).toBe(pathToFileURL("/project/a").href);
      expect(result.roots[0].name).toBe("a");
      expect(result.roots[1].uri).toBe(pathToFileURL("/project/b").href);
      expect(result.roots[1].name).toBe("b");
    });

    it("should fallback to workingDirectory if no session config", async () => {
      const handler2 = new RootsHandler(ctx, "test-server");

      const result = await handler2.handleRootsListRequest();

      expect(result.roots).toHaveLength(1);
      expect(result.roots[0].uri).toContain(ctx.workingDirectory);
    });

    it("should fallback to config.allowedPaths when no session", async () => {
      const ctx2 = makeMockCtx("/tmp/test");
      ctx2.config.allowedPaths = ["/config/path1", "/config/path2"];
      const handler2 = new RootsHandler(ctx2, "test-server");

      const result = await handler2.handleRootsListRequest();

      expect(result.roots).toHaveLength(2);
      expect(result.roots[0].uri).toBe(pathToFileURL("/config/path1").href);
      expect(result.roots[1].uri).toBe(pathToFileURL("/config/path2").href);
    });

    it("should prefer session config over agent config", async () => {
      ctx.config.allowedPaths = ["/agent/path"];
      const metadata = {};
      setSessionConfig(metadata, { allowedPaths: ["/session/path"] });
      const session = ctx.sessions.create(metadata);
      const handler2 = new RootsHandler(ctx, "test-server");

      const result = await handler2.handleRootsListRequest(session.id);

      expect(result.roots).toHaveLength(1);
      expect(result.roots[0].uri).toBe(pathToFileURL("/session/path").href);
    });

    it("should emit event with correct root count for multiple paths", async () => {
      const metadata = {};
      setSessionConfig(metadata, { allowedPaths: ["/a", "/b", "/c"] });
      const session = ctx.sessions.create(metadata);
      const handler2 = new RootsHandler(ctx, "test-server");

      await handler2.handleRootsListRequest(session.id);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_ROOTS_REQUESTED,
          payload: {
            serverName: "test-server",
            rootCount: 3,
          },
        })
      );
    });
  });
});
