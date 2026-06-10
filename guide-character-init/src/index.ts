/**
 * guide-character-init — Base persona / system prompt provider (識蘊).
 *
 * Config options:
 *   { prompt: "..." }           — Inline system prompt
 *   { characterFile: "./x.md" } — Load from file
 *   { guideId: "my-guide" }     — Custom guide ID (default: "default-guide")
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IGuide,
} from "@openstarry/sdk";

const DEFAULT_PROMPT = `You are a helpful AI assistant powered by OpenStarry.
You can read, write, and manage files on the local filesystem using the available tools.
Always explain what you are doing before and after using tools.
If a tool call fails, analyze the error and try a different approach.
Be concise and helpful.`;

interface Config {
  prompt?: string;
  characterFile?: string;
  guideId?: string;
}

export function createGuideCharacterInitPlugin(): IPlugin {
  return {
    manifest: {
      name: "guide-character-init",
      version: "0.1.0-alpha",
      description: "Base persona / system prompt provider (識蘊)",
      skandha: 'vijnana' as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const config = ctx.config as Config;
      const guideId = config.guideId ?? "default-guide";

      const systemPrompt: string = config.characterFile
        ? await readFile(resolve(ctx.workingDirectory, config.characterFile), "utf-8")
        : (config.prompt ?? DEFAULT_PROMPT);

      const guide: IGuide = {
        skandha: 'vijnana' as const,
        id: guideId,
        name: `Character Guide (${guideId})`,
        getSystemPrompt: () => systemPrompt,
      };

      return { guides: [guide] };
    },
  };
}

export default createGuideCharacterInitPlugin;
