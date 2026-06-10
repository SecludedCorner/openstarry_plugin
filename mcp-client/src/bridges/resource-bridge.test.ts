/**
 * Tests for MCP resource bridge — MCP resources → OpenStarry SlashCommands
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpResourceBridge } from "./resource-bridge.js";
import type { McpResourceInfo, McpResourceResult, McpContent } from "../client.js";
import type { IPluginContext } from "@openstarry/sdk";

describe("createMcpResourceBridge", () => {
  let mockClient: any;
  let mockContext: IPluginContext;

  beforeEach(() => {
    mockClient = {
      readResource: vi.fn(),
    };

    mockContext = {
      bus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), onAny: vi.fn() },
      workingDirectory: "/test",
      agentId: "test-agent",
      config: {},
      pushInput: vi.fn(),
      sessions: {} as any,
    };
  });

  it("creates SlashCommand with correct name format", () => {
    const resourceInfo: McpResourceInfo = {
      name: "test-resource",
      uri: "test://resource/1",
      description: "Test resource",
      mimeType: "text/plain",
    };

    const command = createMcpResourceBridge("test-server", resourceInfo, mockClient);

    expect(command.name).toBe("mcp-resource:test-server:test-resource");
    expect(command.description).toBe("Test resource");
  });

  it("uses default description if not provided", () => {
    const resourceInfo: McpResourceInfo = {
      name: "no-desc",
      uri: "test://resource/2",
    };

    const command = createMcpResourceBridge("test-server", resourceInfo, mockClient);

    expect(command.description).toBe("MCP resource from test-server");
  });

  it("executes and returns text content", async () => {
    const resourceInfo: McpResourceInfo = {
      name: "text-resource",
      uri: "test://text",
    };

    const mockResult: McpResourceResult = {
      contents: [
        { type: "text", text: "Hello from MCP" },
      ],
    };

    mockClient.readResource.mockResolvedValue(mockResult);

    const command = createMcpResourceBridge("test-server", resourceInfo, mockClient);
    const result = await command.execute("", mockContext);

    expect(mockClient.readResource).toHaveBeenCalledWith("test://text");
    expect(result).toBe("Hello from MCP");
  });

  it("executes and returns multiple content parts joined", async () => {
    const resourceInfo: McpResourceInfo = {
      name: "multi-resource",
      uri: "test://multi",
    };

    const mockResult: McpResourceResult = {
      contents: [
        { type: "text", text: "Part 1" },
        { type: "text", text: "Part 2" },
        { type: "text", text: "Part 3" },
      ],
    };

    mockClient.readResource.mockResolvedValue(mockResult);

    const command = createMcpResourceBridge("test-server", resourceInfo, mockClient);
    const result = await command.execute("", mockContext);

    expect(result).toBe("Part 1\nPart 2\nPart 3");
  });

  it("handles image content with placeholder", async () => {
    const resourceInfo: McpResourceInfo = {
      name: "image-resource",
      uri: "test://image",
    };

    const mockResult: McpResourceResult = {
      contents: [
        { type: "image", data: "base64data", mimeType: "image/png" },
      ],
    };

    mockClient.readResource.mockResolvedValue(mockResult);

    const command = createMcpResourceBridge("test-server", resourceInfo, mockClient);
    const result = await command.execute("", mockContext);

    expect(result).toBe("[image: image/png]");
  });

  it("handles resource content with text fallback", async () => {
    const resourceInfo: McpResourceInfo = {
      name: "nested-resource",
      uri: "test://nested",
    };

    const mockResult: McpResourceResult = {
      contents: [
        { type: "resource", uri: "other://resource", text: "Nested content" },
      ],
    };

    mockClient.readResource.mockResolvedValue(mockResult);

    const command = createMcpResourceBridge("test-server", resourceInfo, mockClient);
    const result = await command.execute("", mockContext);

    expect(result).toBe("Nested content");
  });

  it("handles resource content without text using URI", async () => {
    const resourceInfo: McpResourceInfo = {
      name: "uri-resource",
      uri: "test://uri",
    };

    const mockResult: McpResourceResult = {
      contents: [
        { type: "resource", uri: "other://resource" },
      ],
    };

    mockClient.readResource.mockResolvedValue(mockResult);

    const command = createMcpResourceBridge("test-server", resourceInfo, mockClient);
    const result = await command.execute("", mockContext);

    expect(result).toBe("[resource: other://resource]");
  });

  it("returns error message on read failure", async () => {
    const resourceInfo: McpResourceInfo = {
      name: "error-resource",
      uri: "test://error",
    };

    mockClient.readResource.mockRejectedValue(new Error("Network error"));

    const command = createMcpResourceBridge("test-server", resourceInfo, mockClient);
    const result = await command.execute("", mockContext);

    expect(result).toBe("Error reading resource: Network error");
  });

  it("handles non-Error exceptions", async () => {
    const resourceInfo: McpResourceInfo = {
      name: "string-error",
      uri: "test://string-error",
    };

    mockClient.readResource.mockRejectedValue("String error");

    const command = createMcpResourceBridge("test-server", resourceInfo, mockClient);
    const result = await command.execute("", mockContext);

    expect(result).toBe("Error reading resource: String error");
  });
});
