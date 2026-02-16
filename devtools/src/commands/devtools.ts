/**
 * /devtools slash command — toggle DevTools panel visibility.
 */
import type { SlashCommand, IPluginContext } from "@openstarry/sdk";

export interface DevToolsPanelControl {
  toggle(): boolean;
  isVisible(): boolean;
}

export function createDevtoolsCommand(panel: DevToolsPanelControl): SlashCommand {
  return {
    name: "devtools",
    description: "Toggle DevTools panel visibility",
    async execute(_args: string, _ctx: IPluginContext): Promise<string> {
      const nowVisible = panel.toggle();
      return nowVisible ? "DevTools panel: ON" : "DevTools panel: OFF";
    },
  };
}
