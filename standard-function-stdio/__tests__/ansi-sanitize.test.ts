/**
 * DT-42-D (cycle 03-43) — standard-function-stdio ANSI escape sanitization.
 *
 * Per cycle 03-42 R1 §D §14 reconciliation: closes FIX-CY40-ansi-sanitize LOW-MED
 * ZT-3 加嚴 finding (cycle 03-39 §A1.4-07; 2-cycle dormancy at cycle 03-41 close).
 *
 * stripAnsiEscapes is applied to TOOL_RESULT and TOOL_ERROR payload text so
 * downstream consumers (log aggregators, terminal-naive parsers) do not see
 * raw ANSI sequences emitted by colorized tools (git diff, npm, etc.).
 */

import { describe, expect, it } from "vitest";
import { stripAnsiEscapes } from "../src/index.js";

describe("stripAnsiEscapes — ANSI escape sanitization (DT-42-D)", () => {
  it("removes basic CSI color codes", () => {
    expect(stripAnsiEscapes("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes bold + color + reset combinations", () => {
    expect(stripAnsiEscapes("\x1b[1;31mBOLD RED\x1b[0m text")).toBe("BOLD RED text");
  });

  it("preserves plain text unchanged", () => {
    expect(stripAnsiEscapes("plain text with no escapes")).toBe("plain text with no escapes");
  });

  it("removes multi-line colorized output (e.g. git diff)", () => {
    const input = "\x1b[32m+added line\x1b[0m\n\x1b[31m-removed line\x1b[0m";
    expect(stripAnsiEscapes(input)).toBe("+added line\n-removed line");
  });

  it("removes OSC sequences (e.g. hyperlinks / titles)", () => {
    expect(stripAnsiEscapes("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe("link");
  });

  it("removes 2-char ESC sequences (e.g. ESC c reset)", () => {
    expect(stripAnsiEscapes("before\x1bcafter")).toBe("beforeafter");
  });

  it("handles empty string", () => {
    expect(stripAnsiEscapes("")).toBe("");
  });

  it("removes nested / repeated escapes without leaving fragments", () => {
    const input = "\x1b[1m\x1b[31mERROR\x1b[0m\x1b[0m: file not found";
    expect(stripAnsiEscapes(input)).toBe("ERROR: file not found");
  });

  it("does NOT strip non-ESC backslash sequences (\\n / \\t / \\x07)", () => {
    expect(stripAnsiEscapes("line1\nline2\ttabbed")).toBe("line1\nline2\ttabbed");
  });
});
