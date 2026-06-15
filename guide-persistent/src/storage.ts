/**
 * Directive storage — file I/O with atomic write.
 *
 * Storage path: ~/.openstarry/guides/<agentId>/directives.json
 * Atomic write: write-to-temp + rename
 * Security: isPathSafe() + isSymlink() double validation (Baseline Rule #12, D4-R5)
 *
 * @skandha vijnana (識蘊)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { CognitiveDirective } from "@openstarry/sdk";
import type { DirectiveStore } from "./types.js";

/**
 * Check if targetPath is safely within basePath (no traversal).
 */
function isPathSafe(basePath: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(path.normalize(basePath));
  const resolvedTarget = path.resolve(path.normalize(targetPath));
  return resolvedTarget === resolvedBase ||
    resolvedTarget.startsWith(resolvedBase + "/") ||
    resolvedTarget.startsWith(resolvedBase + "\\");
}

/**
 * Check if a path is a symbolic link.
 */
function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface DirectiveStorage {
  load(): CognitiveDirective[];
  save(directives: CognitiveDirective[]): void;
}

export function createDirectiveStorage(agentId: string, overridePath?: string): DirectiveStorage {
  const baseDir = overridePath ?? path.join(os.homedir(), '.openstarry');
  const guideDir = path.join(baseDir, 'guides', agentId);
  const filePath = path.join(guideDir, 'directives.json');

  function validatePath(): void {
    const resolvedBase = fs.existsSync(baseDir)
      ? fs.realpathSync(baseDir)
      : path.resolve(baseDir);

    if (!isPathSafe(resolvedBase, filePath)) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }
    if (isSymlink(filePath)) {
      throw new Error(`Symlink detected at guide storage path: ${filePath}`);
    }
    if (fs.existsSync(guideDir) && isSymlink(guideDir)) {
      throw new Error(`Symlink detected at guide directory: ${guideDir}`);
    }
  }

  function ensureDir(): void {
    if (!fs.existsSync(guideDir)) {
      fs.mkdirSync(guideDir, { recursive: true });
    }
  }

  return {
    load(): CognitiveDirective[] {
      validatePath();
      if (!fs.existsSync(filePath)) return [];
      const raw = fs.readFileSync(filePath, 'utf8');
      const store = JSON.parse(raw) as DirectiveStore;
      return store.directives ?? [];
    },

    save(directives: CognitiveDirective[]): void {
      validatePath();
      ensureDir();
      const store: DirectiveStore = { version: 1, directives };
      const content = JSON.stringify(store, null, 2);
      // Atomic write: write to temp, then rename.
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, content, 'utf8');
      // Windows can return a transient EPERM on rename when another handle
      // (AV scanner, indexer, a lingering reader) momentarily holds the target
      // or the just-written temp file. Retry a few times with a tiny backoff —
      // the rename is atomic, so a retry simply waits out the transient lock.
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.renameSync(tmpPath, filePath);
          return;
        } catch (err) {
          lastErr = err;
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
          // brief synchronous backoff (≈1ms × attempt) before retrying
          const until = Date.now() + (attempt + 1);
          while (Date.now() < until) { /* spin briefly */ }
        }
      }
      throw lastErr;
    },
  };
}
