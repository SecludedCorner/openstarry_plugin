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
            cutIndex = i + 1;
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
