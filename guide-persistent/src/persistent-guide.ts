/**
 * PersistentGuide — IPersistentGuide implementation.
 *
 * Manages persistent cognitive directives with file-backed storage.
 * maxDirectives = 100 (default). addDirective() rejects when exceeded.
 *
 * @skandha vijnana (識蘊)
 */

import type { CognitiveDirective, IPersistentGuide } from "@openstarry/sdk";
import type { DirectiveStorage } from "./storage.js";
import type { GuidePersistentConfig } from "./types.js";

export function createPersistentGuide(
  id: string,
  name: string,
  storage: DirectiveStorage,
  basePrompt: string,
  config?: GuidePersistentConfig,
): IPersistentGuide {
  const maxDirectives = config?.maxDirectives ?? 100;
  let directives: CognitiveDirective[] = [];
  let loaded = false;

  function ensureLoaded(): void {
    if (!loaded) {
      directives = storage.load();
      loaded = true;
    }
  }

  function filterExpired(): void {
    const now = new Date().toISOString();
    directives = directives.filter(d => !d.expiresAt || d.expiresAt > now);
  }

  return {
    skandha: 'vijnana',
    id,
    name,

    async addDirective(directive: CognitiveDirective): Promise<void> {
      ensureLoaded();
      filterExpired();
      if (directives.length >= maxDirectives) {
        throw new Error(`Maximum directives (${maxDirectives}) exceeded`);
      }
      directives.push(directive);
      storage.save(directives);
    },

    async removeDirective(directiveId: string): Promise<boolean> {
      ensureLoaded();
      const idx = directives.findIndex(d => d.id === directiveId);
      if (idx === -1) return false;
      directives.splice(idx, 1);
      storage.save(directives);
      return true;
    },

    async clearDirectives(): Promise<void> {
      directives = [];
      loaded = true;
      storage.save(directives);
    },

    async listDirectives(): Promise<CognitiveDirective[]> {
      ensureLoaded();
      filterExpired();
      return [...directives];
    },

    async getSystemPrompt(): Promise<string> {
      ensureLoaded();
      filterExpired();
      if (directives.length === 0) return basePrompt;

      const sorted = [...directives].sort((a, b) => b.priority - a.priority);
      const directiveBlock = sorted
        .map(d => `[${d.label}] ${d.content}`)
        .join('\n');

      return `${basePrompt}\n\n## Persistent Directives\n${directiveBlock}`;
    },
  };
}
