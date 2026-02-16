/**
 * Tests for @openstarry-plugin/web-ui
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWebUIPlugin } from "../src/index.js";
import type { IPluginContext, PluginHooks } from "@openstarry/sdk";

describe("web-ui plugin", () => {
  let hooks: PluginHooks;
  let baseUrl: string;

  beforeEach(async () => {
    const plugin = createWebUIPlugin();
    const port = 9002;
    baseUrl = `http://127.0.0.1:${port}`;

    const mockContext: IPluginContext = {
      config: {
        host: "127.0.0.1",
        port,
        websocketUrl: "ws://localhost:8080/ws",
        title: "Test Agent",
      },
      pushInput: () => {},
      sessions: {} as any,
    };

    hooks = await plugin.factory(mockContext);

    // Start server
    if (hooks.ui?.[0]?.start) {
      await hooks.ui[0].start();
    }
  });

  afterEach(async () => {
    // Stop server
    if (hooks.dispose) {
      await hooks.dispose();
    }
  });

  it("should have correct manifest", () => {
    const plugin = createWebUIPlugin();
    expect(plugin.manifest.name).toBe("web-ui");
    expect(plugin.manifest.version).toBe("0.1.0");
  });

  it("should start server on configured port", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
  });

  it("should serve index.html at root", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("<!DOCTYPE html>");
    expect(text).toContain("OpenStarry Agent");
  });

  it("should inject config into HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    const text = await res.text();
    expect(text).toContain("window.__OPENSTARRY_CONFIG__");
    expect(text).toContain("ws://localhost:8080/ws");
    expect(text).toContain("Test Agent");
  });

  it("should serve styles.css with correct MIME type", async () => {
    const res = await fetch(`${baseUrl}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
    const text = await res.text();
    expect(text).toContain("body");
  });

  it("should serve app.js with correct MIME type", async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it("should return 404 for unknown files", async () => {
    const res = await fetch(`${baseUrl}/nonexistent.html`);
    expect(res.status).toBe(404);
  });

  it("should handle path traversal attempts (HTTP client normalizes ..)", async () => {
    // Note: fetch() normalizes /../ before sending, so the request arrives as /etc/passwd
    // which is resolved safely within docRoot but doesn't exist -> 404
    const res = await fetch(`${baseUrl}/../etc/passwd`);
    expect(res.status).toBe(404);
  });

  it("should support HEAD requests", async () => {
    const res = await fetch(`${baseUrl}/index.html`, { method: "HEAD" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(""); // No body for HEAD
  });
});
