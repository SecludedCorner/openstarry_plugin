/**
 * standard-function-skill — Markdown Skill Loader for the OpenStarry agent.
 *
 * Reads `.md` skill files with YAML frontmatter and registers them as Guides.
 * The Markdown body becomes the system prompt; the frontmatter provides metadata.
 *
 * Frontmatter schema:
 *   type: "skill"
 *   id: string (unique identifier)
 *   version: string
 *   description: string
 *   dependencies:
 *     plugins: string[]
 *     capabilities: string[]
 *   parameters:
 *     temperature: number
 *     model_preference: string[]
 *
 * Usage in agent.json:
 *   { "name": "standard-function-skill", "config": { "skillPath": "./skills/my-agent.md" } }
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IGuide,
} from "@openstarry/sdk";

// ─── Frontmatter Types ───

export interface SkillFrontmatter {
  type?: string;
  id: string;
  version?: string;
  description?: string;
  dependencies?: {
    plugins?: string[];
    capabilities?: string[];
  };
  parameters?: {
    temperature?: number;
    model_preference?: string[];
  };
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

// ─── Frontmatter Parser ───

/**
 * Parse a Markdown file with YAML frontmatter.
 * Frontmatter is delimited by `---` at the start and end.
 */
export function parseSkillFile(content: string): ParsedSkill {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    // No frontmatter — treat entire content as body
    return {
      frontmatter: { id: "unnamed-skill" },
      body: trimmed,
    };
  }

  // Find the closing `---`
  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    // Malformed — treat entire content as body
    return {
      frontmatter: { id: "unnamed-skill" },
      body: trimmed,
    };
  }

  const yamlBlock = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  let frontmatter: SkillFrontmatter;
  try {
    const parsed = parseYaml(yamlBlock) as Record<string, unknown>;
    frontmatter = {
      type: typeof parsed.type === "string" ? parsed.type : undefined,
      id: typeof parsed.id === "string" ? parsed.id : "unnamed-skill",
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      description: typeof parsed.description === "string" ? parsed.description : undefined,
      dependencies: parsed.dependencies as SkillFrontmatter["dependencies"],
      parameters: parsed.parameters as SkillFrontmatter["parameters"],
    };
  } catch {
    frontmatter = { id: "unnamed-skill" };
  }

  return { frontmatter, body };
}

// ─── Skill Guide ───

/**
 * Creates an IGuide from a parsed skill file.
 * The markdown body is used as the system prompt.
 */
function createSkillGuide(skill: ParsedSkill): IGuide {
  return {
    id: skill.frontmatter.id,
    name: skill.frontmatter.description ?? skill.frontmatter.id,
    getSystemPrompt(): string {
      return skill.body;
    },
  };
}

// ─── Plugin Export ───

export function createSkillPlugin(): IPlugin {
  return {
    manifest: {
      name: "standard-function-skill",
      version: "0.1.0-alpha",
      description: "Markdown skill loader — reads .md files with YAML frontmatter and registers as Guide",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const skillPath = ctx.config.skillPath as string | undefined;

      if (!skillPath) {
        // No skill path configured — return empty hooks
        return {};
      }

      const absolutePath = resolve(ctx.workingDirectory, skillPath);
      const content = await readFile(absolutePath, "utf-8");
      const skill = parseSkillFile(content);

      const guide = createSkillGuide(skill);

      return {
        guides: [guide],
      };
    },
  };
}

export default createSkillPlugin;
