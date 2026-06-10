import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { createMcpJsonRpcHandler } from "./handler.js";
import type { IPluginContext, ITool, IGuide, EventBus } from "@openstarry/sdk";
import type { McpServerConfig } from "./index.js";
import type { JsonRpcRequest } from "./transport/types.js";

function makeMockTool(id = "tool1", desc = "Tool 1"): ITool {
  return {
    id,
    description: desc,
    parameters: z.object({ input: z.string() }),
    execute: vi.fn().mockResolvedValue("tool result"),
  };
}

function makeMockGuide(id = "guide1", name = "Guide 1"): IGuide {
  return {
    id,
    name,
    getSystemPrompt: vi.fn().mockReturnValue("system prompt text"),
  };
}

function makeMockCtx(tools?: ITool[], guides?: IGuide[]): IPluginContext {
  return {
    bus: { on: vi.fn(), once: vi.fn(), onAny: vi.fn(), emit: vi.fn() } as unknown as EventBus,
    workingDirectory: "/tmp/test",
    agentId: "test-agent",
    config: {},
    pushInput: vi.fn(),
    sessions: {} as IPluginContext["sessions"],
    tools: tools
      ? {
          list: () => tools,
          get: (id: string) => tools.find((t) => t.id === id),
        }
      : undefined,
    guides: guides
      ? {
          list: () => guides,
        }
      : undefined,
  };
}

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "test-server",
    version: "1.0.0",
    transport: "stdio",
    exposedTools: "*",
    exposedGuides: "*",
    ...overrides,
  };
}

function makeReq(method: string, params?: Record<string, unknown>, id = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
}

describe("createMcpJsonRpcHandler", () => {
  let tools: ITool[];
  let guides: IGuide[];

  beforeEach(() => {
    tools = [makeMockTool("tool1"), makeMockTool("tool2", "Tool 2")];
    guides = [makeMockGuide("guide1"), makeMockGuide("guide2", "Guide 2")];
  });

  describe("initialize", () => {
    it("returns server info and capabilities", async () => {
      const handler = createMcpJsonRpcHandler(makeConfig(), makeMockCtx(tools, guides));
      const res = await handler(makeReq("initialize"));

      expect(res.result).toEqual({
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { listChanged: false },
        },
        serverInfo: {
          name: "test-server",
          version: "1.0.0",
        },
      });
    });

    it("uses custom server name and version", async () => {
      const handler = createMcpJsonRpcHandler(
        makeConfig({ name: "my-agent", version: "2.0.0" }),
        makeMockCtx(tools, guides),
      );
      const res = await handler(makeReq("initialize"));
      const result = res.result as Record<string, unknown>;
      const serverInfo = result.serverInfo as { name: string; version: string };
      expect(serverInfo.name).toBe("my-agent");
      expect(serverInfo.version).toBe("2.0.0");
    });
  });

  describe("notifications/initialized", () => {
    it("emits MCP_CLIENT_CONNECTED event", async () => {
      const ctx = makeMockCtx(tools, guides);
      const handler = createMcpJsonRpcHandler(makeConfig(), ctx);
      await handler(makeReq("notifications/initialized"));

      expect(ctx.bus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "mcp:client_connected",
          payload: expect.objectContaining({
            serverName: "test-server",
            transport: "stdio",
          }),
        }),
      );
    });
  });

  describe("tools/list", () => {
    it("lists all tools when exposedTools is *", async () => {
      const handler = createMcpJsonRpcHandler(makeConfig(), makeMockCtx(tools, guides));
      const res = await handler(makeReq("tools/list"));
      const result = res.result as { tools: Array<{ name: string }> };

      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe("tool1");
      expect(result.tools[1].name).toBe("tool2");
    });

    it("filters tools by exposedTools whitelist", async () => {
      const handler = createMcpJsonRpcHandler(
        makeConfig({ exposedTools: ["tool1"] }),
        makeMockCtx(tools, guides),
      );
      const res = await handler(makeReq("tools/list"));
      const result = res.result as { tools: Array<{ name: string }> };

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe("tool1");
    });

    it("returns error when tools not available", async () => {
      const handler = createMcpJsonRpcHandler(makeConfig(), makeMockCtx(undefined, guides));
      const res = await handler(makeReq("tools/list"));

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32600);
    });
  });

  describe("tools/call", () => {
    it("executes tool and returns result", async () => {
      const handler = createMcpJsonRpcHandler(makeConfig(), makeMockCtx(tools, guides));
      const res = await handler(
        makeReq("tools/call", { name: "tool1", arguments: { input: "hello" } }),
      );
      const result = res.result as { content: Array<{ type: string; text: string }>; isError: boolean };

      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe("tool result");
    });

    it("returns error for unknown tool", async () => {
      const handler = createMcpJsonRpcHandler(makeConfig(), makeMockCtx(tools, guides));
      const res = await handler(
        makeReq("tools/call", { name: "nonexistent", arguments: {} }),
      );

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32602);
      expect(res.error!.message).toContain("Tool not found");
    });

    it("returns error for unexposed tool", async () => {
      const handler = createMcpJsonRpcHandler(
        makeConfig({ exposedTools: ["tool1"] }),
        makeMockCtx(tools, guides),
      );
      const res = await handler(
        makeReq("tools/call", { name: "tool2", arguments: { input: "test" } }),
      );

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32602);
      expect(res.error!.message).toContain("Tool not exposed");
    });
  });

  describe("prompts/list", () => {
    it("lists all guides when exposedGuides is *", async () => {
      const handler = createMcpJsonRpcHandler(makeConfig(), makeMockCtx(tools, guides));
      const res = await handler(makeReq("prompts/list"));
      const result = res.result as { prompts: Array<{ name: string }> };

      expect(result.prompts).toHaveLength(2);
      expect(result.prompts[0].name).toBe("guide1");
    });

    it("filters guides by exposedGuides whitelist", async () => {
      const handler = createMcpJsonRpcHandler(
        makeConfig({ exposedGuides: ["guide1"] }),
        makeMockCtx(tools, guides),
      );
      const res = await handler(makeReq("prompts/list"));
      const result = res.result as { prompts: Array<{ name: string }> };

      expect(result.prompts).toHaveLength(1);
    });

    it("returns error when guides not available", async () => {
      const handler = createMcpJsonRpcHandler(makeConfig(), makeMockCtx(tools, undefined));
      const res = await handler(makeReq("prompts/list"));

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32600);
    });
  });

  describe("prompts/get", () => {
    it("returns prompt content for valid guide", async () => {
      const handler = createMcpJsonRpcHandler(makeConfig(), makeMockCtx(tools, guides));
      const res = await handler(makeReq("prompts/get", { name: "guide1" }));
      const result = res.result as { description: string; messages: Array<{ role: string; content: { type: string; text: string } }> };

      expect(result.description).toBe("Guide 1");
      expect(result.messages[0].content.text).toBe("system prompt text");
    });

    it("returns error for unknown prompt", async () => {
      const handler = createMcpJsonRpcHandler(makeConfig(), makeMockCtx(tools, guides));
      const res = await handler(makeReq("prompts/get", { name: "nonexistent" }));

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32602);
    });

    it("returns error for unexposed prompt", async () => {
      const handler = createMcpJsonRpcHandler(
        makeConfig({ exposedGuides: ["guide1"] }),
        makeMockCtx(tools, guides),
      );
      const res = await handler(makeReq("prompts/get", { name: "guide2" }));

      expect(res.error).toBeDefined();
      expect(res.error!.message).toContain("Prompt not exposed");
    });
  });

  describe("unknown method", () => {
    it("returns method not found error", async () => {
      const handler = createMcpJsonRpcHandler(makeConfig(), makeMockCtx(tools, guides));
      const res = await handler(makeReq("unknown/method"));

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32601);
      expect(res.error!.message).toContain("Method not found");
    });
  });

  describe("internal error", () => {
    it("catches thrown errors and returns internal error response", async () => {
      const ctx = makeMockCtx(tools, guides);
      // Make tools.list throw
      ctx.tools = {
        list: () => { throw new Error("Registry error"); },
        get: () => undefined,
      };
      const handler = createMcpJsonRpcHandler(makeConfig(), ctx);
      const res = await handler(makeReq("tools/list"));

      expect(res.error).toBeDefined();
      expect(res.error!.code).toBe(-32603);
      expect(res.error!.message).toContain("Internal error");
    });
  });
});
