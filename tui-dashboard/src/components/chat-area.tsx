import React from "react";
import { Box, Text } from "ink";
import { useTuiState } from "../state/context.js";
import { messagePrefix, formatTimestamp } from "../utils/format.js";
import type { Message } from "../state/types.js";

function colorForType(
  type: Message["type"],
): string {
  switch (type) {
    case "user":
      return "blue";
    case "assistant":
      return "green";
    case "tool-call":
      return "yellow";
    case "tool-result":
      return "gray";
    case "error":
      return "red";
    case "system":
      return "magenta";
  }
}

function MessageItem({ msg }: { msg: Message }) {
  const prefix = messagePrefix(msg.type);
  const color = colorForType(msg.type);
  const time = formatTimestamp(msg.timestamp);

  return (
    <Box>
      <Text dimColor>{time} </Text>
      <Text color={color}>
        {prefix}
        {msg.content}
      </Text>
    </Box>
  );
}

export function ChatArea() {
  const { state } = useTuiState();
  const { messages, chatScrollOffset } = state;

  // Show the last N messages, adjusted by scroll offset
  const visibleCount = 20;
  const end = Math.max(0, messages.length - chatScrollOffset);
  const start = Math.max(0, end - visibleCount);
  const visible = messages.slice(start, end);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visible.length === 0 ? (
        <Text dimColor>Waiting for agent events...</Text>
      ) : (
        visible.map((msg) => <MessageItem key={msg.id} msg={msg} />)
      )}
      {chatScrollOffset > 0 && (
        <Text dimColor>-- {chatScrollOffset} more below --</Text>
      )}
    </Box>
  );
}
