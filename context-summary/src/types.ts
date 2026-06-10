/**
 * Configuration for the ContextSummaryManager.
 * All fields are optional — defaults are applied in the manager.
 */
export interface ContextSummaryConfig {
  /**
   * Number of recent user turns to always preserve verbatim (not compressed).
   * Default: derived from DEFAULT_CONTEXT_SUMMARY_PRESERVE_RATIO * maxTurns at call time.
   * If set explicitly, overrides the ratio-based calculation.
   */
  preserveCount?: number;

  /**
   * Minimum estimated token count of the compressible region before summarization triggers.
   * Below this threshold all messages pass through uncompressed.
   * Default: DEFAULT_MIN_COMPRESS_TOKENS (500).
   */
  minCompressTokens?: number;

  /**
   * ID of the IProvider to use for LLM-based summarization.
   * If omitted or the provider is unavailable, falls back to sliding-window.
   */
  summaryProvider?: string;

  /**
   * Maximum number of summary layers that can be stacked (summary of summaries).
   * Default: 3.
   */
  maxSummaryDepth?: number;

  /**
   * Estimated characters per token used by the heuristic estimator.
   * Default: 4.
   */
  charsPerToken?: number;

  /**
   * Number of turns kept by the sliding-window fallback when no summary is available.
   * Default: 6.
   */
  fallbackKeepTurns?: number;

  /**
   * Timeout in milliseconds for the async summarization call.
   * Default: 30000 (30 s).
   */
  summaryTimeoutMs?: number;
}
