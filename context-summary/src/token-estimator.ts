/**
 * Heuristic token estimation.
 *
 * Uses a characters-per-token ratio (default 4) as a fast approximation.
 * Accurate enough for triggering compression thresholds — not for billing.
 */

import type { Message } from "@openstarry/sdk";

/**
 * Estimate the token count of a single string.
 *
 * @param text - The text to estimate.
 * @param charsPerToken - Characters per token ratio (default 4).
 */
export function estimateTokens(
  text: string,
  charsPerToken: number = 4,
): number {
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate the total token count across a list of messages.
 *
 * @param messages - Messages to estimate.
 * @param charsPerToken - Characters per token ratio (default 4).
 */
export function estimateMessagesTokens(
  messages: Message[],
  charsPerToken: number = 4,
): number {
  return messages.reduce((total, m) => {
    const text =
      typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content);
    return total + estimateTokens(text, charsPerToken);
  }, 0);
}
