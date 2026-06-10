import { describe, it, expect } from "vitest";
import {
  truncate,
  formatTimestamp,
  statusSymbol,
  messagePrefix,
} from "../utils/format.js";

describe("truncate", () => {
  it("returns the string unchanged when within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the string unchanged when exactly at limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends '...' when over limit", () => {
    expect(truncate("hello world", 5)).toBe("hello...");
  });

  it("handles empty strings", () => {
    expect(truncate("", 10)).toBe("");
  });
});

describe("formatTimestamp", () => {
  it("formats a timestamp to HH:MM:SS", () => {
    // 2025-01-15T12:30:45.000Z
    const ts = new Date(2025, 0, 15, 12, 30, 45).getTime();
    expect(formatTimestamp(ts)).toBe("12:30:45");
  });

  it("pads single-digit values with zeros", () => {
    const ts = new Date(2025, 0, 1, 1, 2, 3).getTime();
    expect(formatTimestamp(ts)).toBe("01:02:03");
  });
});

describe("statusSymbol", () => {
  it("returns [RUN] for running", () => {
    expect(statusSymbol("running")).toBe("[RUN]");
  });

  it("returns [OFF] for stopped", () => {
    expect(statusSymbol("stopped")).toBe("[OFF]");
  });

  it("returns [ERR] for error", () => {
    expect(statusSymbol("error")).toBe("[ERR]");
  });
});

describe("messagePrefix", () => {
  it("returns '> ' for user", () => {
    expect(messagePrefix("user")).toBe("> ");
  });

  it("returns empty string for assistant", () => {
    expect(messagePrefix("assistant")).toBe("");
  });

  it("returns '[tool] ' for tool-call", () => {
    expect(messagePrefix("tool-call")).toBe("[tool] ");
  });

  it("returns '[result] ' for tool-result", () => {
    expect(messagePrefix("tool-result")).toBe("[result] ");
  });

  it("returns '[error] ' for error", () => {
    expect(messagePrefix("error")).toBe("[error] ");
  });

  it("returns '[system] ' for system", () => {
    expect(messagePrefix("system")).toBe("[system] ");
  });
});
