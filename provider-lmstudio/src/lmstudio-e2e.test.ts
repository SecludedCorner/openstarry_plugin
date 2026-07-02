/**
 * provider-lmstudio — REAL local LM Studio tool-calling e2e (L block).
 *
 * Auto-skip gated (ollama-e2e precedent): at module load we probe
 * http://127.0.0.1:1234/v1/models with a ~1500ms timeout. Only when the
 * server is up AND a chat model is loaded does the suite run REAL chats
 * through the provider's public chat() surface — no fetch stubbing, no mock
 * (C#4 discipline: never fake the real chain). On machines without LM Studio
 * the suite reports SKIPPED, never fake-green.
 *
 * Model dependence (honest marking): native OpenAI function-calling only
 * works on tool-capable models. Default probe model: qwen/qwen3.5-9b
 * (wire-verified 2026-07-02); override with LMSTUDIO_E2E_MODEL.
 */

import { describe, expect, it } from "vitest";
import type { Message, ProviderStreamEvent } from "@openstarry/sdk";
import { LmStudioProvider } from "./index.js";

const BASE_URL = process.env.LMSTUDIO_E2E_BASEURL ?? "http://127.0.0.1:1234/v1";
const MODEL = process.env.LMSTUDIO_E2E_MODEL ?? "qwen/qwen3.5-9b";
const PROBE_TIMEOUT_MS = 1500;

async function probeLmStudio(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetch(`${BASE_URL}/models`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).some((m) => m.id === MODEL);
  } catch {
    return false;
  }
}

const lmStudioUp = await probeLmStudio();

function makeProvider(): LmStudioProvider {
  const provider = new LmStudioProvider();
  provider.configured = true;
  provider.baseUrl = BASE_URL;
  return provider;
}

function textMsg(role: Message["role"], text: string, id: string): Message {
  return { id, role, content: [{ type: "text", text }], createdAt: Date.now() };
}

const FS_LIST_TOOL = {
  name: "fs.list",
  description: "List the files in a directory",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "directory path" } },
    required: ["path"],
  },
};

async function collect(iter: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const out: ProviderStreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe.skipIf(!lmStudioUp)(`REAL LM Studio tool-calling e2e (${MODEL})`, () => {
  it(
    "single turn: the model emits a native fs.list tool call (start → delta → end → finish tool_use)",
    { timeout: 120000 },
    async () => {
      const events = await collect(
        makeProvider().chat({
          model: MODEL,
          messages: [
            textMsg("user", "List the files in the current directory using the fs.list tool.", "u1"),
          ],
          tools: [FS_LIST_TOOL],
          maxTokens: 512,
          temperature: 0,
        }),
      );

      const errors = events.filter((e) => e.type === "error");
      expect(errors).toEqual([]);

      const start = events.find((e) => e.type === "tool_call_start");
      expect(start).toBeDefined();
      expect(start!.type === "tool_call_start" && start!.name).toBe("fs.list");

      // deltas are load-bearing: the loop reads args from the delta buffer
      const deltas = events.filter((e) => e.type === "tool_call_delta");
      expect(deltas.length).toBeGreaterThan(0);
      const args = JSON.parse(
        deltas.map((d) => (d.type === "tool_call_delta" ? d.input : "")).join(""),
      ) as { path?: string };
      expect(typeof args.path).toBe("string");

      const end = events.find((e) => e.type === "tool_call_end");
      expect(end).toBeDefined();

      const finish = events.find((e) => e.type === "finish");
      expect(finish).toBeDefined();
      expect(finish!.type === "finish" && finish!.stopReason).toBe("tool_use");
    },
  );

  it(
    "multi turn: a fed-back tool_result is used in the final text answer",
    { timeout: 120000 },
    async () => {
      // Round 2 as the loop would send it: user ask + assistant tool_call +
      // tool result carrying a distinctive fake filename.
      const assistantCall: Message = {
        id: "a1",
        role: "assistant",
        content: [
          { type: "tool_call", toolCall: { id: "call-1", name: "fs.list", arguments: { path: "." } } },
        ],
        createdAt: Date.now(),
      };
      const toolResult: Message = {
        id: "t1",
        role: "user",
        content: [
          {
            type: "tool_result",
            toolResult: { toolCallId: "call-1", name: "fs.list", result: "zebra-notes.md\nalpha.txt" },
          },
        ],
        createdAt: Date.now(),
      };

      const events = await collect(
        makeProvider().chat({
          model: MODEL,
          messages: [
            textMsg("user", "List the files in the current directory using the fs.list tool, then tell me the file names.", "u1"),
            assistantCall,
            toolResult,
          ],
          tools: [FS_LIST_TOOL],
          maxTokens: 512,
          temperature: 0,
        }),
      );

      const errors = events.filter((e) => e.type === "error");
      expect(errors).toEqual([]);

      const text = events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e.type === "text_delta" ? e.text : ""))
        .join("");
      expect(text).toContain("zebra-notes.md"); // the result actually reached the model
    },
  );
});

// Honest marker: on hosts without LM Studio (or without the probe model
// loaded) the real e2e is SKIPPED — never fake-green via mocks.
describe.skipIf(lmStudioUp)("LM Studio e2e (server not available)", () => {
  it("skipped — LM Studio not reachable or probe model not loaded", () => {
    expect(lmStudioUp).toBe(false);
  });
});
