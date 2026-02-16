/**
 * Tests for @openstarry-plugin/http-static
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHttpStaticPlugin } from "../src/index.js";
import type { IPluginContext, PluginHooks } from "@openstarry/sdk";

describe("http-static plugin", () => {
  let tempDir: string;
  let hooks: PluginHooks;
  let baseUrl: string;

  beforeEach(async () => {
    // Create temp directory with test files
    tempDir = await mkdtemp(join(tmpdir(), "http-static-test-"));

    await writeFile(join(tempDir, "index.html"), "<html><body>Index</body></html>");
    await writeFile(join(tempDir, "styles.css"), "body { margin: 0; }");
    await writeFile(join(tempDir, "app.js"), 'console.log("test");');
    await writeFile(join(tempDir, "data.json"), '{"test": true}');
    await writeFile(join(tempDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Create subdirectory
    await mkdir(join(tempDir, "subdir"));
    await writeFile(join(tempDir, "subdir", "page.html"), "<html>Sub</html>");

    const plugin = createHttpStaticPlugin();
    const port = 9001;
    baseUrl = `http://127.0.0.1:${port}`;

    const mockContext: IPluginContext = {
      config: {
        host: "127.0.0.1",
        port,
        staticDir: tempDir,
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
    const plugin = createHttpStaticPlugin();
    expect(plugin.manifest.name).toBe("http-static");
    expect(plugin.manifest.version).toBe("0.1.0");
  });

  it("should start server on configured port", async () => {
    const res = await fetch(`${baseUrl}/index.html`);
    expect(res.status).toBe(200);
  });

  it("should serve HTML with correct MIME type", async () => {
    const res = await fetch(`${baseUrl}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("Index");
  });

  it("should serve CSS with correct MIME type", async () => {
    const res = await fetch(`${baseUrl}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/css");
  });

  it("should serve JS with correct MIME type", async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
  });

  it("should serve JSON with correct MIME type", async () => {
    const res = await fetch(`${baseUrl}/data.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("should serve PNG with correct MIME type", async () => {
    const res = await fetch(`${baseUrl}/image.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
  });

  it("should return 404 for missing files", async () => {
    const res = await fetch(`${baseUrl}/nonexistent.html`);
    expect(res.status).toBe(404);
  });

  it("should return 404 for path traversal attempts (HTTP client normalizes ..)", async () => {
    // Note: fetch() normalizes /../ before sending, so the request arrives as /etc/passwd
    // which is resolved safely within docRoot but doesn't exist -> 404
    const res = await fetch(`${baseUrl}/../etc/passwd`);
    expect(res.status).toBe(404);
  });

  it("should return 405 for non-GET methods", async () => {
    const res = await fetch(`${baseUrl}/index.html`, { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("should serve index.html for directory requests", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Index");
  });

  it("should support HEAD requests", async () => {
    const res = await fetch(`${baseUrl}/index.html`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toBe(""); // No body for HEAD
  });

  it("should serve files from subdirectories", async () => {
    const res = await fetch(`${baseUrl}/subdir/page.html`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Sub");
  });
});
