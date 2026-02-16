import React from "react";
import { Box, Text } from "ink";
import { useTuiState } from "../state/context.js";

export function Footer() {
  const { state } = useTuiState();

  // Mode-specific hints (Plan09)
  const modeHint =
    state.inputMode === "input"
      ? "Enter=send Esc=cancel ↑↓=history"
      : `q=quit Tab=log i=input${state.isEventLogVisible ? " [/]=log scroll" : ""}`;

  const modeLabel =
    state.inputMode === "input" ? (
      <Text color="cyan" bold>
        INPUT
      </Text>
    ) : (
      <Text color="gray">BROWSE</Text>
    );

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text dimColor>
        {state.messageCount} msgs | {state.toolCallCount} tools |{" "}
        {state.errorCount} errors | {modeLabel}
      </Text>
      <Text dimColor>{modeHint}</Text>
    </Box>
  );
}
