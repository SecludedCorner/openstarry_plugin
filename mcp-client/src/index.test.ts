import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import { jsonSchemaToZod } from "./schema.js";
import { McpClientImpl } from "./client.js";
import type { McpTransport } from "./transport/types.js";
import { createMcpToolBridge } from "./bridges/tool-bridge.js";
import { createMcpPromptBridge } from "./bridges/prompt-bridge.js";

// ─── Mock Transport ───

class MockMcpTransport implements McpTransport {
  private responses = new Map<string, unknown>();
  connectCalled = false;
  closeCalled = false;
  notifications: Array<{ method: string; params?: unknown }> = [];

  setResponse(method: string, response: unknown) {
    this.responses.set(method, response);
  }

  async connect() { this.connectCalled = true; }

  async send(method: string, _params?: unknown): Promise<unknown> {
    const response = this.responses.get(method);
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error(`No mock for method: ${method}`);
    return response;
  }

  notify(method: string, params?: unknown) {
    this.notifications.push({ method, params });
  }

  async close() { this.closeCalled = true; }
}

// ─── Schema Converter Tests ───

describe("jsonSchemaToZod", () => {
  it("converts string type", () => {
    const schema = jsonSchemaToZod({ type: "string" });
    expect(schema.parse("hello")).toBe("hello");
    expect(() => schema.parse(123)).toThrow();
  });

  it("converts number type", () => {
    const schema = jsonSchemaToZod({ type: "number" });
    expect(schema.parse(42)).toBe(42);
    expect(schema.parse(3.14)).toBe(3.14);
  });

  it("converts integer type", () => {
    const schema = jsonSchemaToZod({ type: "integer" });
    expect(schema.parse(42)).toBe(42);
    expect(() => schema.parse(3.14)).toThrow();
  });

  it("converts boolean type", () => {
    const schema = jsonSchemaToZod({ type: "boolean" });
    expect(schema.parse(true)).toBe(true);
  });

  it("converts object with properties", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    expect(schema.parse({ name: "test" })).toEqual({ name: "test" });
    expect(schema.parse({ name: "test", age: 30 })).toEqual({ name: "test", age: 30 });
    expect(() => schema.parse({})).toThrow(); // name is required
  });

  it("converts array type", () => {
    const schema = jsonSchemaToZod({
      type: "array",
      items: { type: "string" },
    });
    expect(schema.parse(["a", "b"])).toEqual(["a", "b"]);
    expect(() => schema.parse([1, 2])).toThrow();
  });

  it("converts enum", () => {
    const schema = jsonSchemaToZod({
      enum: ["red", "green", "blue"],
    });
    expect(schema.parse("red")).toBe("red");
    expect(() => schema.parse("yellow")).toThrow();
  });

  it("converts const", () => {
    const schema = jsonSchemaToZod({ const: "fixed" });
    expect(schema.parse("fixed")).toBe("fixed");
    expect(() => schema.parse("other")).toThrow();
  });

  it("converts anyOf", () => {
    const schema = jsonSchemaToZod({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    expect(schema.parse("hello")).toBe("hello");
    expect(schema.parse(42)).toBe(42);
  });

  it("converts nested objects", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: {
        address: {
          type: "object",
          properties: {
            street: { type: "string" },
            city: { type: "string" },
          },
          required: ["street"],
        },
      },
      required: ["address"],
    });
    expect(schema.parse({ address: { street: "123 Main" } })).toEqual({
      address: { street: "123 Main" },
    });
  });

  it("returns z.unknown() for unsupported types", () => {
    const schema = jsonSchemaToZod({} as any);
    expect(schema.parse("anything")).toBe("anything");
    expect(schema.parse(42)).toBe(42);
  });

  it("handles empty object", () => {
    const schema = jsonSchemaToZod({ type: "object" });
    expect(schema.parse({ any: "value" })).toEqual({ any: "value" });
  });

  it("handles object with additionalProperties false", () => {
    const schema = jsonSchemaToZod({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(schema.parse({ name: "test" })).toEqual({ name: "test" });
    expect(() => schema.parse({ name: "test", extra: true })).toThrow();
  });
});

// ─── McpClient Tests ───

describe("McpClientImpl", () => {
  let transport: MockMcpTransport;
  let client: McpClientImpl;

  beforeEach(() => {
    transport = new MockMcpTransport();
    client = new McpClientImpl("test-server", transport);
  });

  it("connects and performs handshake", async () => {
    transport.setResponse("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test", version: "1.0.0" },
    });

    await client.connect();

    expect(client.isConnected).toBe(true);
    expect(client.name).toBe("test-server");
    expect(transport.connectCalled).toBe(true);
    expect(transport.notifications).toEqual([
      { method: "notifications/initialized", params: undefined },
    ]);
  });

  it("throws on failed handshake", async () => {
    transport.setResponse("initialize", new Error("Connection refused"));

    await expect(client.connect()).rejects.toThrow("Initialize handshake failed");
  });

  it("lists tools", async () => {
    transport.setResponse("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test", version: "1.0.0" },
    });
    transport.setResponse("tools/list", {
      tools: [
        { name: "read_file", description: "Read a file", inputSchema: { type: "object" } },
      ],
    });

    await client.connect();
    const tools = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("read_file");
  });

  it("calls a tool", async () => {
    transport.setResponse("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test", version: "1.0.0" },
    });
    transport.setResponse("tools/call", {
      content: [{ type: "text", text: "file contents here" }],
    });

    await client.connect();
    const result = await client.callTool("read_file", { path: "/tmp/test.txt" });

    expect(result.content[0]).toEqual({ type: "text", text: "file contents here" });
  });

  it("throws when calling before connect", async () => {
    await expect(client.listTools()).rejects.toThrow("Client not connected");
  });

  it("lists prompts when capability declared", async () => {
    transport.setResponse("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: "test", version: "1.0.0" },
    });
    transport.setResponse("prompts/list", {
      prompts: [
        { name: "code_review", description: "Review code" },
      ],
    });

    await client.connect();
    const prompts = await client.listPrompts();

    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe("code_review");
  });

  it("returns empty array when no prompts capability", async () => {
    transport.setResponse("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test", version: "1.0.0" },
    });

    await client.connect();
    const prompts = await client.listPrompts();

    expect(prompts).toEqual([]);
  });

  it("gets a prompt", async () => {
    transport.setResponse("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: "test", version: "1.0.0" },
    });
    transport.setResponse("prompts/get", {
      messages: [
        { role: "user", content: { type: "text", text: "Review this code" } },
      ],
    });

    await client.connect();
    const result = await client.getPrompt("code_review", { code: "fn main() {}" });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
  });

  it("closes connection", async () => {
    transport.setResponse("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test", version: "1.0.0" },
    });

    await client.connect();
    expect(client.isConnected).toBe(true);

    await client.close();
    expect(client.isConnected).toBe(false);
    expect(transport.closeCalled).toBe(true);
  });

  it("wraps tool call errors with McpError", async () => {
    transport.setResponse("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test", version: "1.0.0" },
    });
    transport.setResponse("tools/call", new Error("Tool not found"));

    await client.connect();
    await expect(client.callTool("unknown", {})).rejects.toThrow("Failed to call tool");
  });
});

// ─── Tool Bridge Tests ───

describe("createMcpToolBridge", () => {
  let transport: MockMcpTransport;
  let client: McpClientImpl;

  beforeEach(async () => {
    transport = new MockMcpTransport();
    client = new McpClientImpl("test-server", transport);
    transport.setResponse("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "test", version: "1.0.0" },
    });
    await client.connect();
  });

  it("creates ITool with namespaced id", () => {
    const tool = createMcpToolBridge(
      "filesystem", "read_file", "Read a file",
      z.object({ path: z.string() }), client,
    );

    expect(tool.id).toBe("filesystem/read_file");
    expect(tool.description).toBe("Read a file");
  });

  it("execute calls mcpClient.callTool and extracts text", async () => {
    transport.setResponse("tools/call", {
      content: [{ type: "text", text: "Hello World" }],
    });

    const tool = createMcpToolBridge(
      "test", "echo", "Echo",
      z.object({ message: z.string() }), client,
    );

    const result = await tool.execute({ message: "hi" }, {} as any);
    expect(result).toBe("Hello World");
  });

  it("throws ToolExecutionError when isError is true", async () => {
    transport.setResponse("tools/call", {
      content: [{ type: "text", text: "File not found" }],
      isError: true,
    });

    const tool = createMcpToolBridge(
      "test", "read", "Read",
      z.object({}), client,
    );

    await expect(tool.execute({}, {} as any)).rejects.toThrow("File not found");
  });

  it("handles image content as placeholder", async () => {
    transport.setResponse("tools/call", {
      content: [
        { type: "text", text: "Caption" },
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
    });

    const tool = createMcpToolBridge(
      "test", "screenshot", "Screenshot",
      z.object({}), client,
    );

    const result = await tool.execute({}, {} as any);
    expect(result).toBe("Caption\n[image: image/png]");
  });
});

// ─── Prompt Bridge Tests ───

describe("createMcpPromptBridge", () => {
  let transport: MockMcpTransport;
  let client: McpClientImpl;

  beforeEach(async () => {
    transport = new MockMcpTransport();
    client = new McpClientImpl("test-server", transport);
    transport.setResponse("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: "test", version: "1.0.0" },
    });
    await client.connect();
  });

  it("creates SlashCommand with namespaced name", () => {
    const cmd = createMcpPromptBridge("filesystem", "code_review", "Review code", client);
    expect(cmd.name).toBe("mcp:filesystem:code_review");
    expect(cmd.description).toBe("Review code");
  });

  it("execute calls getPrompt and formats messages", async () => {
    transport.setResponse("prompts/get", {
      description: "Code review prompt",
      messages: [
        { role: "user", content: { type: "text", text: "Please review: test code" } },
        { role: "assistant", content: { type: "text", text: "I will review it." } },
      ],
    });

    const cmd = createMcpPromptBridge("test", "review", "Review", client);
    const result = await cmd.execute("code=test", {} as any);

    expect(result).toContain("[Prompt: review]");
    expect(result).toContain("Description: Code review prompt");
    expect(result).toContain("user: Please review: test code");
    expect(result).toContain("assistant: I will review it.");
  });

  it("parses key=value arguments", async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const origSend = transport.send.bind(transport);
    transport.send = async (method: string, params?: unknown) => {
      if (method === "prompts/get") {
        capturedArgs = (params as any)?.arguments;
        return { messages: [{ role: "user", content: { type: "text", text: "ok" } }] };
      }
      return origSend(method, params);
    };

    const cmd = createMcpPromptBridge("test", "review", "Review", client);
    await cmd.execute("code=hello lang=rust", {} as any);

    expect(capturedArgs).toEqual({ code: "hello", lang: "rust" });
  });
});

// ─── Plugin Factory Tests ───

describe("createMcpClientPlugin (factory)", () => {
  // We import dynamically to keep the test file self-contained
  it("exports createMcpClientPlugin function", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.createMcpClientPlugin).toBe("function");
  });

  it("returns IPlugin with correct manifest", async () => {
    const mod = await import("./index.js");
    const plugin = mod.createMcpClientPlugin();
    expect(plugin.manifest.name).toBe("@openstarry-plugin/mcp-client");
    expect(plugin.manifest.version).toBe("0.4.0");
  });

  it("factory returns empty hooks when no servers configured", async () => {
    const mod = await import("./index.js");
    const plugin = mod.createMcpClientPlugin();

    const mockCtx = {
      bus: { on: vi.fn(), once: vi.fn(), onAny: vi.fn(), emit: vi.fn() },
      workingDirectory: "/tmp",
      agentId: "test",
      config: { servers: [] },
      pushInput: vi.fn(),
      sessions: {} as any,
    };

    const hooks = await plugin.factory(mockCtx);
    expect(hooks.tools).toBeUndefined();
    expect(hooks.commands).toBeDefined();
    expect(hooks.commands!.length).toBe(4); // status, tools, prompts, resources
  });

  it("factory returns empty hooks when config is missing", async () => {
    const mod = await import("./index.js");
    const plugin = mod.createMcpClientPlugin();

    const mockCtx = {
      bus: { on: vi.fn(), once: vi.fn(), onAny: vi.fn(), emit: vi.fn() },
      workingDirectory: "/tmp",
      agentId: "test",
      config: {},
      pushInput: vi.fn(),
      sessions: {} as any,
    };

    const hooks = await plugin.factory(mockCtx);
    expect(hooks.commands).toBeDefined();
  });

  it("mcp-status command reports no servers", async () => {
    const mod = await import("./index.js");
    const plugin = mod.createMcpClientPlugin();

    const mockCtx = {
      bus: { on: vi.fn(), once: vi.fn(), onAny: vi.fn(), emit: vi.fn() },
      workingDirectory: "/tmp",
      agentId: "test",
      config: { servers: [] },
      pushInput: vi.fn(),
      sessions: {} as any,
    };

    const hooks = await plugin.factory(mockCtx);
    const statusCmd = hooks.commands!.find((c) => c.name === "mcp-status");
    expect(statusCmd).toBeDefined();

    const result = await statusCmd!.execute("", mockCtx);
    expect(result).toBe("No MCP servers configured.");
  });
});
