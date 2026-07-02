/**
 * standard-function-search — code search/grep ITool plugin (samskara/行蘊).
 *
 * Gives a coding agent the eyes it was missing: `code.search` (grep across files) and
 * `code.glob` (find files by glob). Pure Node (no external deps), read-only. Confined to
 * ctx.allowedPaths via the shared symlink-aware realpath jail (@openstarry/shared, the
 * same single source of truth used by core's SecurityLayer and standard-function-fs), and
 * the directory walk does NOT follow symlinks — so a search cannot read outside the jail.
 * Microkernel-pure: import surface = @openstarry/sdk + @openstarry/shared + node: + zod.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  ITool,
  ToolContext,
} from "@openstarry/sdk";
import { realpathJail } from "@openstarry/shared";

/** Directories never descended into (huge / irrelevant for code search). */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo", ".cache",
]);
/** Files larger than this are skipped (likely binary / generated). */
const MAX_FILE_BYTES = 2_000_000;
/** Hard ceiling on files visited per call (runaway guard). */
const MAX_FILES_VISITED = 20_000;

/** Convert a simple glob to an anchored RegExp. `**`=any incl. separators, `*`=within a
 *  segment, `?`=one non-separator char. Paths are normalized to forward slashes first. */
function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (glob[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else {
      re += /[.+^${}()|[\]\\]/.test(c) ? "\\" + c : c;
      i++;
    }
  }
  return new RegExp(re + "$");
}

const fwd = (p: string): string => p.replaceAll("\\", "/");

/** Walk files under `root`, depth-first, skipping SKIP_DIRS and NOT following symlinks. */
async function* walkFiles(root: string, budget: { n: number }): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (budget.n >= MAX_FILES_VISITED) return;
    if (e.isSymbolicLink()) continue; // jail safety: never traverse symlinks
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkFiles(full, budget);
    } else if (e.isFile()) {
      budget.n++;
      yield full;
    }
  }
}

function makeSearchTool(): ITool<{
  query: string;
  path?: string;
  regex?: boolean;
  glob?: string;
  ignoreCase?: boolean;
  maxResults?: number;
}> {
  return {
    skandha: "samskara" as const,
    id: "code.search",
    description:
      "Search file contents (grep) under a directory. Returns matching lines as " +
      "'relative/path:line: text'. Substring by default; set regex:true for a JS regex. " +
      "Optional glob filters files (e.g. '*.ts' or 'src/**/*.ts'). Confined to allowed paths.",
    metadata: { hasSideEffects: false, riskCategory: "safe" as const },
    parameters: z.object({
      query: z.string().describe("Substring or (with regex:true) a JS regular expression."),
      path: z.string().optional().describe("Directory to search (default '.')."),
      regex: z.boolean().optional().describe("Treat query as a regex (default false)."),
      glob: z.string().optional().describe("Filter files by glob, e.g. '*.ts' or 'src/**/*.ts'."),
      ignoreCase: z.boolean().optional().describe("Case-insensitive match (default false)."),
      maxResults: z.number().optional().describe("Max matching lines to return (default 100)."),
    }),
    async execute(input, ctx: ToolContext) {
      const root = realpathJail(input.path ?? ".", {
        workingDirectory: ctx.workingDirectory,
        allowedPaths: ctx.allowedPaths,
      });
      const max = input.maxResults ?? 100;
      const matcher = input.regex
        ? new RegExp(input.query, input.ignoreCase ? "i" : "")
        : null;
      const needle = input.ignoreCase ? input.query.toLowerCase() : input.query;
      const fileRe = input.glob ? globToRegExp(input.glob) : null;
      const globHasSlash = input.glob ? input.glob.includes("/") : false;

      const out: string[] = [];
      const budget = { n: 0 };
      for await (const file of walkFiles(root, budget)) {
        if (out.length >= max) break;
        if (fileRe) {
          const rel = fwd(relative(root, file));
          const candidate = globHasSlash ? rel : (rel.split("/").pop() ?? rel);
          if (!fileRe.test(candidate)) continue;
        }
        let st;
        try { st = await stat(file); } catch { continue; }
        if (st.size > MAX_FILE_BYTES) continue;
        let content: string;
        try { content = await readFile(file, "utf-8"); } catch { continue; } // skip binary/unreadable
        const lines = content.split("\n");
        const relName = fwd(relative(root, file));
        for (let i = 0; i < lines.length && out.length < max; i++) {
          const line = lines[i];
          const hit = matcher
            ? matcher.test(line)
            : (input.ignoreCase ? line.toLowerCase() : line).includes(needle);
          if (hit) out.push(`${relName}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      }
      return out.length ? out.join("\n") : "(no matches)";
    },
  };
}

function makeGlobTool(): ITool<{ pattern: string; path?: string; maxResults?: number }> {
  return {
    skandha: "samskara" as const,
    id: "code.glob",
    description:
      "Find files by glob pattern under a directory (e.g. '**/*.test.ts'). Returns relative " +
      "paths, one per line. Confined to allowed paths; skips node_modules/.git/dist.",
    metadata: { hasSideEffects: false, riskCategory: "safe" as const },
    parameters: z.object({
      pattern: z.string().describe("Glob, e.g. '*.ts', 'src/**/*.ts', '**/*.test.ts'."),
      path: z.string().optional().describe("Directory to search (default '.')."),
      maxResults: z.number().optional().describe("Max files to return (default 200)."),
    }),
    async execute(input, ctx: ToolContext) {
      const root = realpathJail(input.path ?? ".", {
        workingDirectory: ctx.workingDirectory,
        allowedPaths: ctx.allowedPaths,
      });
      const max = input.maxResults ?? 200;
      const re = globToRegExp(input.pattern);
      const hasSlash = input.pattern.includes("/");
      const out: string[] = [];
      const budget = { n: 0 };
      for await (const file of walkFiles(root, budget)) {
        if (out.length >= max) break;
        const rel = fwd(relative(root, file));
        const candidate = hasSlash ? rel : (rel.split("/").pop() ?? rel);
        if (re.test(candidate)) out.push(rel);
      }
      return out.length ? out.join("\n") : "(no files matched)";
    },
  };
}

export function createSearchPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/standard-function-search",
      version: "0.1.0-alpha",
      description: "Code search tools: code.search (grep) + code.glob (find files), realpath-jailed, read-only",
      skandha: "samskara" as const,
    },
    async factory(_ctx: IPluginContext): Promise<PluginHooks> {
      return { tools: [makeSearchTool(), makeGlobTool()] };
    },
  };
}

export default createSearchPlugin;
