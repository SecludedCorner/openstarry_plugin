/**
 * KeywordRetrievalContextManager — relevance-aware context assembly.
 *
 * Instead of pure FIFO truncation (context-sliding-window), this keeps the
 * recent N-turn window AND splices back the top-K OLDER turns most lexically
 * relevant to the latest user message (term overlap, recency tiebreak). It is
 * the bounded, synchronous, in-memory "retrieval" strategy — NOT a vector store.
 *
 * Selection is at TURN granularity (a user message + its assistant/tool
 * messages up to the next user message) so tool_call/tool_result pairs are
 * never split. Deterministic: no LLM call, no async, no external deps.
 *
 * Doc: Agent_Core_Components_Deep_Dive/10 (pluggable-strategy mandate).
 * NEW IN v0.59.7.
 */

import type { IContextManager, Message, ContentSegment } from "@openstarry/sdk";

export interface KeywordRetrievalOptions {
  /** Max number of relevant OLDER turns to splice back in (default 3). */
  topK?: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "you", "are", "was", "this", "that", "from",
  "have", "has", "but", "not", "can", "will", "your", "our", "its", "their",
]);

/** Extract searchable text from a single content segment. */
function segmentText(seg: ContentSegment): string {
  switch (seg.type) {
    case "text":
    case "reasoning":
      return seg.text;
    case "tool_call":
      return `${seg.toolCall.name} ${JSON.stringify(seg.toolCall.arguments)}`;
    case "tool_result":
      return `${seg.toolResult.name} ${seg.toolResult.result}`;
    default:
      return "";
  }
}

/** Flattened lowercased text of a message. */
function messageText(m: Message): string {
  return m.content.map(segmentText).join(" ").toLowerCase();
}

/** Tokenize into a distinct term set (keeps CJK, drops short tokens + stopwords). */
function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9一-鿿]+/)) {
    if (tok.length >= 2 && !STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}

interface Turn {
  messages: Message[];
  startIndex: number; // position of the turn's first message in the older slice
}

/** Partition messages into turns starting at each user message. */
function partitionTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  messages.forEach((m, i) => {
    if (m.role === "user" || current === null) {
      current = { messages: [m], startIndex: i };
      turns.push(current);
    } else {
      current.messages.push(m);
    }
  });
  return turns;
}

export function createKeywordRetrievalContextManager(
  opts: KeywordRetrievalOptions = {},
): IContextManager {
  const topK = opts.topK && opts.topK > 0 ? Math.floor(opts.topK) : 3;

  return {
    assembleContext(messages: Message[], maxTurns: number): Message[] {
      if (messages.length === 0) return [];

      const systemMessages = messages.filter((m) => m.role === "system");
      const conversation = messages.filter((m) => m.role !== "system");

      if (maxTurns <= 0) {
        return [...systemMessages, ...conversation];
      }

      // Recent window: keep the last maxTurns user turns (same walk as sliding-window).
      let userTurnCount = 0;
      let cutIndex = conversation.length;
      for (let i = conversation.length - 1; i >= 0; i--) {
        if (conversation[i].role === "user") {
          userTurnCount++;
          if (userTurnCount > maxTurns) {
            cutIndex = i + 1;
            break;
          }
          cutIndex = i;
        }
      }

      const recent = conversation.slice(cutIndex);
      const older = conversation.slice(0, cutIndex);
      if (older.length === 0) {
        return [...systemMessages, ...recent];
      }

      // Query = terms of the latest user message (the freshest intent).
      const lastUser = [...conversation].reverse().find((m) => m.role === "user");
      const query = lastUser ? terms(messageText(lastUser)) : new Set<string>();

      const turns = partitionTurns(older);

      // If we'd keep everything anyway, don't bother scoring.
      if (turns.length <= topK || query.size === 0) {
        return [...systemMessages, ...older, ...recent];
      }

      const scored = turns.map((t) => {
        const turnTerms = terms(t.messages.map(messageText).join(" "));
        let overlap = 0;
        for (const q of query) if (turnTerms.has(q)) overlap++;
        const recency = Math.max(...t.messages.map((m) => m.createdAt));
        return { turn: t, overlap, recency };
      });

      // Top-K by overlap desc, recency desc tiebreak.
      scored.sort((a, b) => (b.overlap - a.overlap) || (b.recency - a.recency));
      const selected = scored.slice(0, topK).map((s) => s.turn);

      // Re-order selected turns by original position, then flatten.
      selected.sort((a, b) => a.startIndex - b.startIndex);
      const olderKept = selected.flatMap((t) => t.messages);

      return [...systemMessages, ...olderKept, ...recent];
    },
  };
}
