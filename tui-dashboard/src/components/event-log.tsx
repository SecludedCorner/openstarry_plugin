import React from "react";
import { Box, Text } from "ink";
import { useTuiState } from "../state/context.js";
import { formatTimestamp, truncate } from "../utils/format.js";

export function EventLog() {
  const { state } = useTuiState();
  if (!state.isEventLogVisible) return null;

  const { events, eventScrollOffset } = state;
  const visibleCount = 20;
  const end = Math.max(0, events.length - eventScrollOffset);
  const start = Math.max(0, end - visibleCount);
  const visible = events.slice(start, end);

  return (
    <Box
      flexDirection="column"
      width="30%"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
    >
      <Text bold dimColor>
        Event Log ({state.eventCount})
      </Text>
      {visible.map((evt, i) => (
        <Box key={`${evt.timestamp}-${i}`}>
          <Text dimColor>
            [{formatTimestamp(evt.timestamp)}]{" "}
          </Text>
          <Text color="yellow">{truncate(evt.type, 30)}</Text>
        </Box>
      ))}
    </Box>
  );
}
