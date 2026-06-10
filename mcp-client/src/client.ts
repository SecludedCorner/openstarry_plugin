/**
 * McpClient — MCP protocol client with JSON-RPC 2.0 and initialize handshake.
 */
import { McpError, ErrorCode } from "@openstarry/sdk";
import { createLogger } from "@openstarry/shared";
import type {
  McpCapabilities,
  McpToolInfo,
  McpToolResult,
  McpPromptInfo,
  McpPromptResult,
  McpResourceInfo,
  McpResourceResult,
} from "@openstarry-plugin/mcp-common";
import { PROTOCOL_VERSION } from "@openstarry-plugin/mcp-common";
import type { McpTransport } from "./transport/types.js";

const logger = createLogger("mcp-client");

export type { McpCapabilities, McpToolInfo, McpToolResult, McpContent, McpPromptInfo, McpPromptResult, McpResourceInfo, McpResourceResult } from "@openstarry-plugin/mcp-common";

export class McpClientImpl {
  private transport: McpTransport;
  private _name: string;
  private _isConnected = false;
  private _serverCapabilities: McpCapabilities = {};

  constructor(name: string, transport: McpTransport) {
    this._name = name;
    this.transport = transport;
  }

  get name(): string {
    return this._name;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get serverCapabilities(): McpCapabilities {
    return this._serverCapabilities;
  }

  async connect(): Promise<void> {
    try {
      await this.transport.connect();
    } catch (err) {
      throw new McpError(this._name, "Failed to connect transport", {
        cause: err instanceof Error ? err : undefined,
        code: ErrorCode.MCP_CONNECTION_ERROR,
      });
    }

    try {
      const initResult = (await this.transport.send("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          sampling: {}, // NEW: Client supports sampling
          roots: { listChanged: true }, // NEW: Client supports roots with change notifications
        },
        clientInfo: { name: "openstarry", version: "0.12.0" },
      })) as {
        protocolVersion?: string;
        capabilities?: McpCapabilities;
        serverInfo?: { name: string; version?: string };
      };

      this._serverCapabilities = initResult?.capabilities ?? {};

      // Send initialized notification
      this.transport.notify("notifications/initialized");
      this._isConnected = true;

      const serverInfo = initResult?.serverInfo;
      const desc = serverInfo
        ? `${serverInfo.name}${serverInfo.version ? ` v${serverInfo.version}` : ""}`
        : this._name;
      logger.info("Connected to MCP server", { server: this._name, serverDesc: desc });
    } catch (err) {
      throw new McpError(this._name, "Initialize handshake failed", {
        cause: err instanceof Error ? err : undefined,
        code: ErrorCode.MCP_PROTOCOL_ERROR,
      });
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    this.ensureConnected();

    try {
      const result = (await this.transport.send("tools/list")) as { tools: McpToolInfo[] };
      return result?.tools ?? [];
    } catch (err) {
      throw new McpError(this._name, "Failed to list tools", {
        cause: err instanceof Error ? err : undefined,
        code: ErrorCode.MCP_PROTOCOL_ERROR,
      });
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this.ensureConnected();

    try {
      const result = (await this.transport.send("tools/call", {
        name,
        arguments: args,
      })) as McpToolResult;
      return result;
    } catch (err) {
      throw new McpError(this._name, `Failed to call tool "${name}"`, {
        cause: err instanceof Error ? err : undefined,
        code: ErrorCode.MCP_TOOL_CALL_ERROR,
      });
    }
  }

  async listPrompts(): Promise<McpPromptInfo[]> {
    this.ensureConnected();

    if (!this._serverCapabilities.prompts) {
      return [];
    }

    try {
      const result = (await this.transport.send("prompts/list")) as { prompts: McpPromptInfo[] };
      return result?.prompts ?? [];
    } catch (err) {
      throw new McpError(this._name, "Failed to list prompts", {
        cause: err instanceof Error ? err : undefined,
        code: ErrorCode.MCP_PROTOCOL_ERROR,
      });
    }
  }

  async getPrompt(name: string, args?: Record<string, unknown>): Promise<McpPromptResult> {
    this.ensureConnected();

    try {
      const result = (await this.transport.send("prompts/get", {
        name,
        arguments: args,
      })) as McpPromptResult;
      return result;
    } catch (err) {
      throw new McpError(this._name, `Failed to get prompt "${name}"`, {
        cause: err instanceof Error ? err : undefined,
        code: ErrorCode.MCP_PROTOCOL_ERROR,
      });
    }
  }

  /**
   * FROZEN METHOD
   * List all resources exposed by the connected MCP server.
   * Returns empty array if server does not support resources capability.
   * @throws McpError if not connected or protocol error
   */
  async listResources(): Promise<McpResourceInfo[]> {
    this.ensureConnected();

    // Graceful degradation if server doesn't support resources
    if (!this._serverCapabilities.resources) {
      return [];
    }

    try {
      const result = (await this.transport.send("resources/list")) as { resources: McpResourceInfo[] };
      return result?.resources ?? [];
    } catch (err) {
      throw new McpError(this._name, "Failed to list resources", {
        cause: err instanceof Error ? err : undefined,
        code: ErrorCode.MCP_PROTOCOL_ERROR,
      });
    }
  }

  /**
   * FROZEN METHOD
   * Read a specific resource by URI.
   * @param uri - Resource URI (from McpResourceInfo.uri)
   * @returns Resource content as McpContent array
   * @throws McpError if not connected, resource not found, or protocol error
   */
  async readResource(uri: string): Promise<McpResourceResult> {
    this.ensureConnected();

    try {
      const result = (await this.transport.send("resources/read", {
        uri,
      })) as McpResourceResult;
      return result;
    } catch (err) {
      throw new McpError(this._name, `Failed to read resource "${uri}"`, {
        cause: err instanceof Error ? err : undefined,
        code: ErrorCode.MCP_PROTOCOL_ERROR,
      });
    }
  }

  async close(): Promise<void> {
    this._isConnected = false;
    await this.transport.close();
    logger.info("Disconnected from MCP server", { server: this._name });
  }

  private ensureConnected(): void {
    if (!this._isConnected) {
      throw new McpError(this._name, "Client not connected", {
        code: ErrorCode.MCP_CONNECTION_ERROR,
      });
    }
  }
}
