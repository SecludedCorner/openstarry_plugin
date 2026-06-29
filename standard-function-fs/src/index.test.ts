/**
 * Tests for standard-function-fs — the filesystem ITool plugin (samskara).
 * Shipped with zero test coverage (v0.59.7 audit). Focus: the path-validation
 * SECURITY boundary (reject outside allowedPaths) + a real read/write/list/
 * mkdir/delete round-trip in a temp sandbox.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, symlinkSync } from "node:fs";
import type { ITool, ToolContext } from "@openstarry/sdk";
import { SecurityError } from "@openstarry/sdk";
import createFsPlugin from "./index.js";

function toolMap(tools: ITool<unknown>[]): Record<string, ITool<any>> {
  return Object.fromEntries(tools.map((t) => [t.id, t]));
}

describe("standard-function-fs", () => {
  let sandbox: string;
  let tools: Record<string, ITool<any>>;
  let ctx: ToolContext;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "fs-plugin-test-"));
    const plugin = createFsPlugin();
    const hooks = await plugin.factory({} as never);
    tools = toolMap(hooks.tools as ITool<unknown>[]);
    ctx = { workingDirectory: sandbox, allowedPaths: [sandbox] } as ToolContext;
  });

  afterEach(() => {
    if (existsSync(sandbox)) rmSync(sandbox, { recursive: true, force: true });
  });

  it("exposes the 5 fs tools", () => {
    expect(Object.keys(tools).sort()).toEqual(
      ["fs.delete", "fs.list", "fs.mkdir", "fs.read", "fs.write"].sort(),
    );
    for (const t of Object.values(tools)) expect(t.skandha).toBe("samskara");
  });

  it("write → read round-trip within the sandbox", async () => {
    await tools["fs.write"].execute({ path: "hello.txt", content: "hi there" }, ctx);
    const content = await tools["fs.read"].execute({ path: "hello.txt" }, ctx);
    expect(content).toBe("hi there");
  });

  it("mkdir + list reflects created entries", async () => {
    await tools["fs.mkdir"].execute({ path: "sub" }, ctx);
    await tools["fs.write"].execute({ path: "sub/a.txt", content: "x" }, ctx);
    const listing = await tools["fs.list"].execute({ path: "sub" }, ctx);
    expect(listing).toContain("a.txt");
  });

  it("delete removes a file", async () => {
    await tools["fs.write"].execute({ path: "gone.txt", content: "x" }, ctx);
    expect(existsSync(join(sandbox, "gone.txt"))).toBe(true);
    await tools["fs.delete"].execute({ path: "gone.txt" }, ctx);
    expect(existsSync(join(sandbox, "gone.txt"))).toBe(false);
  });

  it("SECURITY: rejects read outside allowedPaths with SecurityError", async () => {
    const outside = mkdtempSync(join(tmpdir(), "fs-outside-"));
    writeFileSync(join(outside, "secret.txt"), "top secret");
    try {
      await expect(
        tools["fs.read"].execute({ path: join(outside, "secret.txt") }, ctx),
      ).rejects.toBeInstanceOf(SecurityError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("SECURITY: rejects path-traversal escape (../) with SecurityError", async () => {
    await expect(
      tools["fs.write"].execute(
        { path: "../escape.txt", content: "nope" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(SecurityError);
  });

  it("SECURITY: rejects write outside allowedPaths", async () => {
    await expect(
      tools["fs.write"].execute(
        { path: join(tmpdir(), "elsewhere.txt"), content: "nope" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(SecurityError);
  });
});

// v0.59.9 PathGuard-live: the lexical resolve+normalize check could NOT catch a
// symlink placed INSIDE an allowed dir that targets OUTSIDE it. The shared
// realpath jail follows symlinks on both target and roots, so it does. This drives
// the REAL plugin tool with allowedPaths exactly as the live loop supplies them.
describe("standard-function-fs — symlink-escape jail (v0.59.9)", () => {
  let sandbox: string;
  let outside: string;
  let tools: Record<string, ITool<any>>;
  let ctx: ToolContext;

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "fs-jail-"));
    outside = mkdtempSync(join(tmpdir(), "fs-jail-outside-"));
    mkdirSync(join(sandbox, "data"));
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
    // symlink INSIDE the allowed dir pointing OUTSIDE it. 'junction' needs no
    // admin/Developer-Mode on Windows and targets a directory (cross-platform: on
    // non-Windows the type arg is ignored and a normal dir symlink is created).
    symlinkSync(outside, join(sandbox, "data", "escape"), "junction");
    const hooks = await createFsPlugin().factory({} as never);
    tools = toolMap(hooks.tools as ITool<unknown>[]);
    ctx = { workingDirectory: sandbox, allowedPaths: [sandbox] } as ToolContext;
  });

  afterEach(() => {
    for (const d of [sandbox, outside]) {
      try { if (existsSync(d)) rmSync(d, { recursive: true, force: true }); } catch { /* win32 best-effort */ }
    }
  });

  it("rejects READ through an in-jail symlink that targets outside", async () => {
    await expect(
      tools["fs.read"].execute({ path: "data/escape/secret.txt" }, ctx),
    ).rejects.toBeInstanceOf(SecurityError);
  });

  it("rejects WRITE through an in-jail symlink that targets outside", async () => {
    await expect(
      tools["fs.write"].execute({ path: "data/escape/pwn.txt", content: "x" }, ctx),
    ).rejects.toBeInstanceOf(SecurityError);
    expect(existsSync(join(outside, "pwn.txt"))).toBe(false);
  });

  it("CONTROL: still allows a new-file write to a real (non-symlink) path in the jail", async () => {
    await tools["fs.write"].execute({ path: "data/fresh.txt", content: "ok" }, ctx);
    expect(existsSync(join(sandbox, "data", "fresh.txt"))).toBe(true);
    await expect(
      tools["fs.read"].execute({ path: "data/fresh.txt" }, ctx),
    ).resolves.toBe("ok");
  });
});
