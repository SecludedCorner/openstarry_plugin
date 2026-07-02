/**
 * Persistence — atomic, debounced seed-store persistence to disk (C#2 Step B).
 *
 * D7 (Agent_Memory_Reference): the semantic seed store gets the disk persistence
 * it currently lacks, reusing the session-persistence pattern (atomic tmp+rename,
 * debounced). Path per #4/#5: $OPENSTARRY_HOME/memory/{agentId}/alaya-seeds.json.
 *
 * LOAD is via re-plant (see index.ts), NOT restoreSnapshot(): distributed-alaya
 * uses a fresh per-process HMAC key + restoreSnapshot enforces signature re-verify
 * and a 30s freshness window (mesh late-joiner semantics), both wrong for a
 * single-agent restart. plant() preserves every field verbatim and only
 * regenerates the in-process signature — satisfying the "field-for-field
 * identical on reload" bottom line without persisting a key at rest.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ISeed } from "@openstarry/sdk";

export const PERSIST_VERSION = 1;

export interface PersistedSeeds {
  readonly version: number;
  readonly savedAt: number;
  readonly seeds: ISeed[];
}

/** Resolve the seed-store path per #4/#5 ($OPENSTARRY_HOME/memory/{agentId}/alaya-seeds.json). */
export function resolveSeedStorePath(agentId: string, configPath?: string): string {
  if (configPath && configPath.length > 0) {
    return isAbsolute(configPath) ? configPath : join(process.cwd(), configPath);
  }
  const envHome = process.env.OPENSTARRY_HOME;
  const home = envHome && envHome.length > 0 ? envHome : join(homedir(), ".openstarry");
  return join(home, "memory", agentId, "alaya-seeds.json");
}

/** Read + parse persisted seeds. Returns [] on absent/empty/corrupt (never throws). */
export function loadSeedsFromDisk(path: string): ISeed[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedSeeds>;
    return parsed && Array.isArray(parsed.seeds) ? (parsed.seeds as ISeed[]) : [];
  } catch {
    return [];
  }
}

/** Atomic write: mkdir -p → write tmp → rename. `now` injectable for tests. */
export function writeSeedsToDisk(
  path: string,
  seeds: readonly ISeed[],
  now: () => number = Date.now,
): void {
  const payload: PersistedSeeds = { version: PERSIST_VERSION, savedAt: now(), seeds: [...seeds] };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmp, path);
}

/** Trailing debouncer for the off-turn deposit job. */
export function createDebouncer(ms: number): {
  schedule: (fn: () => void) => void;
  flush: () => void;
  cancel: () => void;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;
  const fire = () => {
    const fn = pending;
    pending = null;
    timer = null;
    if (fn) fn();
  };
  return {
    schedule(fn) {
      pending = fn;
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, ms);
      if (typeof timer.unref === "function") timer.unref(); // don't keep the process alive
    },
    flush() {
      if (timer) clearTimeout(timer);
      fire();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}
