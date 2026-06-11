/**
 * ContextSummaryManager — cached-summary strategy for context assembly.
 *
 * Algorithm (per assembleContext call):
 *
 * Phase 1 — Partition:
 *   - System messages are always kept verbatim.
 *   - Non-system messages are split into:
 *       preserved window : last `preserveCount` user turns + their responses
 *       compressible     : everything before the preserved window
 *
 * Phase 2 — Compress or Pass-through:
 *   - If compressible region is empty or below minCompressTokens →
 *       return system + all conversation messages (up to maxTurns sliding-window).
 *   - If a cached summary covering the compressible region exists →
 *       return system + [summary message] + preserved window.
 *   - Otherwise → sliding-window fallback for this call; trigger async summarization
 *       in the background so the next call can use the cache.
 *
 * Async summarization uses the optional IProvider from ctx.providers.
 * If no provider is available the manager degrades gracefully to sliding-window
 * (D2-R1 progressive-enhancement design).
 */

import type { IContextManager, Message, IPluginContext } from "@openstarry/sdk";
import {
  DEFAULT_MIN_COMPRESS_TOKENS,
  DEFAULT_CONTEXT_SUMMARY_PRESERVE_RATIO,
  DEFAULT_SUMMARY_PROMPT,
} from "@openstarry/sdk";
import type { ContextSummaryConfig } from "./types.js";
import {
  estimateMessagesTokens,
  estimateTokens,
} from "./token-estimator.js";

const DEFAULT_MAX_SUMMARY_DEPTH = 3;
const DEFAULT_FALLBACK_KEEP_TURNS = 6;
const DEFAULT_SUMMARY_TIMEOUT_MS = 30_000;

interface SummaryCache {
  /** The summary text produced by the LLM. */
  text: string;
  /** How many non-system messages are covered by this summary. */
  coveredCount: number;
  /** Number of times this summary has been layered (summary of summaries). */
  depth: number;
}

export class ContextSummaryManager implements IContextManager {
  private readonly config: Required<ContextSummaryConfig>;
  private readonly ctx: IPluginContext;

  /** Cached summary from the last async summarization. */
  private cachedSummary: SummaryCache | null = null;

  /** Guards against concurrent summarization calls. */
  private summarizing = false;

  constructor(config: ContextSummaryConfig, ctx: IPluginContext) {
    this.ctx = ctx;
    this.config = {
      preserveCount: config.preserveCount ?? 0,       // 0 = use ratio
      minCompressTokens: config.minCompressTokens ?? DEFAULT_MIN_COMPRESS_TOKENS,
      summaryProvider: config.summaryProvider ?? "",
      maxSummaryDepth: config.maxSummaryDepth ?? DEFAULT_MAX_SUMMARY_DEPTH,
      charsPerToken: config.charsPerToken ?? 4,
      fallbackKeepTurns: config.fallbackKeepTurns ?? DEFAULT_FALLBACK_KEEP_TURNS,
      summaryTimeoutMs: config.summaryTimeoutMs ?? DEFAULT_SUMMARY_TIMEOUT_MS,
    };
  }

  assembleContext(messages: Message[], maxTurns: number): Message[] {
    if (messages.length === 0) return [];

    // ── Phase 1: Partition ───────────────────────────────────────────────────
    const systemMessages = messages.filter((m) => m.role === "system");
    const conversation = messages.filter((m) => m.role !== "system");

    if (conversation.length === 0) return [...systemMessages];

    // Determine how many user turns to preserve verbatim.
    const preserveCount =
      this.config.preserveCount > 0
        ? this.config.preserveCount
        : Math.ceil(
            (maxTurns > 0 ? maxTurns : conversation.length) *
              DEFAULT_CONTEXT_SUMMARY_PRESERVE_RATIO,
          );

    // Walk backwards collecting the preserved window (last N user turns).
    let userTurnsSeen = 0;
    let preserveStartIndex = conversation.length; // exclusive lower bound

    for (let i = conversation.length - 1; i >= 0; i--) {
      if (conversation[i].role === "user") {
        userTurnsSeen++;
        if (userTurnsSeen >= preserveCount) {
          preserveStartIndex = i;
          break;
        }
      }
    }

    const compressible = conversation.slice(0, preserveStartIndex);
    const preserved = conversation.slice(preserveStartIndex);

    // ── Phase 2: Compress or pass-through ────────────────────────────────────

    // 2a. Compressible region too small — return everything (bounded by sliding window).
    if (
      compressible.length === 0 ||
      estimateMessagesTokens(compressible, this.config.charsPerToken) <
        this.config.minCompressTokens
    ) {
      return this._slidingWindowFallback(systemMessages, conversation, maxTurns);
    }

    // 2b. Valid cached summary that covers the compressible region exactly.
    if (
      this.cachedSummary !== null &&
      this.cachedSummary.coveredCount === compressible.length
    ) {
      const summaryMessage = this._buildSummaryMessage(this.cachedSummary.text);
      return [...systemMessages, summaryMessage, ...preserved];
    }

    // 2c. No usable cache — fall back to sliding window and kick off summarization.
    this._triggerAsyncSummarization(compressible);
    return this._slidingWindowFallback(systemMessages, conversation, maxTurns);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Inlined sliding-window fallback: keep the last N user turns.
   * Must NOT import from @openstarry-plugin/context-sliding-window.
   */
  private _slidingWindowFallback(
    systemMessages: Message[],
    conversation: Message[],
    maxTurns: number,
  ): Message[] {
    const keepTurns =
      maxTurns > 0 ? maxTurns : this.config.fallbackKeepTurns;
    if (keepTurns <= 0) return [...systemMessages, ...conversation];

    let userTurnCount = 0;
    let cutIndex = conversation.length;

    for (let i = conversation.length - 1; i >= 0; i--) {
      if (conversation[i].role === "user") {
        userTurnCount++;
        if (userTurnCount > keepTurns) {
          cutIndex = i + 1;
          break;
        }
        cutIndex = i;
      }
    }

    return [...systemMessages, ...conversation.slice(cutIndex)];
  }

  /** Build a synthetic assistant message wrapping the summary text. */
  private _buildSummaryMessage(summaryText: string): Message {
    return {
      id: "context-summary-cached",
      role: "assistant",
      content: [{ type: "text", text: `[Context Summary]\n${summaryText}` }],
      createdAt: Date.now(),
    };
  }

  /**
   * Fire-and-forget async summarization.
   * Uses the IProvider identified by config.summaryProvider (or first available).
   * Updates this.cachedSummary on success; logs and degrades silently on failure.
   */
  private _triggerAsyncSummarization(compressible: Message[]): void {
    if (this.summarizing) return;

    // Check depth limit to avoid infinite summary-of-summary chains.
    const currentDepth = this.cachedSummary?.depth ?? 0;
    if (currentDepth >= this.config.maxSummaryDepth) return;

    // Locate a provider.
    const provider = this._resolveProvider();
    if (provider === undefined) return;

    this.summarizing = true;

    const timeoutMs = this.config.summaryTimeoutMs;
    const coveredCount = compressible.length;
    const depth = currentDepth + 1;

    // Build the summarization request messages.
    const transcriptText = compressible
      .map((m) => {
        const text = m.content
          .map((seg) => {
            if (seg.type === "text") return seg.text;
            if (seg.type === "reasoning") return `[reasoning] ${seg.text}`;
            return "";
          })
          .filter(Boolean)
          .join("\n");
        return `${m.role}: ${text}`;
      })
      .join("\n\n");

    const requestMessages: Message[] = [
      {
        id: "summary-request-user",
        role: "user",
        content: [{ type: "text", text: transcriptText }],
        createdAt: Date.now(),
      },
    ];

    const firstModel = provider.models[0]?.id ?? "default";
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);

    const doSummarize = async (): Promise<void> => {
      try {
        let summaryText = "";
        const stream = provider.chat({
          model: firstModel,
          messages: requestMessages,
          systemPrompt: DEFAULT_SUMMARY_PROMPT,
          signal: abortController.signal,
        });

        for await (const event of stream) {
          if (event.type === "text_delta") {
            summaryText += event.text;
          }
          if (event.type === "finish" || event.type === "error") break;
        }

        if (summaryText.trim().length > 0) {
          this.cachedSummary = { text: summaryText.trim(), coveredCount, depth };
        }
      } finally {
        clearTimeout(timeoutHandle);
        this.summarizing = false;
      }
    };

    doSummarize().catch(() => {
      clearTimeout(timeoutHandle);
      this.summarizing = false;
    });
  }

  /** Resolve the IProvider to use for summarization. */
  private _resolveProvider() {
    const registry = this.ctx.providers;
    if (registry === undefined) return undefined;

    if (this.config.summaryProvider.length > 0) {
      return registry.get(this.config.summaryProvider);
    }
    // Fall back to first available provider.
    const all = registry.list();
    return all.length > 0 ? all[0] : undefined;
  }

  // ── Test-accessible internals (underscore convention) ──────────────────────

  /** Expose token estimator for tests. */
  estimateTokensForText(text: string): number {
    return Math.ceil(text.length / this.config.charsPerToken);
  }
}
