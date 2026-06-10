/**
 * Tests for path traversal prevention in http-static.
 */

import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import { resolveSafePath } from "../src/security.js";

describe("resolveSafePath", () => {
  const docRoot = "/var/www";
  const resolvedDocRoot = resolve(docRoot);

  it("should resolve normal paths correctly", () => {
    const result = resolveSafePath(docRoot, "/index.html");
    expect(result).toBe(join(resolvedDocRoot, "index.html"));
  });

  it("should resolve nested paths correctly", () => {
    const result = resolveSafePath(docRoot, "/assets/styles.css");
    expect(result).toBe(join(resolvedDocRoot, "assets", "styles.css"));
  });

  it("should resolve ../ at root level within docRoot (normalize clamps to root)", () => {
    // /../etc/passwd normalizes to /etc/passwd -> resolve(docRoot, "./etc/passwd") = docRoot/etc/passwd
    // This is inside docRoot, so it's safe (path traversal was neutralized by normalize)
    const result = resolveSafePath(docRoot, "/../etc/passwd");
    expect(result).toBe(join(resolvedDocRoot, "etc", "passwd"));
  });

  it("should resolve encoded ../ at root level within docRoot", () => {
    const result = resolveSafePath(docRoot, "/%2e%2e/etc/passwd");
    expect(result).toBe(join(resolvedDocRoot, "etc", "passwd"));
  });

  it("should reject paths with null bytes", () => {
    const result = resolveSafePath(docRoot, "/index.html\0.txt");
    expect(result).toBeNull();
  });

  it("should strip query strings", () => {
    const result = resolveSafePath(docRoot, "/index.html?foo=bar");
    expect(result).toBe(join(resolvedDocRoot, "index.html"));
  });

  it("should strip hash fragments", () => {
    const result = resolveSafePath(docRoot, "/index.html#section");
    expect(result).toBe(join(resolvedDocRoot, "index.html"));
  });

  it("should resolve paths with embedded ../ that stay within root", () => {
    // /var/www/../../etc/passwd normalizes to /etc/passwd -> resolve(docRoot, "./etc/passwd") = docRoot/etc/passwd
    const result = resolveSafePath(docRoot, "/var/www/../../etc/passwd");
    expect(result).toBe(join(resolvedDocRoot, "etc", "passwd"));
  });

  it("should resolve root path correctly", () => {
    const result = resolveSafePath(docRoot, "/");
    expect(result).toBe(resolvedDocRoot);
  });

  it("should handle malformed URI encoding", () => {
    const result = resolveSafePath(docRoot, "/%");
    expect(result).toBeNull();
  });
});
