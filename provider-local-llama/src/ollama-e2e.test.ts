/**
 * provider-local-llama — REAL local Ollama e2e smoke.
 *
 * Auto-skip gated: at module load we probe http://127.0.0.1:11434/api/tags
 * with a ~1500ms AbortController timeout. Only when the daemon is healthy
 * AND reports at least one installed model does the suite run a tiny real
 * chat through the plugin's PUBLIC chat() surface. On machines without
 * Ollama the suite reports SKIPPED (never failed) — honest marking per the
 * 5-criterion test (no fake-green on hosts without the daemon).
 *
 * No fetch stubbing here — this hits the real local daemon.
 */

import { describe, expect, it } from "vitest";
import type {
  IPluginContext,
  Message,
  ProviderStreamEvent,
} from "@openstarry/sdk";
import { createLocalLlamaPlugin } from "./index.js";

const OLLAMA_HOST = "http://127.0.0.1:11434";
const PROBE_TIMEOUT_MS = 1500;

interface ProbeResult {
  available: boolean;
  firstModel: string | null;
}

async function probeOllama(): Promise<ProbeResult> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return { available: false, firstModel: null };
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    const firstModel = data.models?.[0]?.name ?? null;
    // Healthy daemon but zero installed models → still skip (nothing to chat with).
    return { available: firstModel !== null, firstModel };
  } catch {
    return { available: false, firstModel: null };
  }
}

const probe = await probeOllama();

describe.skipIf(!probe.available)(
  "ollama real e2e (auto-skip when 127.0.0.1:11434 unreachable)",
  () => {
    it(
      "streams one tiny real chat through the public chat(): >=1 text_delta + exactly one finish",
      async () => {
        const plugin = createLocalLlamaPlugin();
        // Minimal context: the factory only reads ctx.config; no hostUrl key
        // so the user's stored config / default host stays untouched.
        const ctx = { config: {} } as unknown as IPluginContext;
        const hooks = await plugin.factory(ctx);
        try {
          const provider = hooks.providers?.[0];
          expect(provider).toBeDefined();
          if (!provider) return;
          expect(provider.isConfigured?.()).toBe(true);

          const messages: Message[] = [
            {
              id: "e2e-1",
              role: "user",
              content: [{ type: "text", text: "Reply with exactly: PONG" }],
              createdAt: Date.now(),
            },
          ];

          const events: ProviderStreamEvent[] = [];
          for await (const evt of provider.chat({
            model: probe.firstModel as string,
            messages,
            temperature: 0,
          })) {
            events.push(evt);
          }

          const errors = events.filter((e) => e.type === "error");
          expect(errors).toEqual([]);

          const textDeltas = events.filter((e) => e.type === "text_delta");
          expect(textDeltas.length).toBeGreaterThanOrEqual(1);

          const finishes = events.filter((e) => e.type === "finish");
          expect(finishes).toHaveLength(1);
          if (finishes[0].type === "finish") {
            expect(["end_turn", "tool_use"]).toContain(finishes[0].stopReason);
          }
        } finally {
          hooks.dispose?.();
        }
      },
      60_000,
    );
  },
);
