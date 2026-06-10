import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import { HttpServerTransport } from "./http.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";

let portCounter = 39800;
function nextPort(): number {
  return portCounter++;
}

function sendPostRequest(
  port: number,
  body: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(responseBody) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: responseBody });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sendGetRequest(port: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path: "/" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(responseBody) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: responseBody });
          }
        });
      },
    );
    req.on("error", reject);
  });
}

describe("HttpServerTransport", () => {
  const transports: HttpServerTransport[] = [];

  afterEach(async () => {
    for (const t of transports) {
      await t.stop();
    }
    transports.length = 0;
  });

  function makeTransport(port?: number): HttpServerTransport {
    const t = new HttpServerTransport(port ?? nextPort());
    transports.push(t);
    return t;
  }

  it("creates transport with default port and host", () => {
    const transport = new HttpServerTransport();
    transports.push(transport);
    expect(transport).toBeInstanceOf(HttpServerTransport);
  });

  it("starts and stops HTTP server", async () => {
    const transport = makeTransport();
    await transport.start();
    await transport.stop();
  });

  it("ignores duplicate start calls", async () => {
    const transport = makeTransport();
    await transport.start();
    await transport.start(); // Should not throw
  });

  it("handles JSON-RPC request via POST", async () => {
    const port = nextPort();
    const transport = new HttpServerTransport(port);
    transports.push(transport);

    transport.onRequest(async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { echo: req.method },
      };
    });
    await transport.start();

    const response = await sendPostRequest(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test/echo" }),
    );

    expect(response.status).toBe(200);
    const body = response.body as JsonRpcResponse;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect((body.result as { echo: string }).echo).toBe("test/echo");
  });

  it("returns 405 for non-POST methods", async () => {
    const port = nextPort();
    const transport = new HttpServerTransport(port);
    transports.push(transport);
    await transport.start();

    const response = await sendGetRequest(port);
    expect(response.status).toBe(405);
  });

  it("returns parse error for invalid JSON", async () => {
    const port = nextPort();
    const transport = new HttpServerTransport(port);
    transports.push(transport);

    transport.onRequest(async () => ({ jsonrpc: "2.0", id: 0, result: {} }));
    await transport.start();

    const response = await sendPostRequest(port, "not valid json{{{");

    const body = response.body as JsonRpcResponse;
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32700);
  });

  it("returns error when no handler registered", async () => {
    const port = nextPort();
    const transport = new HttpServerTransport(port);
    transports.push(transport);
    await transport.start();

    const response = await sendPostRequest(
      port,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "test" }),
    );

    const body = response.body as JsonRpcResponse;
    expect(body.error).toBeDefined();
    expect(body.error!.code).toBe(-32603);
  });

  it("sendNotification is a no-op for HTTP transport", () => {
    const transport = makeTransport();
    // Should not throw
    transport.sendNotification("test", { data: "value" });
  });
});
