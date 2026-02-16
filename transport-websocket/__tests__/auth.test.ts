/**
 * Tests for transport-websocket auth validation.
 */

import { describe, it, expect } from "vitest";
import { validateToken, validateOrigin } from "../src/security.js";
import type { AuthConfig } from "../src/security.js";

describe("validateToken", () => {
  it("should return true when auth is disabled", () => {
    const config: AuthConfig = { enabled: false };
    const result = validateToken(config, undefined, undefined);
    expect(result).toBe(true);
  });

  it("should return true when query token matches", () => {
    const config: AuthConfig = { enabled: true, token: "secret123" };
    const result = validateToken(config, "secret123", undefined);
    expect(result).toBe(true);
  });

  it("should return false when query token mismatches", () => {
    const config: AuthConfig = { enabled: true, token: "secret123" };
    const result = validateToken(config, "wrong", undefined);
    expect(result).toBe(false);
  });

  it("should return true when Bearer header matches", () => {
    const config: AuthConfig = { enabled: true, token: "secret123" };
    const result = validateToken(config, undefined, "Bearer secret123");
    expect(result).toBe(true);
  });

  it("should return false when Bearer header mismatches", () => {
    const config: AuthConfig = { enabled: true, token: "secret123" };
    const result = validateToken(config, undefined, "Bearer wrong");
    expect(result).toBe(false);
  });

  it("should return false when no token is configured but auth is enabled", () => {
    const config: AuthConfig = { enabled: true };
    const result = validateToken(config, undefined, undefined);
    expect(result).toBe(false);
  });

  it("should read token from env var OPENSTARRY_WS_TOKEN", () => {
    const originalEnv = process.env.OPENSTARRY_WS_TOKEN;
    process.env.OPENSTARRY_WS_TOKEN = "env_token";

    const config: AuthConfig = { enabled: true };
    const result = validateToken(config, "env_token", undefined);
    expect(result).toBe(true);

    // Cleanup
    if (originalEnv !== undefined) {
      process.env.OPENSTARRY_WS_TOKEN = originalEnv;
    } else {
      delete process.env.OPENSTARRY_WS_TOKEN;
    }
  });

  it("should prefer config token over env var", () => {
    const originalEnv = process.env.OPENSTARRY_WS_TOKEN;
    process.env.OPENSTARRY_WS_TOKEN = "env_token";

    const config: AuthConfig = { enabled: true, token: "config_token" };
    const result = validateToken(config, "config_token", undefined);
    expect(result).toBe(true);

    const wrongResult = validateToken(config, "env_token", undefined);
    expect(wrongResult).toBe(false);

    // Cleanup
    if (originalEnv !== undefined) {
      process.env.OPENSTARRY_WS_TOKEN = originalEnv;
    } else {
      delete process.env.OPENSTARRY_WS_TOKEN;
    }
  });

  it("should return false for malformed Bearer header", () => {
    const config: AuthConfig = { enabled: true, token: "secret123" };
    const result = validateToken(config, undefined, "secret123");
    expect(result).toBe(false);
  });
});

describe("validateOrigin", () => {
  it("should return true when no allowedOrigins configured", () => {
    const result = validateOrigin(undefined, "http://example.com");
    expect(result).toBe(true);
  });

  it("should return true when allowedOrigins is empty array", () => {
    const result = validateOrigin([], "http://example.com");
    expect(result).toBe(true);
  });

  it("should return true when origin matches", () => {
    const result = validateOrigin(
      ["http://localhost:3000"],
      "http://localhost:3000"
    );
    expect(result).toBe(true);
  });

  it("should return false when origin mismatches", () => {
    const result = validateOrigin(
      ["http://localhost:3000"],
      "http://evil.com"
    );
    expect(result).toBe(false);
  });

  it("should return true for wildcard origin", () => {
    const result = validateOrigin(["*"], "http://any.com");
    expect(result).toBe(true);
  });

  it("should return true when no origin header is present", () => {
    const result = validateOrigin(["http://localhost:3000"], undefined);
    expect(result).toBe(true);
  });

  it("should support multiple allowed origins", () => {
    const allowed = ["http://localhost:3000", "http://localhost:8080"];
    expect(validateOrigin(allowed, "http://localhost:3000")).toBe(true);
    expect(validateOrigin(allowed, "http://localhost:8080")).toBe(true);
    expect(validateOrigin(allowed, "http://evil.com")).toBe(false);
  });
});
