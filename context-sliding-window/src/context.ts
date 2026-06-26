/**
 * ContextManager — sliding window strategy for context assembly.
 *
 * Keeps the most recent N user/assistant turn pairs (a "turn" is a
 * user message + the assistant's response + any tool messages in between).
 * System messages are always included.
 */

import type { IContextManager, Message } from "@openstarry/sdk";

export function createContextManager(): IContextManager {
  return {
    assembleContext(messages: Message[], maxTurns: number): Message[] {
      if (messages.length === 0) return [];

      const systemMessages = messages.filter((m) => m.role === "system");
      const conversationMessages = messages.filter((m) => m.role !== "system");

      if (maxTurns <= 0) {
        return [...systemMessages, ...conversationMessages];
      }

      let userTurnCount = 0;
      let cutIndex = conversationMessages.length;

      for (let i = conversationMessages.length - 1; i >= 0; i--) {
        if (conversationMessages[i].role === "user") {
          userTurnCount++;
          if (userTurnCount > maxTurns) {
            // BUGFIX (v0.59.7): do NOT advance cutIndex to i+1 here — that
            // kept the trailing assistant/tool messages of the oldest DROPPED
            // turn (an orphaned response with no user in the window, violating
            // the "turn pair" contract). cutIndex already points at the Nth
            // user message from the end (set on the prior matching iteration),
            // so we simply stop.
            break;
          }
          cutIndex = i;
        }
      }

      const windowedMessages = conversationMessages.slice(cutIndex);
      return [...systemMessages, ...windowedMessages];
    },
  };
}
