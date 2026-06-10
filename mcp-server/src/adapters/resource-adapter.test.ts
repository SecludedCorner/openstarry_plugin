/**
 * Tests for resource adapter — SlashCommand → MCP resource
 */
import { describe, it, expect, vi } from "vitest";
import { commandToMcpResource, executeCommandAsResource, parseResourceUri } from "./resource-adapter.js";
import type { SlashCommand, IPluginContext } from "@openstarry/sdk";

describe("commandToMcpResource", () => {
  it("converts SlashCommand to MCP resource definition", () => {
    const command: SlashCommand = {
      name: "status",
      description: "Show system status",
      execute: async () => "OK",
    };

    const resource = commandToMcpResource(command);

    expect(resource).toEqual({
      name: "status",
      uri: "openstarry://command/status",
      description: "Show system status",
      mimeType: "text/plain",
    });
  });

  it("handles command without description", () => {
    const command: SlashCommand = {
      name: "no-desc",
      description: "",
      execute: async () => "result",
    };

    const resource = commandToMcpResource(command);

    expect(resource.name).toBe("no-desc");
    expect(resource.uri).toBe("openstarry://command/no-desc");
    expect(resource.description).toBe("");
  });
});

describe("executeCommandAsResource", () => {
  it("executes command and returns text content", async () => {
    const command: SlashCommand = {
      name: "test-cmd",
      description: "Test",
      execute: async () => "Command result",
    };

    const mockContext = {
      bus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), onAny: vi.fn() },
      workingDirectory: "/test",
      agentId: "test-agent",
      config: {},
      pushInput: vi.fn(),
      sessions: {} as any,
    } as IPluginContext;

    const result = await executeCommandAsResource(command, mockContext);

    expect(result).toEqual({
      contents: [
        {
          type: "text",
          text: "Command result",
        },
      ],
    });
  });

  it("passes empty args to command", async () => {
    const executeSpy = vi.fn(async (args: string) => `Args: [${args}]`);

    const command: SlashCommand = {
      name: "args-test",
      description: "Test",
      execute: executeSpy,
    };

    const mockContext = {
      bus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), onAny: vi.fn() },
      workingDirectory: "/test",
      agentId: "test-agent",
      config: {},
      pushInput: vi.fn(),
      sessions: {} as any,
    } as IPluginContext;

    await executeCommandAsResource(command, mockContext);

    expect(executeSpy).toHaveBeenCalledWith("", mockContext);
  });

  it("returns error as text content on execution failure", async () => {
    const command: SlashCommand = {
      name: "error-cmd",
      description: "Test",
      execute: async () => {
        throw new Error("Command failed");
      },
    };

    const mockContext = {
      bus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), onAny: vi.fn() },
      workingDirectory: "/test",
      agentId: "test-agent",
      config: {},
      pushInput: vi.fn(),
      sessions: {} as any,
    } as IPluginContext;

    const result = await executeCommandAsResource(command, mockContext);

    expect(result).toEqual({
      contents: [
        {
          type: "text",
          text: "Error executing command: Command failed",
        },
      ],
    });
  });

  it("handles non-Error exceptions", async () => {
    const command: SlashCommand = {
      name: "string-error",
      description: "Test",
      execute: async () => {
        throw "String error";
      },
    };

    const mockContext = {
      bus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), onAny: vi.fn() },
      workingDirectory: "/test",
      agentId: "test-agent",
      config: {},
      pushInput: vi.fn(),
      sessions: {} as any,
    } as IPluginContext;

    const result = await executeCommandAsResource(command, mockContext);

    expect(result.contents[0]).toEqual({
      type: "text",
      text: "Error executing command: String error",
    });
  });
});

describe("parseResourceUri", () => {
  it("parses valid openstarry:// URI", () => {
    const commandName = parseResourceUri("openstarry://command/status");
    expect(commandName).toBe("status");
  });

  it("parses URI with complex command name", () => {
    const commandName = parseResourceUri("openstarry://command/mcp-server-status");
    expect(commandName).toBe("mcp-server-status");
  });

  it("returns null for non-openstarry URI", () => {
    const commandName = parseResourceUri("http://example.com/resource");
    expect(commandName).toBeNull();
  });

  it("returns null for missing command name", () => {
    const commandName = parseResourceUri("openstarry://command/");
    expect(commandName).toBeNull();
  });

  it("returns null for URI with path traversal attempt", () => {
    const commandName = parseResourceUri("openstarry://command/../etc/passwd");
    expect(commandName).toBeNull();
  });

  it("returns null for URI with forward slash in command name", () => {
    const commandName = parseResourceUri("openstarry://command/cmd/subcmd");
    expect(commandName).toBeNull();
  });

  it("returns null for malformed URI", () => {
    expect(parseResourceUri("openstarry://")).toBeNull();
    expect(parseResourceUri("openstarry://command")).toBeNull();
    expect(parseResourceUri("")).toBeNull();
  });
});
