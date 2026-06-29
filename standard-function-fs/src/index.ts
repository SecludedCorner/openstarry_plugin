/**
 * standard-function-fs — File system tools for the OpenStarry agent.
 *
 * Provides: fs.read, fs.write, fs.list, fs.mkdir, fs.delete
 * All paths are validated against the allowed paths in the tool context.
 */

import { readFile, writeFile, readdir, mkdir, rm, stat } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  ITool,
  ToolContext,
} from "@openstarry/sdk";
import { realpathJail } from "@openstarry/shared";

// ─── Path Validation ───
//
// Delegates to the shared symlink-aware realpath jail (single source of truth,
// also used by core's SecurityLayer). This catches a symlink placed INSIDE an
// allowed path that targets OUTSIDE it — the previous lexical resolve+normalize
// check did not. Throws SecurityError on escape; returns the realpath'd absolute
// path for the syscall.
function validatePath(targetPath: string, ctx: ToolContext): string {
  return realpathJail(targetPath, {
    workingDirectory: ctx.workingDirectory,
    allowedPaths: ctx.allowedPaths,
  });
}

// ─── Tools ───

const fsReadTool: ITool<{ path: string; encoding?: string }> = {
  skandha: 'samskara' as const,
  id: "fs.read",
  description:
    "Read the contents of a file. Returns the file content as a string.",
  parameters: z.object({
    path: z.string().describe("The file path to read (relative or absolute)"),
    encoding: z
      .string()
      .optional()
      .describe("File encoding (default: utf-8)"),
  }),
  async execute(input, ctx) {
    const safePath = validatePath(input.path, ctx);
    const encoding = (input.encoding ?? "utf-8") as BufferEncoding;
    const content = await readFile(safePath, encoding);
    return content;
  },
};

const fsWriteTool: ITool<{ path: string; content: string }> = {
  skandha: 'samskara' as const,
  id: "fs.write",
  description:
    "Write content to a file. Creates the file if it does not exist, overwrites if it does.",
  parameters: z.object({
    path: z.string().describe("The file path to write to"),
    content: z.string().describe("The content to write"),
  }),
  async execute(input, ctx) {
    const safePath = validatePath(input.path, ctx);
    await writeFile(safePath, input.content, "utf-8");
    return `File written: ${safePath}`;
  },
};

const fsListTool: ITool<{ path: string; recursive?: boolean }> = {
  skandha: 'samskara' as const,
  id: "fs.list",
  description:
    "List files and directories in a directory. Returns entries with type indicators.",
  parameters: z.object({
    path: z.string().describe("The directory path to list"),
    recursive: z
      .boolean()
      .optional()
      .describe("List recursively (default: false)"),
  }),
  async execute(input, ctx) {
    const safePath = validatePath(input.path, ctx);

    if (input.recursive) {
      const entries = await readdir(safePath, {
        recursive: true,
        withFileTypes: true,
      });
      const lines = entries.map((e) => {
        const prefix = e.isDirectory() ? "[DIR] " : "      ";
        // parentPath may be available in newer Node.js, fall back to path
        const parent = (e as { parentPath?: string }).parentPath ?? (e as { path?: string }).path ?? "";
        const fullRelative = parent ? `${relative(safePath, parent)}/${e.name}` : e.name;
        return `${prefix}${fullRelative}`;
      });
      return lines.join("\n") || "(empty directory)";
    }

    const entries = await readdir(safePath, { withFileTypes: true });
    const lines = entries.map((e) => {
      const prefix = e.isDirectory() ? "[DIR] " : "      ";
      return `${prefix}${e.name}`;
    });
    return lines.join("\n") || "(empty directory)";
  },
};

const fsMkdirTool: ITool<{ path: string }> = {
  skandha: 'samskara' as const,
  id: "fs.mkdir",
  description: "Create a directory (including parent directories if needed).",
  parameters: z.object({
    path: z.string().describe("The directory path to create"),
  }),
  async execute(input, ctx) {
    const safePath = validatePath(input.path, ctx);
    await mkdir(safePath, { recursive: true });
    return `Directory created: ${safePath}`;
  },
};

const fsDeleteTool: ITool<{ path: string }> = {
  skandha: 'samskara' as const,
  id: "fs.delete",
  description:
    "Delete a file or directory. Directories are deleted recursively.",
  parameters: z.object({
    path: z.string().describe("The path to delete"),
  }),
  async execute(input, ctx) {
    const safePath = validatePath(input.path, ctx);
    const stats = await stat(safePath);
    if (stats.isDirectory()) {
      await rm(safePath, { recursive: true });
      return `Directory deleted: ${safePath}`;
    }
    await rm(safePath);
    return `File deleted: ${safePath}`;
  },
};

// ─── Plugin Export ───

export function createFsPlugin(): IPlugin {
  return {
    manifest: {
      name: "standard-function-fs",
      version: "0.1.0-alpha",
      description: "File system tools (read, write, list, mkdir, delete)",
      skandha: 'samskara' as const,
    },

    async factory(_ctx: IPluginContext): Promise<PluginHooks> {
      return {
        tools: [fsReadTool, fsWriteTool, fsListTool, fsMkdirTool, fsDeleteTool],
      };
    },
  };
}

export default createFsPlugin;
