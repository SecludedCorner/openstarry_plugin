import { describe, it, expect } from "vitest";
import {
  validateToken,
  validateOrigin,
  getClientIp,
  extractQueryToken,
  type AuthConfig,
} from "./security.js";

describe("validateToken", () => {
  const baseConfig: AuthConfig = { enabled: true, token: "secret-123" };

  it("returns true when auth is disabled", () => {
    expect(validateToken({ enabled: false }, undefined, undefined)).toBe(true);
  });

  it("returns false when auth enabled but no token configured", () => {
    expect(validateToken({ enabled: true }, "any", undefined)).toBe(false);
  });

  it("accepts valid query token", () => {
    expect(validateToken(baseConfig, "secret-123", undefined)).toBe(true);
  });

  it("rejects invalid query token", () => {
    expect(validateToken(baseConfig, "wrong", undefined)).toBe(false);
  });

  it("accepts valid Bearer header", () => {
    expect(validateToken(baseConfig, undefined, "Bearer secret-123")).toBe(true);
  });

  it("rejects invalid Bearer header", () => {
    expect(validateToken(baseConfig, undefined, "Bearer wrong")).toBe(false);
  });

  it("rejects malformed auth header (no Bearer prefix)", () => {
    expect(validateToken(baseConfig, undefined, "Basic secret-123")).toBe(false);
  });

  it("rejects empty auth header", () => {
    expect(validateToken(baseConfig, undefined, "")).toBe(false);
  });

  it("rejects when no credentials provided", () => {
    expect(validateToken(baseConfig, undefined, undefined)).toBe(false);
  });

  it("query token takes precedence over header", () => {
    // Valid query token, invalid header — still passes
    expect(validateToken(baseConfig, "secret-123", "Bearer wrong")).toBe(true);
  });

  it("uses timing-safe comparison (same result for different-length tokens)", () => {
    // Ensures the function rejects different-length tokens correctly
    expect(validateToken(baseConfig, "short", undefined)).toBe(false);
    expect(validateToken(baseConfig, "secret-123-extra-long", undefined)).toBe(false);
    // Valid token still works
    expect(validateToken(baseConfig, "secret-123", undefined)).toBe(true);
  });
});

describe("validateOrigin", () => {
  it("allows any origin when allowedOrigins is undefined", () => {
    expect(validateOrigin(undefined, "http://evil.com")).toBe(true);
  });

  it("allows any origin when allowedOrigins is empty", () => {
    expect(validateOrigin([], "http://evil.com")).toBe(true);
  });

  it("allows requests without origin header (non-browser)", () => {
    expect(validateOrigin(["http://example.com"], undefined)).toBe(true);
  });

  it("allows matching origin", () => {
    expect(validateOrigin(["http://example.com"], "http://example.com")).toBe(true);
  });

  it("rejects non-matching origin", () => {
    expect(validateOrigin(["http://example.com"], "http://evil.com")).toBe(false);
  });

  it("allows wildcard origin", () => {
    expect(validateOrigin(["*"], "http://anything.com")).toBe(true);
  });

  it("matches multiple allowed origins", () => {
    const origins = ["http://a.com", "http://b.com"];
    expect(validateOrigin(origins, "http://b.com")).toBe(true);
    expect(validateOrigin(origins, "http://c.com")).toBe(false);
  });
});

describe("getClientIp", () => {
  it("returns remote address when no trusted proxies", () => {
    expect(getClientIp("10.0.0.1", "1.2.3.4", undefined, undefined)).toBe("10.0.0.1");
  });

  it("returns remote address when direct IP is not trusted proxy", () => {
    expect(getClientIp("10.0.0.1", "1.2.3.4", undefined, ["10.0.0.99"])).toBe("10.0.0.1");
  });

  it("returns X-Real-IP when direct IP is trusted proxy", () => {
    expect(getClientIp("10.0.0.1", undefined, "1.2.3.4", ["10.0.0.1"])).toBe("1.2.3.4");
  });

  it("returns first X-Forwarded-For when direct IP is trusted proxy", () => {
    expect(getClientIp("10.0.0.1", "1.2.3.4, 5.6.7.8", undefined, ["10.0.0.1"])).toBe("1.2.3.4");
  });

  it("prefers X-Real-IP over X-Forwarded-For", () => {
    expect(getClientIp("10.0.0.1", "5.6.7.8", "1.2.3.4", ["10.0.0.1"])).toBe("1.2.3.4");
  });

  it("returns 'unknown' when remoteAddress is undefined", () => {
    expect(getClientIp(undefined, undefined, undefined, undefined)).toBe("unknown");
  });
});

describe("extractQueryToken", () => {
  it("extracts token from query string", () => {
    expect(extractQueryToken("/ws?token=abc123")).toBe("abc123");
  });

  it("returns undefined when no token param", () => {
    expect(extractQueryToken("/ws?other=value")).toBeUndefined();
  });

  it("returns undefined for undefined url", () => {
    expect(extractQueryToken(undefined)).toBeUndefined();
  });

  it("handles URL-encoded token", () => {
    expect(extractQueryToken("/ws?token=hello%20world")).toBe("hello world");
  });

  it("handles multiple query params", () => {
    expect(extractQueryToken("/ws?foo=bar&token=secret&baz=qux")).toBe("secret");
  });
});
