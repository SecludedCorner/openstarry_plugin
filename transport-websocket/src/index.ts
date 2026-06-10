/**
 * transport-websocket — WebSocket transport plugin.
 *
 * Provides:
 * - WebSocketListener (受蘊) — receives WebSocket messages as input
 * - WebSocketUI (色蘊) — pushes events to WebSocket clients
 *
 * Config:
 *   { port: 8080, host: "0.0.0.0", path: "/ws", healthCheck: { enabled, intervalMs, staleThreshold },
 *     auth: { enabled, token, allowedOrigins, trustedProxies } }
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
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
import {
  type AuthConfig,
  validateToken,
  validateOrigin,
  getClientIp,
  extractQueryToken,
} from "./security.js";
import { WsPushInputAuthenticator, type WsPushInputAuthConfig } from "./pushinput-auth.js";

export type { WsPushInputAuthConfig } from "./pushinput-auth.js";

/** Health check configuration for WebSocket transport. */
interface HealthCheckConfig {
  /** Whether health checks are enabled. Default: true. */
  enabled?: boolean;
  /** Interval in milliseconds between health check pings. Default: 30000. */
  intervalMs?: number;
  /** Number of missed pings before a connection is considered stale. Default: 2. */
  staleThreshold?: number;
}

interface Config {
  port?: number;
  host?: string;
  path?: string;
  healthCheck?: HealthCheckConfig;
  auth?: AuthConfig;
  /** Plan52 Phase C — per-message source attestation (HMAC + nonce + ts). */
  pushInputAuth?: WsPushInputAuthConfig;
}

interface ClientConnection {
  id: string;
  ws: WebSocket;
  connectedAt: number;
  /** Whether the connection responded to the last protocol ping. */
  alive: boolean;
  /** Number of consecutive missed pongs. */
  missedPongs: number;
  /** Session ID bound to this WebSocket connection. */
  sessionId?: string;
}

/**
 * SEC-R2 (Plan46 W0): type guard for inbound WebSocket frames.
 * Fail-closed schema check: `type` must be a non-empty string; `sessionId`
 * (if present) must be a string; payload and other fields are opaque.
 * Exported for unit testing.
 */
export function isValidWsMessage(
  data: unknown,
): data is { type: string; sessionId?: string; payload?: unknown } {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const rec = data as Record<string, unknown>;
  if (typeof rec.type !== "string" || rec.type.length === 0) return false;
  if (rec.sessionId !== undefined && typeof rec.sessionId !== "string") return false;
  return true;
}

// ─── WebSocket UI (色蘊) ───
function createWebSocketUI(
  connections: Map<string, ClientConnection>,
  logger: ReturnType<typeof createLogger>
): IUI {
  return {
    skandha: 'rupa' as const,
    id: "websocket-ui",
    name: "WebSocket UI",

    onEvent(event: AgentEvent): void {
      const message = JSON.stringify({
        type: "agent_event",
        event: {
          type: event.type,
          timestamp: event.timestamp,
          payload: event.payload,
        },
      });

      // 檢查是否為定向回覆
      const payload = event.payload as Record<string, unknown> | undefined;
      const replyTo = payload?.replyTo as string | undefined;
      const sessionId = payload?.sessionId as string | undefined;

      if (replyTo && connections.has(replyTo)) {
        // 定向回覆給特定客戶端
        const conn = connections.get(replyTo)!;
        if (conn.ws.readyState === WebSocket.OPEN) {
          try {
            conn.ws.send(message);
          } catch (err) {
            logger.error("Failed to send to client", {
              clientId: conn.id,
              error: String(err),
            });
          }
        }
      } else if (sessionId) {
        // Session-scoped broadcast: send to all connections in this session
        for (const conn of connections.values()) {
          if (conn.sessionId === sessionId && conn.ws.readyState === WebSocket.OPEN) {
            try {
              conn.ws.send(message);
            } catch (err) {
              logger.error("Failed to send to client", {
                clientId: conn.id,
                error: String(err),
              });
            }
          }
        }
      } else {
        // 廣播給所有連線的客戶端
        for (const conn of connections.values()) {
          if (conn.ws.readyState === WebSocket.OPEN) {
            try {
              conn.ws.send(message);
            } catch (err) {
              logger.error("Failed to send to client", {
                clientId: conn.id,
                error: String(err),
              });
            }
          }
        }
      }
    },
  };
}

// ─── Plugin Export ───
export function createWebSocketPlugin(): IPlugin {
  return {
    manifest: {
      name: "transport-websocket",
      version: "0.1.0-alpha",
      description: "WebSocket transport plugin (Listener + UI)",
      skandha: 'rupa' as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const config = ctx.config as Config;
      const port = config.port ?? 8080;
      const host = config.host ?? "0.0.0.0";
      const path = config.path ?? "/ws";
      const healthCheck = config.healthCheck ?? {};
      const healthCheckEnabled = healthCheck.enabled ?? true;
      const healthCheckIntervalMs = healthCheck.intervalMs ?? 30000;
      const healthCheckStaleThreshold = healthCheck.staleThreshold ?? 2;
      const authConfig: AuthConfig = config.auth ?? { enabled: false };

      const logger = createLogger("transport-ws");
      const connections = new Map<string, ClientConnection>();
      let wss: WebSocketServer | null = null;
      let pingInterval: ReturnType<typeof setInterval> | null = null;
      const pushInputAuth = new WsPushInputAuthenticator(config.pushInputAuth ?? {});

      // ─── Ping All Connections ───
      function pingAll(): void {
        for (const [id, conn] of connections) {
          if (!conn.alive) {
            conn.missedPongs++;
            if (conn.missedPongs >= healthCheckStaleThreshold) {
              // Stale connection — terminate after threshold missed pongs
              logger.info("Terminating stale connection", {
                clientId: id,
                missedPongs: conn.missedPongs,
              });
              conn.ws.terminate();
              connections.delete(id);
              // Destroy session if no other connection shares it
              if (conn.sessionId) {
                const hasOtherConn = Array.from(connections.values()).some(
                  (c) => c.sessionId === conn.sessionId
                );
                if (!hasOtherConn) {
                  logger.debug("Session destroyed (last connection)", {
                    sessionId: conn.sessionId,
                  });
                  ctx.sessions.destroy(conn.sessionId);
                }
              }
              continue;
            }
          } else {
            conn.missedPongs = 0;
          }
          conn.alive = false;
          conn.ws.ping();
        }
      }

      const listener: IListener = {
        skandha: 'rupa' as const,
        id: "websocket-listener",
        name: "WebSocket Listener",

        async start(): Promise<void> {
          wss = new WebSocketServer({ port, host, path });

          wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
            // ─── Auth validation ───
            if (authConfig.enabled) {
              const queryToken = extractQueryToken(req.url);
              const authHeader = req.headers["authorization"] as string | undefined;
              if (!validateToken(authConfig, queryToken, authHeader)) {
                logger.warn("Auth rejected", { url: req.url });
                ws.close(4401, "Unauthorized");
                return;
              }

              const origin = req.headers["origin"] as string | undefined;
              if (!validateOrigin(authConfig.allowedOrigins, origin)) {
                logger.warn("Origin rejected", { origin });
                ws.close(4403, "Forbidden origin");
                return;
              }
            }

            const clientIp = getClientIp(
              req.socket.remoteAddress,
              req.headers["x-forwarded-for"] as string | undefined,
              req.headers["x-real-ip"] as string | undefined,
              authConfig.trustedProxies,
            );

            const clientId = `ws-${randomUUID()}`;

            // Create a new session for this connection
            const session = ctx.sessions.create();
            const sessionId = session.id;

            const conn: ClientConnection = {
              id: clientId,
              ws,
              connectedAt: Date.now(),
              alive: true,
              missedPongs: 0,
              sessionId,
            };
            connections.set(clientId, conn);

            logger.debug("Client connected", { clientId, sessionId, clientIp });

            // 發送歡迎訊息 (with sessionId)
            try {
              ws.send(
                JSON.stringify({
                  type: "connected",
                  clientId,
                  sessionId,
                  message: "Connected to OpenStarry Agent",
                })
              );
            } catch (err) {
              logger.error("Failed to send welcome message", {
                clientId,
                error: String(err),
              });
            }

            // Protocol-level pong handler
            ws.on("pong", () => {
              conn.alive = true;
            });

            ws.on("message", async (data: Buffer | string) => {
              const stop = logger.time("ws.message");
              try {
                const parsed: unknown = JSON.parse(data.toString());

                // SEC-R2 (Plan46 W0): fail-closed schema validation before
                // any destructuring of untrusted network input.
                if (!isValidWsMessage(parsed)) {
                  logger.warn("Rejected malformed WS frame", { clientId });
                  try {
                    ws.send(JSON.stringify({ type: "error", error: "Invalid message" }));
                  } catch (sendErr) {
                    logger.error("Failed to send error response", {
                      clientId,
                      error: String(sendErr),
                    });
                  }
                  return;
                }
                const msg = parsed;

                // Optional session resume: if client specifies a sessionId, rebind
                if (msg.sessionId && msg.sessionId !== conn.sessionId) {
                  const existing = ctx.sessions.get(msg.sessionId);
                  if (existing) {
                    const oldSessionId = conn.sessionId;
                    conn.sessionId = existing.id;
                    // Destroy orphaned old session if no other connection references it
                    if (oldSessionId) {
                      const hasOtherConn = Array.from(connections.values()).some(
                        (c) => c.sessionId === oldSessionId
                      );
                      if (!hasOtherConn) {
                        logger.debug("Orphaned session destroyed", { oldSessionId });
                        ctx.sessions.destroy(oldSessionId);
                      }
                    }
                  }
                }

                if (msg.type === "user_input") {
                  const payload = (msg.payload ?? {}) as { text?: unknown; auth?: unknown };
                  const text = typeof payload.text === "string" ? payload.text : "";
                  // Plan52 Phase C — verify per-message source attestation.
                  // When auth is disabled (default), returns frozen-empty
                  // sourceContext and the field is omitted (legacy behavior).
                  const authEnvelope = (payload.auth && typeof payload.auth === "object")
                    ? payload.auth as Record<string, unknown>
                    : {};
                  const authResult = await pushInputAuth.verifyMessage({
                    kid: typeof authEnvelope.kid === "string" ? authEnvelope.kid : undefined,
                    nonce: typeof authEnvelope.nonce === "string" ? authEnvelope.nonce : undefined,
                    ts: typeof authEnvelope.ts === "number" ? authEnvelope.ts : undefined,
                    tokenSig: typeof authEnvelope.tokenSig === "string" ? authEnvelope.tokenSig : undefined,
                  }, clientId);
                  if (!authResult.ok) {
                    try {
                      ws.send(JSON.stringify({ type: "auth_rejected", error: authResult.error }));
                    } catch (sendErr) {
                      logger.error("Failed to send auth_rejected", { clientId, error: String(sendErr) });
                    }
                    return;
                  }
                  const sourceContextKeys = Object.keys(authResult.sourceContext);
                  ctx.pushInput({
                    source: "websocket",
                    inputType: "user_input",
                    data: text,
                    replyTo: clientId,
                    sessionId: conn.sessionId,
                    ...(sourceContextKeys.length > 0 ? { sourceContext: authResult.sourceContext } : {}),
                  });
                } else if (msg.type === "ping") {
                  try {
                    ws.send(
                      JSON.stringify({ type: "pong", timestamp: Date.now() })
                    );
                  } catch (err) {
                    logger.error("Failed to send pong", {
                      clientId,
                      error: String(err),
                    });
                  }
                }
              } catch (err) {
                logger.warn("Invalid JSON from client", { clientId });
                try {
                  ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
                } catch (sendErr) {
                  logger.error("Failed to send error response", {
                    clientId,
                    error: String(sendErr),
                  });
                }
              } finally {
                stop();
              }
            });

            ws.on("close", () => {
              logger.debug("Client disconnected", {
                clientId,
                sessionId: conn.sessionId,
              });
              connections.delete(clientId);
              // Destroy session if no other connection shares it
              if (conn.sessionId) {
                const hasOtherConn = Array.from(connections.values()).some(
                  (c) => c.sessionId === conn.sessionId
                );
                if (!hasOtherConn) {
                  logger.debug("Session destroyed (last connection)", {
                    sessionId: conn.sessionId,
                  });
                  ctx.sessions.destroy(conn.sessionId);
                }
              }
            });

            ws.on("error", (err) => {
              logger.warn("Client connection error", {
                clientId,
                error: String(err),
              });
              connections.delete(clientId);
              // Destroy session if no other connection shares it
              if (conn.sessionId) {
                const hasOtherConn = Array.from(connections.values()).some(
                  (c) => c.sessionId === conn.sessionId
                );
                if (!hasOtherConn) {
                  logger.debug("Session destroyed (last connection)", {
                    sessionId: conn.sessionId,
                  });
                  ctx.sessions.destroy(conn.sessionId);
                }
              }
            });
          });

          // Start health check ping interval
          if (healthCheckEnabled) {
            pingInterval = setInterval(pingAll, healthCheckIntervalMs);
          }

          logger.info(`Server listening on ws://${host}:${port}${path}`);
        },

        async stop(): Promise<void> {
          logger.info("Server shutting down");
          // Clear ping interval
          if (pingInterval) {
            clearInterval(pingInterval);
            pingInterval = null;
          }

          if (wss) {
            for (const conn of connections.values()) {
              conn.ws.close(1001, "Server shutting down");
            }
            connections.clear();
            await new Promise<void>((resolve) => wss!.close(() => resolve()));
            wss = null;
          }
        },
      };

      return {
        listeners: [listener],
        ui: [createWebSocketUI(connections, logger)],
        async dispose() {
          await listener.stop?.();
        },
      };
    },
  };
}

export default createWebSocketPlugin;
export type { AuthConfig } from "./security.js";
export { validateToken, validateOrigin, getClientIp, extractQueryToken } from "./security.js";
