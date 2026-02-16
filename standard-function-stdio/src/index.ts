/**
 * standard-function-stdio — CLI I/O plugin.
 *
 * Provides:
 * - StdioListener (受蘊) — receives stdin input
 * - StdioUI (色蘊) — renders output to stdout
 *
 * Note: Guide (識蘊) has been moved to guide-character-init plugin.
 */

import { createInterface } from "node:readline";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IListener,
  IUI,
  AgentEvent,
} from "@openstarry/sdk";
import { AgentEventType } from "@openstarry/sdk";

// ─── ANSI Colors ───

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

// ─── Stdio Listener (受蘊 - Input) ───

function createStdioListener(ctx: IPluginContext): IListener {
  let rl: ReturnType<typeof createInterface> | null = null;

  return {
    id: "stdio-listener",
    name: "Standard I/O Listener",

    async start(): Promise<void> {
      // Skip stdin listener in daemon mode (stdin is not available)
      if (process.env.OPENSTARRY_DAEMON === "1") {
        return;
      }

      rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });

      rl.on("line", (line: string) => {
        const trimmed = line.trim();
        if (trimmed) {
          ctx.pushInput({
            source: "cli",
            inputType: "user_input",
            data: trimmed,
          });
        }
      });

      rl.on("close", () => {
        ctx.pushInput({
          source: "cli",
          inputType: "user_input",
          data: "/quit",
        });
      });
    },

    async stop(): Promise<void> {
      if (rl) {
        rl.close();
        rl = null;
      }
    },
  };
}

// ─── Stdio UI (色蘊 - Output) ───

function createStdioUI(ctx: IPluginContext): IUI {
  let isStreaming = false;

  function promptUser(): void {
    process.stdout.write(`${BOLD}${CYAN}> ${RESET}`);
  }

  return {
    id: "stdio-ui",
    name: "Standard I/O UI",

    onEvent(event: AgentEvent): void {
      const payload = event.payload as Record<string, unknown> | undefined;

      switch (event.type) {
        case AgentEventType.AGENT_STARTED: {
          const identity = payload?.identity as { name?: string } | undefined;
          console.log(
            `\n${BOLD}${CYAN}=== ${identity?.name ?? "OpenStarry Agent"} ===${RESET}`,
          );
          console.log(`${DIM}Type /help for commands, /quit to exit${RESET}`);
          console.log("");

          // Dynamic provider list — only show loaded providers
          const providers = ctx.providers?.list() ?? [];
          if (providers.length > 0) {
            let first = true;
            for (const p of providers) {
              const hint = p.loginHint;
              const args = hint?.usage ? ` ${hint.usage}` : "";
              const desc = hint?.description ?? p.name;
              const prefix = first ? "Providers: " : "           ";
              console.log(`${DIM}${prefix}/provider login ${p.id}${args}  (${desc})${RESET}`);
              first = false;
            }
          }
          console.log(`${DIM}           /provider status                            (check all)${RESET}`);
          console.log(`${DIM}           /provider model                             (select model)${RESET}`);
          console.log("");
          promptUser();
          break;
        }

        case AgentEventType.STREAM_TEXT_DELTA: {
          if (!isStreaming) {
            process.stdout.write(`${GREEN}`);
            isStreaming = true;
          }
          process.stdout.write(payload?.text as string ?? "");
          break;
        }

        case AgentEventType.STREAM_FINISH: {
          if (isStreaming) {
            process.stdout.write(`${RESET}\n`);
            isStreaming = false;
          }
          break;
        }

        case AgentEventType.STREAM_TOOL_CALL_START: {
          if (isStreaming) {
            process.stdout.write(`${RESET}\n`);
            isStreaming = false;
          }
          console.log(
            `${YELLOW}[tool] Calling: ${payload?.name as string ?? "unknown"}${RESET}`,
          );
          break;
        }

        case AgentEventType.TOOL_RESULT: {
          const result = (payload?.result as string) ?? "";
          const truncated =
            result.length > 500 ? result.slice(0, 500) + "..." : result;
          console.log(`${DIM}[tool result] ${truncated}${RESET}`);
          break;
        }

        case AgentEventType.TOOL_ERROR: {
          console.log(
            `${RED}[tool error] ${payload?.name as string ?? ""}: ${payload?.error as string ?? "unknown error"}${RESET}`,
          );
          break;
        }

        case AgentEventType.STREAM_ERROR: {
          if (isStreaming) {
            process.stdout.write(`${RESET}\n`);
            isStreaming = false;
          }
          console.error(
            `${RED}[error] ${payload?.error as string ?? "Unknown error"}${RESET}`,
          );
          break;
        }

        case AgentEventType.LOOP_ERROR: {
          console.error(
            `${RED}[error] ${payload?.error as string ?? "Unknown error"}${RESET}`,
          );
          break;
        }

        case AgentEventType.MESSAGE_SYSTEM: {
          const text = payload?.text as string | undefined;
          if (text) {
            console.log(`${MAGENTA}${text}${RESET}`);
          }
          break;
        }

        case AgentEventType.LOOP_FINISHED: {
          console.log("");
          promptUser();
          break;
        }

        case AgentEventType.STATE_RESET: {
          console.log(`${CYAN}Conversation reset.${RESET}\n`);
          promptUser();
          break;
        }

        case AgentEventType.SAFETY_LOCKOUT: {
          if (isStreaming) {
            process.stdout.write(`${RESET}\n`);
            isStreaming = false;
          }
          console.error(
            `\n${RED}${BOLD}[SAFETY LOCKOUT] ${payload?.error as string ?? "Agent halted by safety monitor."}${RESET}`,
          );
          console.error(
            `${YELLOW}Use /reset to unlock the agent.${RESET}\n`,
          );
          promptUser();
          break;
        }

        case AgentEventType.SAFETY_WARNING: {
          console.log(
            `${YELLOW}[safety] ${payload?.warning as string ?? "Safety warning"}${RESET}`,
          );
          break;
        }

        case AgentEventType.AGENT_STOPPED: {
          // Process-level exit is handled by the host (bin.ts)
          break;
        }

        case AgentEventType.LOOP_AWAITING_LLM: {
          console.log(`${DIM}[thinking...]${RESET}`);
          break;
        }
      }
    },
  };
}

// ─── Plugin Export ───

export function createStdioPlugin(): IPlugin {
  return {
    manifest: {
      name: "standard-function-stdio",
      version: "0.1.0-alpha",
      description: "CLI I/O plugin (Listener + UI)",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      return {
        listeners: [createStdioListener(ctx)],
        ui: [createStdioUI(ctx)],
      };
    },
  };
}

export default createStdioPlugin;
