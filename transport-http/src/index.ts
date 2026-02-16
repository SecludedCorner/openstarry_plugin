/**
 * transport-http — HTTP webhook transport plugin.
 *
 * Endpoints:
 *   POST /api/input   — Submit user input
 *   GET  /api/status  — Check agent status
 *   GET  /api/response?requestId=xxx — Poll response
 *   GET  /api/events[?sessionId=xxx] — SSE streaming endpoint
 *
 * Config:
 *   { port: 3000, host: "0.0.0.0", basePath: "/api", healthCheck: { enabled, intervalMs } }
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createLogger } from "@openstarry/shared";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IListener,
  IUI,
  AgentEvent,
} from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";

/** Health check configuration for HTTP transport (SSE heartbeat). */
interface HealthCheckConfig {
  /** Whether health checks are enabled. Default: true. */
  enabled?: boolean;
  /** Interval in milliseconds between heartbeat pings. Default: 30000. */
  intervalMs?: number;
}

interface Config {
  port?: number;
  host?: string;
  basePath?: string;
  responseBufferSize?: number;
  responseTimeout?: number;
  healthCheck?: HealthCheckConfig;
  /** Restrict CORS to specific origins. If empty/undefined, allows all origins ("*") for backward compatibility. */
  allowedOrigins?: string[];
}

interface BufferedResponse {
  requestId: string;
  events: AgentEvent[];
  createdAt: number;
  complete: boolean;
}

/** Internal type for tracking SSE connections. */
interface SSEConnection {
  /** Unique connection identifier. */
  id: string;
  /** Node.js ServerResponse object for writing SSE data. */
  res: ServerResponse;
  /** Timestamp (ms) when this SSE connection was established. */
  connectedAt: number;
  /** Monotonically increasing event ID counter for this connection. */
  lastEventId: number;
  /** Session ID bound to this SSE connection. */
  sessionId?: string;
}

export function createHttpPlugin(): IPlugin {
  return {
    manifest: {
      name: "transport-http",
      version: "0.1.0-alpha",
      description: "HTTP webhook transport plugin (Listener + UI)",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const config = ctx.config as Config;
      const port = config.port ?? 3000;
      const host = config.host ?? "0.0.0.0";
      const basePath = config.basePath ?? "/api";
      const bufferSize = config.responseBufferSize ?? 100;
      const bufferTimeout = config.responseTimeout ?? 300000; // 5 minutes
      const healthCheck = config.healthCheck ?? {};
      const healthCheckIntervalMs = healthCheck.intervalMs ?? 30000;
      const allowedOrigins = config.allowedOrigins;

      const logger = createLogger("transport-http");

      /** Resolve CORS origin based on allowedOrigins config. */
      function getCorsOrigin(requestOrigin: string | undefined): string {
        if (!allowedOrigins || allowedOrigins.length === 0) return "*";
        if (allowedOrigins.includes("*")) return "*";
        if (requestOrigin && allowedOrigins.includes(requestOrigin)) return requestOrigin;
        return "";
      }
      const responseBuffer = new Map<string, BufferedResponse>();
      const sseConnections = new Map<string, SSEConnection>();
      let server: ReturnType<typeof createServer> | null = null;
      let cleanupInterval: ReturnType<typeof setInterval> | null = null;

      // Cleanup old buffered responses periodically
      function startCleanup(): void {
        cleanupInterval = setInterval(() => {
          const now = Date.now();
          for (const [id, resp] of responseBuffer.entries()) {
            if (now - resp.createdAt > bufferTimeout) {
              responseBuffer.delete(id);
            }
          }
          // Also limit total buffer size
          if (responseBuffer.size > bufferSize) {
            const entries = Array.from(responseBuffer.entries());
            entries.sort((a, b) => a[1].createdAt - b[1].createdAt);
            const toRemove = entries.slice(0, entries.length - bufferSize);
            for (const [id] of toRemove) {
              responseBuffer.delete(id);
            }
          }
        }, 60000); // Check every minute
      }

      // Remove an SSE connection and optionally clean up its session
      function removeSseConnection(connId: string): void {
        const sseConn = sseConnections.get(connId);
        if (!sseConn) return;

        logger.debug("SSE client disconnected", { connectionId: connId });
        sseConnections.delete(connId);

        // Destroy session if no other SSE connection references it
        if (sseConn.sessionId) {
          const hasOtherConn = Array.from(sseConnections.values()).some(
            (c) => c.sessionId === sseConn.sessionId
          );
          if (!hasOtherConn) {
            ctx.sessions.destroy(sseConn.sessionId);
          }
        }
      }

      // ─── HTTP Listener ───
      const listener: IListener = {
        id: "http-webhook-listener",
        name: "HTTP Webhook Listener",

        async start(): Promise<void> {
          server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            // CORS headers
            const requestOrigin = req.headers.origin as string | undefined;
            const corsOrigin = getCorsOrigin(requestOrigin);
            if (corsOrigin) {
              res.setHeader("Access-Control-Allow-Origin", corsOrigin);
              if (corsOrigin !== "*") {
                res.setHeader("Vary", "Origin");
              }
            }
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Last-Event-ID");

            if (req.method === "OPTIONS") {
              res.writeHead(204);
              res.end();
              return;
            }

            const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

            // GET /api/events — SSE streaming endpoint
            if (url.pathname === `${basePath}/events` && req.method === "GET") {
              const connId = randomUUID();
              const requestedSessionId = url.searchParams.get("sessionId") ?? undefined;

              // Resolve or create session
              let sessionId: string;
              if (requestedSessionId) {
                const existing = ctx.sessions.get(requestedSessionId);
                if (existing) {
                  sessionId = existing.id;
                } else {
                  const newSession = ctx.sessions.create();
                  sessionId = newSession.id;
                }
              } else {
                const newSession = ctx.sessions.create();
                sessionId = newSession.id;
              }

              // SSE response headers
              const sseHeaders: Record<string, string> = {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
              };
              const sseCorsOrigin = getCorsOrigin(requestOrigin);
              if (sseCorsOrigin) {
                sseHeaders["Access-Control-Allow-Origin"] = sseCorsOrigin;
                if (sseCorsOrigin !== "*") {
                  sseHeaders["Vary"] = "Origin";
                }
              }
              res.writeHead(200, sseHeaders);

              // Initial retry interval
              res.write("retry: 5000\n");

              // Initial connected event
              res.write(`data: ${JSON.stringify({ type: "connected", connectionId: connId, sessionId })}\n\n`);

              // Track SSE connection
              const sseConn: SSEConnection = {
                id: connId,
                res,
                connectedAt: Date.now(),
                lastEventId: 0,
                sessionId,
              };
              sseConnections.set(connId, sseConn);

              logger.debug("SSE client connected", {
                connectionId: connId,
                sessionId,
              });

              // Heartbeat interval for this connection
              const heartbeatInterval = setInterval(() => {
                if (!res.writableEnded) {
                  res.write(`: heartbeat ${Date.now()}\n\n`);
                } else {
                  logger.debug("Cleaning up dead SSE connection", {
                    connectionId: connId,
                  });
                  clearInterval(heartbeatInterval);
                  removeSseConnection(connId);
                }
              }, healthCheckIntervalMs);

              // SSE event delivery subscribes directly to the bus rather than going
              // through TransportBridge → IUI pipeline. This is intentional: SSE needs
              // per-connection session filtering that the broadcast-all TransportBridge
              // cannot provide. See Architecture Spec Section 4.2.4 / Design Decision #5.
              const unsubscribe = ctx.bus.onAny((event: AgentEvent) => {
                if (res.writableEnded) return;

                const payload = event.payload as Record<string, unknown> | undefined;
                const eventSessionId = payload?.sessionId as string | undefined;

                // Forward if: event has no sessionId (global) or matches this connection's session
                if (!eventSessionId || eventSessionId === sseConn.sessionId) {
                  sseConn.lastEventId++;
                  res.write(`event: agent_event\nid: ${sseConn.lastEventId}\ndata: ${JSON.stringify(event)}\n\n`);
                }
              });

              // Cleanup on client disconnect
              req.on("close", () => {
                clearInterval(heartbeatInterval);
                unsubscribe();
                removeSseConnection(connId);
              });

              return;
            }

            // POST /api/input — Submit user input
            if (url.pathname === `${basePath}/input` && req.method === "POST") {
              const stop = logger.time("http.request");
              try {
                const body = await readBody(req);
                const { text, requestId, sessionId } = JSON.parse(body);

                // Validate sessionId if provided
                if (sessionId) {
                  const session = ctx.sessions.get(sessionId);
                  if (!session) {
                    logger.warn("Session not found", { sessionId });
                    res.writeHead(404, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Session not found" }));
                    stop();
                    return;
                  }
                }

                const id =
                  requestId ??
                  `http-${Date.now()}-${Math.random().toString(36).slice(2)}`;

                logger.debug("Input received", {
                  requestId: id,
                  sessionId,
                });

                responseBuffer.set(id, {
                  requestId: id,
                  events: [],
                  createdAt: Date.now(),
                  complete: false,
                });

                ctx.pushInput({
                  source: "http",
                  inputType: "user_input",
                  data: text,
                  replyTo: id,
                  sessionId,
                });

                res.writeHead(202, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ status: "accepted", requestId: id }));
              } catch (err) {
                logger.warn("Invalid request body", { error: String(err) });
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid request body" }));
              } finally {
                stop();
              }
              return;
            }

            // GET /api/status — Check agent status
            if (url.pathname === `${basePath}/status` && req.method === "GET") {
              const stop = logger.time("http.request");
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  status: "running",
                  pendingRequests: responseBuffer.size,
                })
              );
              stop();
              return;
            }

            // GET /api/response?requestId=xxx — Poll response
            if (url.pathname === `${basePath}/response` && req.method === "GET") {
              const stop = logger.time("http.request");
              const reqId = url.searchParams.get("requestId");
              const resp = reqId ? responseBuffer.get(reqId) : null;
              if (resp) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    requestId: resp.requestId,
                    events: resp.events,
                    complete: resp.complete,
                    createdAt: resp.createdAt,
                  })
                );
              } else {
                res.writeHead(404, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Not found" }));
              }
              stop();
              return;
            }

            // 404 for unknown routes
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not found" }));
          });

          server.listen(port, host, () => {
            logger.info(`Server listening on http://${host}:${port}${basePath}`);
          });

          startCleanup();
        },

        async stop(): Promise<void> {
          logger.info("Server stopping");
          // Close all SSE connections
          for (const [connId, sseConn] of sseConnections) {
            if (!sseConn.res.writableEnded) {
              sseConn.res.end();
            }
          }
          sseConnections.clear();

          if (cleanupInterval) {
            clearInterval(cleanupInterval);
            cleanupInterval = null;
          }
          if (server) {
            await new Promise<void>((resolve) => server!.close(() => resolve()));
            server = null;
          }
        },
      };

      // ─── HTTP UI (緩衝回應供輪詢) ───
      const ui: IUI = {
        id: "http-webhook-ui",
        name: "HTTP Webhook UI",

        onEvent(event: AgentEvent): void {
          const payload = event.payload as Record<string, unknown> | undefined;
          const replyTo = payload?.replyTo as string | undefined;

          if (replyTo && responseBuffer.has(replyTo)) {
            const resp = responseBuffer.get(replyTo)!;
            resp.events.push(event);
            if (
              event.type === AgentEventType.LOOP_FINISHED ||
              event.type === AgentEventType.LOOP_ERROR
            ) {
              resp.complete = true;
            }
          }
        },
      };

      return {
        listeners: [listener],
        ui: [ui],
        async dispose() {
          await listener.stop?.();
          responseBuffer.clear();
        },
      };
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export default createHttpPlugin;
