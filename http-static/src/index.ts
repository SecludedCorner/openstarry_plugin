/**
 * @openstarry-plugin/http-static — Static HTTP file server plugin.
 *
 * Provides IUI (色蘊) — serves static files to browser clients.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { createLogger } from "@openstarry/shared";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IUI,
  AgentEvent,
} from "@openstarry/sdk";
import { resolveSafePath } from "./security.js";

export interface HttpStaticConfig {
  host?: string;
  port?: number;
  staticDir: string;
  indexFile?: string;
  directoryListing?: boolean;
  mimeTypes?: Record<string, string>;
}

export const DEFAULT_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};

function getMimeType(
  filePath: string,
  customMimeTypes?: Record<string, string>
): string {
  const ext = extname(filePath).toLowerCase();
  if (customMimeTypes && ext in customMimeTypes) {
    return customMimeTypes[ext];
  }
  return DEFAULT_MIME_TYPES[ext] ?? "application/octet-stream";
}

export function createHttpStaticPlugin(): IPlugin {
  return {
    manifest: {
      name: "http-static",
      version: "0.1.0",
      description: "Static HTTP file server plugin",
      skandha: 'rupa' as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const config = ctx.config as unknown as HttpStaticConfig;
      const host = config.host ?? "0.0.0.0";
      const port = config.port ?? 8081;
      const staticDir = config.staticDir;
      const indexFile = config.indexFile ?? "index.html";
      const mimeTypes = config.mimeTypes;

      if (!staticDir) {
        throw new Error("http-static: staticDir is required in config");
      }

      const logger = createLogger("http-static");
      let server: Server | null = null;

      async function handleRequest(
        req: IncomingMessage,
        res: ServerResponse
      ): Promise<void> {
        const urlPath = req.url ?? "/";

        // Only serve GET and HEAD requests
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end("Method Not Allowed");
          return;
        }

        // Resolve and validate path
        const safePath = resolveSafePath(staticDir, urlPath);
        if (!safePath) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden");
          return;
        }

        try {
          let filePath = safePath;
          const fileStat = await stat(filePath).catch(() => null);

          // If directory, try index file
          if (fileStat?.isDirectory()) {
            filePath = join(filePath, indexFile);
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

          const contentType = getMimeType(filePath, mimeTypes);
          const content = await readFile(filePath);

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

      // IUI — passive (does not render agent events, just serves files)
      const ui: IUI = {
        skandha: 'rupa' as const,
        id: "http-static-ui",
        name: "HTTP Static Server",
        onEvent(_event: AgentEvent): void {
          // Static file server does not render agent events
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
              logger.info(`Static server listening on http://${host}:${port}`);
              resolve();
            });
            server!.once("error", reject);
          });
        },
        async stop(): Promise<void> {
          if (server) {
            await new Promise<void>((resolve) => server!.close(() => resolve()));
            server = null;
            logger.info("Static server stopped");
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

export default createHttpStaticPlugin;
export { resolveSafePath } from "./security.js";
