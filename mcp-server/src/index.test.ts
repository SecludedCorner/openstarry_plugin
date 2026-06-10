import { describe, it, expect, vi } from "vitest";
import { createMcpServerPlugin } from "./index.js";
import type { IPluginContext, ITool, IGuide, EventBus } from "@openstarry/sdk";
import { z } from "zod";

function makeMockCtx(config: Record<string, unknown>): IPluginContext {
  const tools: ITool[] = [
    {
      id: "test-tool",
      description: "A tool",
      parameters: z.object({ input: z.string() }),
      execute: vi.fn().mockResolvedValue("result"),
    },
  ];

  const guides: IGuide[] = [
    {
      id: "test-guide",
      name: "A guide",
      getSystemPrompt: vi.fn().mockReturnValue("prompt"),
    },
  ];

  return {
    bus: { on: vi.fn(), once: vi.fn(), onAny: vi.fn(), emit: vi.fn() } as unknown as EventBus,
    workingDirectory: "/tmp/test",
    agentId: "test-agent",
    config,
    pushInput: vi.fn(),
    sessions: {} as IPluginContext["sessions"],
    tools: {
      list: () => tools,
      get: (id: string) => tools.find((t) => t.id === id),
    },
    guides: {
      list: () => guides,
    },
  };
}

describe("createMcpServerPlugin", () => {
  it("exports createMcpServerPlugin function", () => {
    expect(typeof createMcpServerPlugin).toBe("function");
  });

  it("returns IPlugin with manifest", () => {
    const plugin = createMcpServerPlugin();
    expect(plugin.manifest.name).toBe("@openstarry-plugin/mcp-server");
    expect(plugin.manifest.version).toBe("0.4.0");
  });

  it("throws on missing name config", async () => {
    const plugin = createMcpServerPlugin();
    const ctx = makeMockCtx({ version: "1.0.0" });

    await expect(plugin.factory(ctx)).rejects.toThrow("requires 'name'");
  });

  it("throws on missing version config", async () => {
    const plugin = createMcpServerPlugin();
    const ctx = makeMockCtx({ name: "test" });

    await expect(plugin.factory(ctx)).rejects.toThrow("requires 'version'");
  });

  it("throws on invalid transport config", async () => {
    const plugin = createMcpServerPlugin();
    const ctx = makeMockCtx({ name: "test", version: "1.0.0", transport: "websocket" });

    await expect(plugin.factory(ctx)).rejects.toThrow("must be \"stdio\" or \"http\"");
  });

  it("factory returns listeners and commands", async () => {
    const plugin = createMcpServerPlugin();
    const ctx = makeMockCtx({
      name: "test-server",
      version: "1.0.0",
      transport: "stdio",
    });

    const hooks = await plugin.factory(ctx);

    expect(hooks.listeners).toHaveLength(1);
    expect(hooks.listeners![0].id).toBe("mcp-server:test-server");
    expect(hooks.listeners![0].name).toContain("MCP Server");
    expect(hooks.commands).toHaveLength(4);
    expect(hooks.dispose).toBeDefined();
  });

  it("registers slash commands: mcp-server-status, mcp-server-tools, mcp-server-prompts", async () => {
    const plugin = createMcpServerPlugin();
    const ctx = makeMockCtx({
      name: "test-server",
      version: "1.0.0",
      transport: "stdio",
    });

    const hooks = await plugin.factory(ctx);
    const cmdNames = hooks.commands!.map((c) => c.name);

    expect(cmdNames).toContain("mcp-server-status");
    expect(cmdNames).toContain("mcp-server-tools");
    expect(cmdNames).toContain("mcp-server-prompts");
  });

  it("mcp-server-status command returns server info", async () => {
    const plugin = createMcpServerPlugin();
    const ctx = makeMockCtx({
      name: "my-agent",
      version: "2.0.0",
      transport: "http",
      port: 8080,
      host: "0.0.0.0",
    });

    const hooks = await plugin.factory(ctx);
    const statusCmd = hooks.commands!.find((c) => c.name === "mcp-server-status")!;
    const output = await statusCmd.execute("", ctx);

    expect(output).toContain("my-agent");
    expect(output).toContain("2.0.0");
    expect(output).toContain("http");
  });

  it("mcp-server-tools command lists exposed tools", async () => {
    const plugin = createMcpServerPlugin();
    const ctx = makeMockCtx({
      name: "test-server",
      version: "1.0.0",
      transport: "stdio",
    });

    const hooks = await plugin.factory(ctx);
    const toolsCmd = hooks.commands!.find((c) => c.name === "mcp-server-tools")!;
    const output = await toolsCmd.execute("", ctx);

    expect(output).toContain("test-tool");
  });

  it("mcp-server-prompts command lists exposed guides", async () => {
    const plugin = createMcpServerPlugin();
    const ctx = makeMockCtx({
      name: "test-server",
      version: "1.0.0",
      transport: "stdio",
    });

    const hooks = await plugin.factory(ctx);
    const promptsCmd = hooks.commands!.find((c) => c.name === "mcp-server-prompts")!;
    const output = await promptsCmd.execute("", ctx);

    expect(output).toContain("test-guide");
  });
});
