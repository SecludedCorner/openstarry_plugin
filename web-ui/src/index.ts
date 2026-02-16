/**
 * @openstarry-plugin/web-ui — Browser-based agent interface.
 *
 * Provides IUI (色蘊) — serves a web frontend that connects to
 * the transport-websocket plugin for real-time agent interaction.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, relative, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@openstarry/shared";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IUI,
  AgentEvent,
} from "@openstarry/sdk";

export interface WebUIConfig {
  port?: number;
  host?: string;
  websocketUrl?: string;
  title?: string;
  customCss?: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function resolveSafePath(docRoot: string, requestedPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    return null;
  }
  const pathOnly = decoded.split("?")[0].split("#")[0];
  if (pathOnly.includes("\0")) return null;
  const normalized = normalize(pathOnly);
  const resolved = resolve(docRoot, "." + normalized);
  const rel = relative(docRoot, resolved);
  if (rel.startsWith("..") || resolve(docRoot, rel) !== resolved) return null;
  return resolved;
}

export function createWebUIPlugin(): IPlugin {
  return {
    manifest: {
      name: "web-ui",
      version: "0.1.0",
      description: "Browser-based agent interface",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const config = ctx.config as WebUIConfig;
      const host = config.host ?? "0.0.0.0";
      const port = config.port ?? 8081;
      const websocketUrl = config.websocketUrl ?? "ws://localhost:8080/ws";
      const title = config.title ?? "OpenStarry Agent";

      const logger = createLogger("web-ui");

      // Resolve static directory relative to this module
      const thisDir = typeof __dirname !== "undefined"
        ? __dirname
        : fileURLToPath(new URL(".", import.meta.url));
      const staticDir = join(thisDir, "static");

      let server: Server | null = null;

      // Inject config into HTML at serve time
      function injectConfig(html: string): string {
        const configScript = `<script>window.__OPENSTARRY_CONFIG__=${JSON.stringify({
          websocketUrl,
          title,
        })};</script>`;
        return html.replace("</head>", `${configScript}\n</head>`);
      }

      async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end("Method Not Allowed");
          return;
        }

        const urlPath = req.url ?? "/";
        const safePath = resolveSafePath(staticDir, urlPath);
        if (!safePath) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }

        try {
          let filePath = safePath;
          const fileStat = await stat(filePath).catch(() => null);

          if (fileStat?.isDirectory()) {
            filePath = join(filePath, "index.html");
            const indexStat = await stat(filePath).catch(() => null);
            if (!indexStat?.isFile()) {
              res.writeHead(404, { "Content-Type": "text/plain" });
              res.end("Not Found");
              return;
            }
          } else if (!fileStat?.isFile()) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
            return;
          }

          const ext = extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          let content = await readFile(filePath);

          // Inject WebSocket config into HTML files
          if (ext === ".html") {
            const html = injectConfig(content.toString("utf-8"));
            content = Buffer.from(html, "utf-8");
          }

          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": content.length,
          });
          if (req.method === "HEAD") {
            res.end();
          } else {
            res.end(content);
          }
        } catch (err) {
          logger.error("Error serving file", { path: urlPath, error: String(err) });
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Internal Server Error");
        }
      }

      const ui: IUI = {
        id: "web-ui",
        name: "Web UI",
        onEvent(_event: AgentEvent): void {
          // Events are delivered to browsers via transport-websocket, not http-static
        },
        async start(): Promise<void> {
          server = createServer((req, res) => {
            handleRequest(req, res).catch((err) => {
              logger.error("Unhandled request error", { error: String(err) });
              if (!res.headersSent) {
                res.writeHead(500, { "Content-Type": "text/plain" });
                res.end("Internal Server Error");
              }
            });
          });

          await new Promise<void>((resolve, reject) => {
            server!.listen(port, host, () => {
              logger.info(`Web UI available at http://${host}:${port}`);
              resolve();
            });
            server!.once("error", reject);
          });
        },
        async stop(): Promise<void> {
          if (server) {
            await new Promise<void>((resolve) => server!.close(() => resolve()));
            server = null;
            logger.info("Web UI server stopped");
          }
        },
      };

      return {
        ui: [ui],
        async dispose() {
          await ui.stop?.();
        },
      };
    },
  };
}

export default createWebUIPlugin;
