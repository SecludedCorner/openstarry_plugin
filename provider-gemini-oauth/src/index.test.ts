/**
 * Tests for provider-gemini-oauth pure helpers — the 1160-line provider shipped
 * with ZERO test coverage (v0.59.7 audit). The OAuth flow + streaming need live
 * Google endpoints (integration-only), but the deterministic units — message
 * conversion (OpenStarry Message[] → Gemini contents), PKCE challenge, project
 * provisioning metadata, and the model catalog — are tested here via __testables.
 *
 * Honest boundary: this covers the pure transformation/crypto helpers, NOT the
 * OAuth browser flow, token refresh, or SSE streaming (those remain integration-
 * only and are not asserted here).
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import type { Message } from "@openstarry/sdk";
import { __testables } from "./index.js";
import createGeminiOAuthPlugin from "./index.js";

const { convertMessages, generateCodeVerifier, generateCodeChallenge, buildMetadata, MODELS } =
  __testables;

let seq = 0;
function userMsg(text: string): Message {
  seq += 1;
  return { id: `u${seq}`, role: "user", content: [{ type: "text", text }], createdAt: seq };
}

describe("provider-gemini-oauth: convertMessages", () => {
  it("maps a user text message to a Gemini user/parts entry", () => {
    const { geminiMessages, systemInstruction } = convertMessages([userMsg("hello")]);
    expect(geminiMessages).toEqual([{ role: "user", parts: [{ text: "hello" }] }]);
    expect(systemInstruction).toBeUndefined();
  });

  it("hoists a system message into systemInstruction (not into contents)", () => {
    const msgs: Message[] = [
      { id: "s1", role: "system", content: [{ type: "text", text: "be terse" }], createdAt: 1 },
      userMsg("hi"),
    ];
    const { geminiMessages, systemInstruction } = convertMessages(msgs);
    expect(systemInstruction).toEqual({ parts: [{ text: "be terse" }] });
    expect(geminiMessages.every((m) => m.role !== "system")).toBe(true);
    expect(geminiMessages).toHaveLength(1);
  });

  it("an explicit systemPrompt arg is overridden by a system message", () => {
    const msgs: Message[] = [
      { id: "s1", role: "system", content: [{ type: "text", text: "from-message" }], createdAt: 1 },
    ];
    const { systemInstruction } = convertMessages(msgs, "from-arg");
    expect(systemInstruction).toEqual({ parts: [{ text: "from-message" }] });
  });

  it("maps assistant role to 'model' and converts tool_call → functionCall", () => {
    const msgs: Message[] = [
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool_call", toolCall: { id: "t1", name: "search", arguments: { q: "x" } } },
        ],
        createdAt: 1,
      } as Message,
    ];
    const { geminiMessages } = convertMessages(msgs);
    expect(geminiMessages[0].role).toBe("model");
    expect(geminiMessages[0].parts).toEqual([
      { text: "calling" },
      { functionCall: { name: "search", args: { q: "x" } } },
    ]);
  });

  it("maps tool role → user/functionResponse", () => {
    const msgs: Message[] = [
      {
        id: "t1",
        role: "tool",
        content: [{ type: "tool_result", toolResult: { id: "t1", name: "search", result: "found" } }],
        createdAt: 1,
      } as Message,
    ];
    const { geminiMessages } = convertMessages(msgs);
    expect(geminiMessages[0].role).toBe("user");
    expect(geminiMessages[0].parts).toEqual([
      { functionResponse: { name: "search", response: { result: "found" } } },
    ]);
  });

  it("drops empty messages (no emittable parts)", () => {
    const msgs: Message[] = [{ id: "u1", role: "user", content: [], createdAt: 1 }];
    expect(convertMessages(msgs).geminiMessages).toEqual([]);
  });
});

describe("provider-gemini-oauth: PKCE", () => {
  it("code challenge is the base64url SHA-256 of the verifier (RFC 7636)", () => {
    const verifier = "test-verifier-123";
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(generateCodeChallenge(verifier)).toBe(expected);
  });

  it("verifier is URL-safe base64 and unique per call", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
  });
});

describe("provider-gemini-oauth: buildMetadata", () => {
  it("returns the fixed provisioning metadata without a project", () => {
    expect(buildMetadata()).toEqual({
      ideType: "IDE_UNSPECIFIED",
      platform: "PLATFORM_UNSPECIFIED",
      pluginType: "GEMINI",
    });
  });

  it("adds duetProject when a projectId is supplied", () => {
    expect(buildMetadata("proj-42").duetProject).toBe("proj-42");
  });
});

describe("provider-gemini-oauth: catalog + manifest", () => {
  it("exposes a non-empty model catalog with id/contextWindow", () => {
    expect(MODELS.length).toBeGreaterThan(0);
    for (const m of MODELS) {
      expect(typeof m.id).toBe("string");
      expect(m.contextWindow).toBeGreaterThan(0);
    }
  });

  it("plugin manifest declares the samjna (provider) skandha", () => {
    const plugin = createGeminiOAuthPlugin();
    expect(plugin.manifest.name).toContain("gemini-oauth");
    expect(plugin.manifest.skandha).toBe("samjna");
  });
});
