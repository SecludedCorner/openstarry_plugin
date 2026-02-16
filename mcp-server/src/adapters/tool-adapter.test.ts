import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { toolToMcpDefinition, executeToolForMcp } from "./tool-adapter.js";
import type { ITool, IPluginContext, EventBus } from "@openstarry/sdk";

function makeMockTool(overrides: Partial<ITool> = {}): ITool {
  return {
    id: "test-tool",
    description: "A test tool",
    parameters: z.object({
      input: z.string(),
    }),
    execute: vi.fn().mockResolvedValue("result text"),
    ...overrides,
  };
}

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

describe("toolToMcpDefinition", () => {
  it("converts ITool to MCP tool definition", () => {
    const tool = makeMockTool();
    const result = toolToMcpDefinition(tool);

    expect(result.name).toBe("test-tool");
    expect(result.description).toBe("A test tool");
    expect(result.inputSchema.type).toBe("object");
    expect(result.inputSchema.properties).toHaveProperty("input");
  });

  it("preserves tool description in MCP definition", () => {
    const tool = makeMockTool({ description: "Custom description" });
    const result = toolToMcpDefinition(tool);
    expect(result.description).toBe("Custom description");
  });

  it("handles tool with complex parameters", () => {
    const tool = makeMockTool({
      parameters: z.object({
        name: z.string(),
        count: z.number(),
        verbose: z.boolean().optional(),
      }),
    });
    const result = toolToMcpDefinition(tool);
    expect(result.inputSchema.properties).toHaveProperty("name");
    expect(result.inputSchema.properties).toHaveProperty("count");
    expect(result.inputSchema.properties).toHaveProperty("verbose");
    expect(result.inputSchema.required).toContain("name");
    expect(result.inputSchema.required).toContain("count");
  });
});

describe("executeToolForMcp", () => {
  it("executes tool and returns text content", async () => {
    const tool = makeMockTool();
    const ctx = makeMockCtx();
    const result = await executeToolForMcp(tool, { input: "hello" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "result text" });
  });

  it("returns validation error for invalid args", async () => {
    const tool = makeMockTool();
    const ctx = makeMockCtx();
    const result = await executeToolForMcp(tool, { input: 123 } as unknown as Record<string, unknown>, ctx);

    expect(result.isError).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("Validation error");
  });

  it("returns error when tool execution throws", async () => {
    const tool = makeMockTool({
      execute: vi.fn().mockRejectedValue(new Error("Tool failed")),
    });
    const ctx = makeMockCtx();
    const result = await executeToolForMcp(tool, { input: "hello" }, ctx);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("Tool execution error");
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("Tool failed");
  });

  it("passes correct ToolContext to tool.execute", async () => {
    const executeFn = vi.fn().mockResolvedValue("ok");
    const tool = makeMockTool({ execute: executeFn });
    const ctx = makeMockCtx();
    await executeToolForMcp(tool, { input: "test" }, ctx);

    expect(executeFn).toHaveBeenCalledWith(
      { input: "test" },
      expect.objectContaining({
        workingDirectory: "/tmp/test",
        allowedPaths: ["/tmp/test"],
      }),
    );
  });
});
