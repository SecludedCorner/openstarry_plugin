/**
 * Extraction — distill durable atomic facts from a conversation transcript.
 *
 * Pattern B write-side (C#2 Step B). Pure functions: prompt construction +
 * defensive response parsing. The actual LLM call lives in index.ts (provider).
 *
 * D1/D3 (Agent_Memory_Reference): write only three classes — preference,
 * convention, correction — each with an LLM importance score 1-10. Everything
 * else (chit-chat, reconstructable-on-demand) is discarded.
 */

import type { Message } from "@openstarry/sdk";

export type FactType = "preference" | "convention" | "correction";
export const FACT_TYPES: readonly FactType[] = ["preference", "convention", "correction"];

export interface ExtractedFact {
  readonly type: FactType;
  readonly text: string;
  /** LLM importance 1-10 (Generative Agents lever; used for gating + decay). */
  readonly importance: number;
}

export const EXTRACT_SYSTEM_PROMPT =
  "You are a long-term-memory extraction function for a personal AI agent. " +
  "Read the conversation transcript and output ONLY durable facts worth remembering across future sessions. " +
  "Keep EXACTLY three kinds and discard everything else:\n" +
  "- preference: a stable user preference (tone, tools, formats, style).\n" +
  "- convention: a project/workflow rule or standard to follow.\n" +
  "- correction: a 'do not do that again' / 'do it this way instead' the user asserted.\n" +
  "DISCARD: chit-chat, one-off task details, anything reconstructable on demand, transient state.\n" +
  "Each fact must be a concise, decontextualized, self-contained statement (no pronouns like 'it/that').\n" +
  // Cross-language retrieval (C#2 follow-up): recall is keyword-based, so a fact
  // normalized to pure English is invisible to a Chinese query (縮排 ≠
  // indentation). Bilingual applies to NEW seeds only — existing English-only
  // seeds are not migrated. Semantic-level cross-language matching is honestly
  // deferred to the walk-phase vector strategy.
  "Write each fact's text in English. If the user expressed the fact in another language (e.g. Chinese), " +
  "append that language's key terms in parentheses at the end, SEPARATED BY SPACES (word-level terms, not a sentence), " +
  'e.g. "Project uses 2-space indentation（縮排 2 空格）" — this keeps the fact keyword-searchable in both languages.\n' +
  "Assign importance 1-10 (10 = a hard rule the user insisted on; 1 = marginal).\n" +
  'Respond with ONLY a JSON array (no prose, no markdown fences): [{"type":"...","text":"...","importance":N}]. ' +
  "If there is nothing durable, respond with exactly []. Never invent facts not present in the transcript.";

/** Render recent messages into a plain transcript, capping bulky content (D1: reference-not-payload). */
export function messagesToTranscript(
  messages: readonly Message[],
  recentTurns: number,
  maxContentChars: number,
): string {
  const recent = recentTurns > 0 ? messages.slice(-recentTurns) : messages;
  const lines: string[] = [];
  for (const m of recent) {
    if (m.role === "system") continue; // never mine injected system/persona/core-block
    const text = m.content
      .map((seg) => {
        if (seg.type === "text" || seg.type === "reasoning") return seg.text;
        if (seg.type === "tool_call") return `[tool_call ${seg.toolCall?.name ?? "?"}]`;
        if (seg.type === "tool_result") {
          const r = typeof seg.toolResult?.result === "string" ? seg.toolResult.result : "";
          return r.length > maxContentChars
            ? `[tool_result — ${r.length} chars, truncated: ${r.slice(0, 120)}…]`
            : `[tool_result: ${r}]`;
        }
        return "";
      })
      .join(" ")
      .trim();
    if (!text) continue;
    const capped = text.length > maxContentChars ? text.slice(0, maxContentChars) + "…" : text;
    lines.push(`${m.role.toUpperCase()}: ${capped}`);
  }
  return lines.join("\n");
}

/** Build the two-message ChatRequest body for extraction. `now`/`id` injectable for tests. */
export function buildExtractionMessages(
  transcript: string,
  now: () => number = Date.now,
  id: (n: string) => string = (n) => `extract-${n}`,
): Message[] {
  const t = now();
  return [
    { id: id("sys"), role: "system", content: [{ type: "text", text: EXTRACT_SYSTEM_PROMPT }], createdAt: t },
    {
      id: id("usr"),
      role: "user",
      content: [{ type: "text", text: `Transcript:\n${transcript}\n\nExtract durable facts now as a JSON array.` }],
      createdAt: t,
    },
  ];
}

/**
 * Defensively parse the model's response into validated facts. Tolerates
 * markdown fences and surrounding prose by extracting the first JSON array.
 * Drops any entry with an unknown type / empty text / out-of-range importance
 * (importance is clamped to 1-10). Returns [] on any parse failure.
 */
export function parseExtractionResponse(raw: string, maxFacts = 5): ExtractedFact[] {
  if (!raw) return [];
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ExtractedFact[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const type = o.type;
    const text = typeof o.text === "string" ? o.text.trim() : "";
    if (typeof type !== "string" || !FACT_TYPES.includes(type as FactType)) continue;
    if (text.length === 0) continue;
    let importance = typeof o.importance === "number" && Number.isFinite(o.importance) ? Math.round(o.importance) : 5;
    importance = Math.min(10, Math.max(1, importance));
    out.push({ type: type as FactType, text, importance });
    if (out.length >= maxFacts) break;
  }
  return out;
}
