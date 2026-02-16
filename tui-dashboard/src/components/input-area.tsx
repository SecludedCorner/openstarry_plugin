import React from "react";
import { Box, Text, useInput } from "ink";
import { useTuiState } from "../state/context.js";

export interface InputAreaProps {
  onSubmit?: (text: string) => void;
}

export function InputArea({ onSubmit }: InputAreaProps) {
  const { state, dispatch } = useTuiState();

  // Only capture input when in input mode
  useInput(
    (input, key) => {
      // Escape key — exit to browse mode
      if (key.escape) {
        dispatch({ type: "SET_INPUT_MODE", payload: "browse" });
        return;
      }

      // Enter key — submit input
      if (key.return) {
        if (state.inputText.trim()) {
          onSubmit?.(state.inputText);
        }
        return;
      }

      // Arrow up — previous history
      if (key.upArrow) {
        dispatch({ type: "HISTORY_PREV" });
        return;
      }

      // Arrow down — next history
      if (key.downArrow) {
        dispatch({ type: "HISTORY_NEXT" });
        return;
      }

      // Backspace — delete last character
      if (key.backspace || key.delete) {
        if (state.inputText.length > 0) {
          dispatch({
            type: "SET_INPUT_TEXT",
            payload: state.inputText.slice(0, -1),
          });
        }
        return;
      }

      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        dispatch({
          type: "SET_INPUT_TEXT",
          payload: state.inputText + input,
        });
      }
    },
    { isActive: state.inputMode === "input" && !state.isPending },
  );

  // Don't render input area in browse mode
  if (state.inputMode !== "input") {
    return null;
  }

  const placeholder = state.inputText === "" ? "Type your message..." : "";
  const cursor = state.isPending ? "" : "█";

  return (
    <Box
      borderStyle="single"
      borderColor={state.isPending ? "gray" : "cyan"}
      paddingX={1}
      flexDirection="column"
    >
      <Text dimColor={state.isPending}>
        {state.isPending ? (
          <Text color="yellow">⏳ Waiting for response...</Text>
        ) : (
          <>
            <Text bold color="cyan">
              {"> "}
            </Text>
            <Text color={state.inputText === "" ? "gray" : "white"}>
              {state.inputText || placeholder}
            </Text>
            <Text color="cyan">{cursor}</Text>
          </>
        )}
      </Text>
    </Box>
  );
}
