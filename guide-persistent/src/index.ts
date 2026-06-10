/**
 * @openstarry-plugin/guide-persistent
 *
 * Persistent cognitive directives (vijnana — sixth consciousness).
 *
 * 二諦聲明 (Two Truths Declaration):
 * - 世俗諦: This plugin persists behavioral directives to disk for cross-session continuity.
 * - 勝義諦: Persistent self-view (ātma-dṛṣṭi) is the sixth consciousness's function —
 *   it conditions but does not determine behavior. All directives are conventionally
 *   designated labels, not inherently existent instructions.
 *
 * @skandha vijnana (識蘊)
 * @criticality optional-no-effect
 */

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { createDirectiveStorage } from "./storage.js";
import { createPersistentGuide } from "./persistent-guide.js";
import type { GuidePersistentConfig } from "./types.js";

export function createGuidePersistentPlugin(): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/guide-persistent',
      version: '0.1.0-alpha',
      description: 'Persistent cognitive directives (vijnana — sixth consciousness)',
      skandha: 'vijnana',
      criticality: 'optional-no-effect',
      dependencies: ['guide-character-init'],
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const config = ctx.config as Partial<GuidePersistentConfig> ?? {};
      const storage = createDirectiveStorage(ctx.agentId, config.storagePath);

      const guide = createPersistentGuide(
        'persistent-guide',
        'Persistent Cognitive Guide',
        storage,
        '',  // Base prompt empty — layered on top of guide-character-init
        config,
      );

      return {
        guides: [guide],
      };
    },
  };
}

export { createPersistentGuide } from "./persistent-guide.js";
export { createDirectiveStorage } from "./storage.js";
export type { GuidePersistentConfig, DirectiveStore } from "./types.js";
export default createGuidePersistentPlugin;
