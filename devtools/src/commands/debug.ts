/**
 * /debug slash command — toggle verbose debug logging.
 */
import type { SlashCommand, IPluginContext } from "@openstarry/sdk";
import type { DevToolsConfig } from "../types/config.js";

export function createDebugCommand(config: Required<DevToolsConfig>): SlashCommand {
  return {
    name: "debug",
    description: "Toggle verbose debug logging (on/off)",
    async execute(args: string, _ctx: IPluginContext): Promise<string> {
      const trimmed = args.trim().toLowerCase();
      if (trimmed === "on") {
        config.verbose = true;
        return "Debug logging: ON";
      } else if (trimmed === "off") {
        config.verbose = false;
        return "Debug logging: OFF";
      } else {
        return `Debug logging: ${config.verbose ? "ON" : "OFF"}`;
      }
    },
  };
}
