import React from "react";
import { Box, Text } from "ink";
import { useTuiState } from "../state/context.js";
import { statusSymbol } from "../utils/format.js";

export function Header() {
  const { state } = useTuiState();
  const sym = statusSymbol(state.agentStatus);
  const statusColor =
    state.agentStatus === "running"
      ? "green"
      : state.agentStatus === "error"
        ? "red"
        : "gray";

  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text bold color="cyan">
        OpenStarry
      </Text>
      <Text>
        <Text color={statusColor}>{sym}</Text>{" "}
        <Text bold>{state.agentName}</Text>{" "}
        <Text dimColor>v{state.agentVersion}</Text>
      </Text>
    </Box>
  );
}
