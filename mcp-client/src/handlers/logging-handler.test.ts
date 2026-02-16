import { describe, it, expect, vi, beforeEach } from "vitest";
import { LoggingHandler } from "./logging-handler.js";
import type { IPluginContext, EventBus } from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";
import type { McpLogMessage, McpLogLevel } from "@openstarry-plugin/mcp-common";

function makeMockCtx(): IPluginContext {
  return {
    bus: { on: vi.fn(), once: vi.fn(), onAny: vi.fn(), emit: vi.fn() } as unknown as EventBus,
    workingDirectory: "/tmp/test",
    agentId: "test-agent",
    config: {},
    pushInput: vi.fn(),
    sessions: {} as IPluginContext["sessions"],
  };
}

function makeLogMessage(level: McpLogLevel, data: unknown, overrides: Partial<McpLogMessage> = {}): McpLogMessage {
  return {
    level,
    data,
    ...overrides,
  };
}

describe("LoggingHandler", () => {
  let ctx: IPluginContext;
  let handler: LoggingHandler;

  beforeEach(() => {
    ctx = makeMockCtx();
    handler = new LoggingHandler(ctx, "test-server");
  });

  describe("MCP level mapping to OpenStarry levels", () => {
    it("should map debug to debug", () => {
      const message = makeLogMessage("debug", "Debug message");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SERVER_LOG,
          payload: expect.objectContaining({
            level: "debug",
          }),
        })
      );
    });

    it("should map info to info", () => {
      const message = makeLogMessage("info", "Info message");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SERVER_LOG,
          payload: expect.objectContaining({
            level: "info",
          }),
        })
      );
    });

    it("should map notice to info", () => {
      const message = makeLogMessage("notice", "Notice message");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SERVER_LOG,
          payload: expect.objectContaining({
            level: "notice",
          }),
        })
      );
    });

    it("should map warning to warn", () => {
      const message = makeLogMessage("warning", "Warning message");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SERVER_LOG,
          payload: expect.objectContaining({
            level: "warning",
          }),
        })
      );
    });

    it("should map error to error", () => {
      const message = makeLogMessage("error", "Error message");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SERVER_LOG,
          payload: expect.objectContaining({
            level: "error",
          }),
        })
      );
    });

    it("should map critical to error", () => {
      const message = makeLogMessage("critical", "Critical message");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SERVER_LOG,
          payload: expect.objectContaining({
            level: "critical",
          }),
        })
      );
    });

    it("should map alert to error", () => {
      const message = makeLogMessage("alert", "Alert message");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SERVER_LOG,
          payload: expect.objectContaining({
            level: "alert",
          }),
        })
      );
    });

    it("should map emergency to error", () => {
      const message = makeLogMessage("emergency", "Emergency message");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SERVER_LOG,
          payload: expect.objectContaining({
            level: "emergency",
          }),
        })
      );
    });
  });

  describe("rate limiting", () => {
    it("should allow up to 100 logs per second", () => {
      const message = makeLogMessage("info", "Test message");

      // First 100 logs should pass
      for (let i = 0; i < 100; i++) {
        handler.handleLogNotification(message);
      }

      expect(ctx.bus.emit).toHaveBeenCalledTimes(100);
    });

    it("should drop logs exceeding 100 per second", () => {
      const message = makeLogMessage("info", "Test message");

      // Send 150 logs
      for (let i = 0; i < 150; i++) {
        handler.handleLogNotification(message);
      }

      // Only 100 should be emitted
      expect(ctx.bus.emit).toHaveBeenCalledTimes(100);
    });

    it("should reset rate limit after 1 second", () => {
      const message = makeLogMessage("info", "Test message");
      const originalNow = Date.now;

      // Exhaust rate limit
      for (let i = 0; i < 100; i++) {
        handler.handleLogNotification(message);
      }

      // Next log should be dropped
      handler.handleLogNotification(message);
      expect(ctx.bus.emit).toHaveBeenCalledTimes(100);

      // Simulate 1 second passing
      Date.now = vi.fn(() => originalNow() + 1001);

      // Should work again after reset
      handler.handleLogNotification(message);
      expect(ctx.bus.emit).toHaveBeenCalledTimes(101);

      Date.now = originalNow;
    });

    it("should drop logs silently without error", () => {
      const message = makeLogMessage("info", "Test message");

      // Exhaust rate limit
      for (let i = 0; i < 100; i++) {
        handler.handleLogNotification(message);
      }

      // Should not throw when dropping
      expect(() => {
        for (let i = 0; i < 50; i++) {
          handler.handleLogNotification(message);
        }
      }).not.toThrow();
    });
  });

  describe("event emission", () => {
    it("should emit MCP_SERVER_LOG event", () => {
      const message = makeLogMessage("info", "Test data");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SERVER_LOG,
        })
      );
    });

    it("should include all log data in event payload", () => {
      const message = makeLogMessage("info", "Test data", {
        logger: "test-logger",
        timestamp: "2024-01-01T00:00:00Z",
      });

      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AgentEventType.MCP_SERVER_LOG,
          payload: {
            serverName: "test-server",
            level: "info",
            logger: "test-logger",
            data: "Test data",
          },
        })
      );
    });

    it("should use current timestamp if not provided", () => {
      const message = makeLogMessage("info", "Test data");
      const beforeTimestamp = Date.now();

      handler.handleLogNotification(message);

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

    it("should parse ISO timestamp if provided", () => {
      const message = makeLogMessage("info", "Test data", {
        timestamp: "2024-01-01T12:00:00Z",
      });

      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: new Date("2024-01-01T12:00:00Z").getTime(),
        })
      );
    });
  });

  describe("logger name handling", () => {
    it("should use provided logger name", () => {
      const message = makeLogMessage("info", "Test", {
        logger: "custom-logger",
      });

      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            logger: "custom-logger",
          }),
        })
      );
    });

    it("should use undefined as fallback when logger not provided", () => {
      const message = makeLogMessage("info", "Test");

      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            logger: undefined,
          }),
        })
      );
    });
  });

  describe("structured data handling", () => {
    it("should handle string data", () => {
      const message = makeLogMessage("info", "Simple string");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: "Simple string",
          }),
        })
      );
    });

    it("should handle object data", () => {
      const structuredData = { key: "value", count: 42 };
      const message = makeLogMessage("info", structuredData);

      handler.handleLogNotification(message);

      // Object data is JSON stringified then sanitized
      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: '{"key":"value","count":42}',
          }),
        })
      );
    });

    it("should handle array data", () => {
      const arrayData = ["item1", "item2", "item3"];
      const message = makeLogMessage("info", arrayData);

      handler.handleLogNotification(message);

      // Array data is JSON stringified then sanitized
      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: '["item1","item2","item3"]',
          }),
        })
      );
    });

    it("should handle nested object data", () => {
      const nestedData = {
        outer: {
          inner: {
            value: "deeply nested",
          },
        },
      };
      const message = makeLogMessage("info", nestedData);

      handler.handleLogNotification(message);

      // Nested object is JSON stringified then sanitized
      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: '{"outer":{"inner":{"value":"deeply nested"}}}',
          }),
        })
      );
    });
  });

  describe("server name tracking", () => {
    it("should include server name in all events", () => {
      const message = makeLogMessage("info", "Test");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            serverName: "test-server",
          }),
        })
      );
    });

    it("should track different server names correctly", () => {
      const handler1 = new LoggingHandler(ctx, "server-1");
      const handler2 = new LoggingHandler(ctx, "server-2");
      const message = makeLogMessage("info", "Test");

      handler1.handleLogNotification(message);
      handler2.handleLogNotification(message);

      const emitCalls = (ctx.bus.emit as any).mock.calls;
      expect(emitCalls[0][0].payload.serverName).toBe("server-1");
      expect(emitCalls[1][0].payload.serverName).toBe("server-2");
    });
  });

  describe("log sanitization", () => {
    it("should strip ANSI escape sequences", () => {
      const message = makeLogMessage("info", "\x1b[31mRed\x1b[0m text with \x1b[1mbold\x1b[0m");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: "Red text with bold",
          }),
        })
      );
    });

    it("should remove control characters", () => {
      const message = makeLogMessage("info", "hello\x00\x01\x02world");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: "helloworld",
          }),
        })
      );
    });

    it("should normalize whitespace (tabs and newlines become spaces)", () => {
      const message = makeLogMessage("info", "line1\nline2\t\ttab\r\nmixed   spaces");
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: "line1 line2 tab mixed spaces",
          }),
        })
      );
    });

    it("should truncate long messages", () => {
      const longMessage = "A".repeat(3000);
      const message = makeLogMessage("info", longMessage);
      handler.handleLogNotification(message);

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: "A".repeat(2000) + "... (truncated)",
          }),
        })
      );
    });

    it("should preserve legitimate JSON", () => {
      const jsonData = { key: "value", count: 42 };
      const message = makeLogMessage("info", jsonData);
      handler.handleLogNotification(message);

      // JSON.stringify collapses to single line with spaces normalized
      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: '{"key":"value","count":42}',
          }),
        })
      );
    });

    it("should handle non-string data", () => {
      const objectData = { count: 42, message: "test" };
      const message = makeLogMessage("info", objectData);
      handler.handleLogNotification(message);

      // Should be JSON stringified then sanitized
      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            data: '{"count":42,"message":"test"}',
          }),
        })
      );
    });
  });
});
