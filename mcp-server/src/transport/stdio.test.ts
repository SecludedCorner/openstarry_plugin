import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "./stdio.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

// Mock process.stdin and process.stdout
let stdinData: string[];
let stdoutData: string[];
let originalStdin: NodeJS.ReadStream;
let originalStdout: NodeJS.WriteStream;

function setupMockStdio(): void {
  stdinData = [];
  stdoutData = [];

  originalStdin = process.stdin;
  originalStdout = process.stdout;

  // Mock stdout.write to capture output
  const mockWrite = vi.fn((data: string | Buffer) => {
    stdoutData.push(typeof data === "string" ? data : data.toString());
    return true;
  });
  (process.stdout as unknown as { write: typeof mockWrite }).write = mockWrite;
}

function restoreMockStdio(): void {
  process.stdout.write = originalStdout.write.bind(originalStdout);
}

describe("StdioServerTransport", () => {
  let transport: StdioServerTransport;

  beforeEach(() => {
    setupMockStdio();
    transport = new StdioServerTransport();
  });

  afterEach(async () => {
    await transport.stop();
    restoreMockStdio();
  });

  it("creates transport instance", () => {
    expect(transport).toBeInstanceOf(StdioServerTransport);
  });

  it("can start and stop without error", async () => {
    await transport.start();
    await transport.stop();
  });

  it("ignores duplicate start calls", async () => {
    await transport.start();
    await transport.start(); // Should not throw
    await transport.stop();
  });

  it("ignores duplicate stop calls", async () => {
    await transport.start();
    await transport.stop();
    await transport.stop(); // Should not throw
  });

  it("sends notification as JSON line", () => {
    transport.sendNotification("notifications/tools/list_changed");

    expect(stdoutData).toHaveLength(1);
    const notification = JSON.parse(stdoutData[0].trim());
    expect(notification.jsonrpc).toBe("2.0");
    expect(notification.method).toBe("notifications/tools/list_changed");
  });

  it("sends notification with params", () => {
    transport.sendNotification("test/notify", { key: "value" });

    const notification = JSON.parse(stdoutData[0].trim());
    expect(notification.params).toEqual({ key: "value" });
  });
});
