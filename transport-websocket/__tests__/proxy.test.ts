/**
 * Tests for proxy IP resolution in transport-websocket.
 */

import { describe, it, expect } from "vitest";
import { getClientIp, extractQueryToken } from "../src/security.js";

describe("getClientIp", () => {
  it("should return remote address when no trusted proxies", () => {
    const result = getClientIp("192.168.1.100", "10.0.0.1", "10.0.0.2", undefined);
    expect(result).toBe("192.168.1.100");
  });

  it("should ignore proxy headers when no trusted proxies", () => {
    const result = getClientIp(
      "192.168.1.100",
      "10.0.0.1, 10.0.0.2",
      "10.0.0.3",
      []
    );
    expect(result).toBe("192.168.1.100");
  });

  it("should return X-Real-IP when from trusted proxy", () => {
    const result = getClientIp(
      "192.168.1.1",
      undefined,
      "203.0.113.45",
      ["192.168.1.1"]
    );
    expect(result).toBe("203.0.113.45");
  });

  it("should return first hop from X-Forwarded-For when from trusted proxy", () => {
    const result = getClientIp(
      "192.168.1.1",
      "203.0.113.45, 192.168.1.5",
      undefined,
      ["192.168.1.1"]
    );
    expect(result).toBe("203.0.113.45");
  });

  it("should prefer X-Real-IP over X-Forwarded-For", () => {
    const result = getClientIp(
      "192.168.1.1",
      "10.0.0.1, 10.0.0.2",
      "203.0.113.45",
      ["192.168.1.1"]
    );
    expect(result).toBe("203.0.113.45");
  });

  it("should ignore proxy headers when direct connection is not from trusted proxy", () => {
    const result = getClientIp(
      "1.2.3.4",
      "10.0.0.1",
      "10.0.0.2",
      ["192.168.1.1"]
    );
    expect(result).toBe("1.2.3.4");
  });

  it("should handle missing remote address", () => {
    const result = getClientIp(undefined, "10.0.0.1", "10.0.0.2", undefined);
    expect(result).toBe("unknown");
  });

  it("should trim whitespace from X-Forwarded-For", () => {
    const result = getClientIp(
      "192.168.1.1",
      "  203.0.113.45  , 192.168.1.5",
      undefined,
      ["192.168.1.1"]
    );
    expect(result).toBe("203.0.113.45");
  });
});

describe("extractQueryToken", () => {
  it("should extract token from query string", () => {
    const result = extractQueryToken("/ws?token=secret123");
    expect(result).toBe("secret123");
  });

  it("should return undefined when no token in query", () => {
    const result = extractQueryToken("/ws");
    expect(result).toBeUndefined();
  });

  it("should return undefined when url is undefined", () => {
    const result = extractQueryToken(undefined);
    expect(result).toBeUndefined();
  });

  it("should handle multiple query parameters", () => {
    const result = extractQueryToken("/ws?foo=bar&token=secret123&baz=qux");
    expect(result).toBe("secret123");
  });

  it("should handle URL-encoded tokens", () => {
    const result = extractQueryToken("/ws?token=secret%20with%20spaces");
    expect(result).toBe("secret with spaces");
  });

  it("should return undefined for malformed URLs", () => {
    const result = extractQueryToken("not a valid url");
    expect(result).toBeUndefined();
  });
});
