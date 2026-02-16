/** Truncate text to maxLength, appending "..." if truncated. */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "...";
}

/** Format a timestamp (ms) to HH:MM:SS. */
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** Return a status symbol for a given agent status. */
export function statusSymbol(
  status: "running" | "stopped" | "error",
): string {
  switch (status) {
    case "running":
      return "[RUN]";
    case "stopped":
      return "[OFF]";
    case "error":
      return "[ERR]";
  }
}

/** Return a message type prefix for display. */
export function messagePrefix(
  type: "user" | "assistant" | "tool-call" | "tool-result" | "error" | "system",
): string {
  switch (type) {
    case "user":
      return "> ";
    case "assistant":
      return "";
    case "tool-call":
      return "[tool] ";
    case "tool-result":
      return "[result] ";
    case "error":
      return "[error] ";
    case "system":
      return "[system] ";
  }
}
