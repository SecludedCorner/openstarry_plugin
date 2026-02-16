/**
 * Tests for HTTP transport OAuth integration
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { StreamableHttpTransport } from "./http.js";
import type { McpTransportAuth } from "./types.js";

describe("StreamableHttpTransport OAuth", () => {
  let mockAuth: McpTransportAuth;

  beforeEach(() => {
    mockAuth = {
      getToken: vi.fn(),
      onUnauthorized: vi.fn(),
    };

    global.fetch = vi.fn();
  });

  it("injects Bearer token in Authorization header when auth is provided", async () => {
    mockAuth.getToken = vi.fn(async () => "test-access-token");

    global.fetch = vi.fn(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { success: true },
        }),
      } as Response)
    );

    const transport = new StreamableHttpTransport(
      "http://example.com/mcp",
      {},
      mockAuth
    );

    await transport.connect();
    await transport.send("test/method", { arg: "value" });

    expect(mockAuth.getToken).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      "http://example.com/mcp",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Authorization": "Bearer test-access-token",
        }),
      })
    );
  });

  it("does not inject Authorization header when auth returns null", async () => {
    mockAuth.getToken = vi.fn(async () => null);

    global.fetch = vi.fn(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { success: true },
        }),
      } as Response)
    );

    const transport = new StreamableHttpTransport(
      "http://example.com/mcp",
      {},
      mockAuth
    );

    await transport.connect();
    await transport.send("test/method");

    const fetchCall = (global.fetch as any).mock.calls[0];
    const headers = fetchCall[1].headers;

    expect(headers["Authorization"]).toBeUndefined();
  });

  it("retries request after token refresh on 401 Unauthorized", async () => {
    mockAuth.getToken = vi
      .fn()
      .mockResolvedValueOnce("old-token")
      .mockResolvedValueOnce("new-token");

    mockAuth.onUnauthorized = vi.fn(async () => true);

    global.fetch = vi
      .fn()
      // First call: 401 Unauthorized
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as Response)
      // Second call: Success
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { success: true },
        }),
      } as Response);

    const transport = new StreamableHttpTransport(
      "http://example.com/mcp",
      {},
      mockAuth
    );

    await transport.connect();
    const result = await transport.send("test/method");

    expect(mockAuth.onUnauthorized).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(2);

    // First call with old token
    expect((global.fetch as any).mock.calls[0][1].headers["Authorization"]).toBe(
      "Bearer old-token"
    );

    // Second call with new token
    expect((global.fetch as any).mock.calls[1][1].headers["Authorization"]).toBe(
      "Bearer new-token"
    );

    expect(result).toEqual({ success: true });
  });

  it("does not retry on 401 if token refresh fails", async () => {
    mockAuth.getToken = vi.fn(async () => "old-token");
    mockAuth.onUnauthorized = vi.fn(async () => false);

    global.fetch = vi.fn(async () =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as Response)
    );

    const transport = new StreamableHttpTransport(
      "http://example.com/mcp",
      {},
      mockAuth
    );

    await transport.connect();

    await expect(transport.send("test/method")).rejects.toThrow(
      "HTTP 401: Unauthorized (token refresh failed)"
    );

    expect(mockAuth.onUnauthorized).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 401 if already retried once", async () => {
    mockAuth.getToken = vi.fn(async () => "token");
    mockAuth.onUnauthorized = vi.fn(async () => true);

    // Both calls return 401
    global.fetch = vi.fn(async () =>
      Promise.resolve({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      } as Response)
    );

    const transport = new StreamableHttpTransport(
      "http://example.com/mcp",
      {},
      mockAuth
    );

    await transport.connect();

    await expect(transport.send("test/method")).rejects.toThrow(
      "HTTP 401: Unauthorized"
    );

    // Should only call onUnauthorized once (no infinite retry)
    expect(mockAuth.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("works without auth (backward compatibility)", async () => {
    global.fetch = vi.fn(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { success: true },
        }),
      } as Response)
    );

    const transport = new StreamableHttpTransport(
      "http://example.com/mcp",
      { "X-Custom": "header" }
    );

    await transport.connect();
    const result = await transport.send("test/method");

    expect(result).toEqual({ success: true });

    const fetchCall = (global.fetch as any).mock.calls[0];
    const headers = fetchCall[1].headers;

    expect(headers["X-Custom"]).toBe("header");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("preserves custom headers when injecting auth", async () => {
    mockAuth.getToken = vi.fn(async () => "token");

    global.fetch = vi.fn(async () =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: { success: true },
        }),
      } as Response)
    );

    const transport = new StreamableHttpTransport(
      "http://example.com/mcp",
      { "X-Custom": "value", "X-Another": "header" },
      mockAuth
    );

    await transport.connect();
    await transport.send("test/method");

    const fetchCall = (global.fetch as any).mock.calls[0];
    const headers = fetchCall[1].headers;

    expect(headers["Authorization"]).toBe("Bearer token");
    expect(headers["X-Custom"]).toBe("value");
    expect(headers["X-Another"]).toBe("header");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("handles other HTTP errors without retry", async () => {
    mockAuth.getToken = vi.fn(async () => "token");

    global.fetch = vi.fn(async () =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      } as Response)
    );

    const transport = new StreamableHttpTransport(
      "http://example.com/mcp",
      {},
      mockAuth
    );

    await transport.connect();

    await expect(transport.send("test/method")).rejects.toThrow(
      "HTTP 500: Internal Server Error"
    );

    // Should not call onUnauthorized for non-401 errors
    expect(mockAuth.onUnauthorized).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
