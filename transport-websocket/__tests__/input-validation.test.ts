/**
 * SEC-R2 (Plan46 W0) — transport-websocket inbound JSON schema validation.
 * Exercises the isValidWsMessage type guard that protects the message handler
 * from untrusted network input before destructuring.
 */

import { describe, it, expect } from "vitest";
import { isValidWsMessage } from "../src/index.js";

describe("isValidWsMessage — SEC-R2 schema guard", () => {
  it("rejects null, arrays, primitives", () => {
    expect(isValidWsMessage(null)).toBe(false);
    expect(isValidWsMessage([])).toBe(false);
    expect(isValidWsMessage(42)).toBe(false);
    expect(isValidWsMessage("str")).toBe(false);
  });

  it("rejects objects missing a `type` string", () => {
    expect(isValidWsMessage({})).toBe(false);
    expect(isValidWsMessage({ type: 123 })).toBe(false);
    expect(isValidWsMessage({ type: "" })).toBe(false);
  });

  it("rejects objects where sessionId is present but not a string", () => {
    expect(isValidWsMessage({ type: "user_input", sessionId: 42 })).toBe(false);
  });

  it("accepts valid user_input frames", () => {
    expect(isValidWsMessage({ type: "user_input", payload: { text: "hi" } })).toBe(true);
    expect(isValidWsMessage({ type: "ping" })).toBe(true);
    expect(isValidWsMessage({ type: "user_input", sessionId: "s1" })).toBe(true);
  });

  it("ignores unknown extra fields (forward-compatible)", () => {
    expect(isValidWsMessage({ type: "user_input", extra: true, more: [1, 2] })).toBe(true);
  });
});
