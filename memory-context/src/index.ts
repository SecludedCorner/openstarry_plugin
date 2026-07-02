/**
 * @openstarry-plugin/memory-context
 *
 * THE memory-aware context manager (Tenet #9 — pluggable context strategy;
 * contextManager is last-wins, so there is exactly one). Composes, per turn:
 *
 *   1. Pinned core block (C#2 Step A, Pattern A) — always-on, char-capped,
 *      no gating; read from $OPENSTARRY_HOME/memory/{agentId}/core-block.md.
 *   2. Gated ālaya recall (C#2 Step D, Pattern B) — reads the SHARED seed
 *      store (DISTRIBUTED_ALAYA service, registered by memory-deposit) through
 *      a swappable relevance sub-strategy (config: keyword/none; vector = walk
 *      phase) behind an ABSOLUTE score floor + dedup + token budget. Injected
 *      as one labeled system block, framed as data-not-instructions.
 *   3. Windowing — reuses context-sliding-window's createContextManager (MR-12).
 *
 * Sync/async bridge: assembleContext is synchronous but alaya.query() is async,
 * so recall reads a seed cache that is refreshed fire-and-forget at
 * AGENT_STARTED (rehydrated seeds land before the first turn), at every
 * assembleContext call, and shortly after LOOP_FINISHED (to pick up seeds the
 * off-turn deposit just planted). Worst case a brand-new seed is one turn
 * stale — deposit itself is off-turn, so this is inherent to the loop shape.
 *
 * Observability (injection-rate audit): each time the recalled set changes, a
 * `[memory-context] recalled …` line is logged. Injection on ~100% of turns
 * means the gate is broken — when in doubt, retrieve less.
 *
 * @skandha samjna (想蘊)
 */

import type {
  AgentEvent,
  IContextManager,
  IDistributedAlaya,
  IPlugin,
  IPluginContext,
  ISeed,
  Message,
  PluginHooks,
} from "@openstarry/sdk";
import { AgentEventType, SERVICE_KEYS } from "@openstarry/sdk";
import { generateId } from "@openstarry/shared";
import { createContextManager } from "@openstarry-plugin/context-sliding-window";
import { buildCoreBlockMessage, type CoreBlockConfig } from "./core-block.js";
import {
  DEFAULT_RETRIEVAL_CONFIG,
  extractQueryText,
  formatRecallBlock,
  resolveStrategy,
  selectForInjection,
  type RetrievalConfig,
} from "./retrieval.js";

export {
  createCoreBlockContextManager,
  buildCoreBlockMessage,
  readCoreBlock,
  resolveCoreBlockPath,
  DEFAULT_CORE_BLOCK_CONFIG,
} from "./core-block.js";
export type { CoreBlockConfig } from "./core-block.js";
export {
  DEFAULT_RETRIEVAL_CONFIG,
  effectiveTermCount,
  extractQueryText,
  formatRecallBlock,
  keywordStrategy,
  noneStrategy,
  resolveStrategy,
  seedToFact,
  selectForInjection,
} from "./retrieval.js";
export type {
  MemoryFact,
  RelevanceStrategy,
  RetrievalConfig,
  ScoredFact,
} from "./retrieval.js";

/** Plugin config: coreBlock (Step A) + retrieval (Step D). */
export interface MemoryContextPluginConfig {
  readonly coreBlock?: CoreBlockConfig;
  readonly retrieval?: RetrievalConfig;
}

/** Accept either the nested config or (legacy Step A) a flat CoreBlockConfig. */
function normalizeConfig(
  raw: MemoryContextPluginConfig | CoreBlockConfig | undefined,
): MemoryContextPluginConfig {
  if (!raw) return {};
  if ("coreBlock" in raw || "retrieval" in raw) return raw as MemoryContextPluginConfig;
  return { coreBlock: raw as CoreBlockConfig };
}

export function createMemoryContextPlugin(
  config: MemoryContextPluginConfig | CoreBlockConfig = {},
): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/memory-context",
      version: "0.1.0-alpha",
      description:
        "Memory-aware context manager — pinned core block (Pattern A) + gated ālaya recall behind an absolute-score floor (Pattern B, swappable keyword/none sub-strategy) composed over the sliding window",
      skandha: "samjna",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const cfg = normalizeConfig(
        (ctx.config as MemoryContextPluginConfig | CoreBlockConfig | undefined) ?? config,
      );
      const coreBlockCfg = cfg.coreBlock ?? {};
      const retrievalCfg = { ...DEFAULT_RETRIEVAL_CONFIG, ...cfg.retrieval };
      const strategy = resolveStrategy(retrievalCfg.strategy);
      const windowCM = createContextManager();

      // --- seed cache over the SHARED ālaya store (service registered by
      //     memory-deposit, which loads after us → resolve lazily). ---
      let seedCache: ISeed[] = [];
      const getAlaya = (): IDistributedAlaya | undefined =>
        (
          ctx.services?.get(SERVICE_KEYS.DISTRIBUTED_ALAYA) as
            | { getDistributedAlaya?: () => IDistributedAlaya }
            | undefined
        )?.getDistributedAlaya?.();
      const refreshCache = (): void => {
        const alaya = getAlaya();
        if (!alaya) return;
        void alaya
          .query({ agentId: ctx.agentId })
          .then((seeds) => {
            seedCache = seeds;
          })
          .catch(() => {
            /* keep the previous cache — recall degrades, never breaks the loop */
          });
      };

      let postLoopTimer: ReturnType<typeof setTimeout> | null = null;
      const unsubs = [
        // Prime after all plugins load (memory-deposit's rehydration is awaited
        // in its factory, so rehydrated seeds are queryable before first turn).
        ctx.bus.on(AgentEventType.AGENT_STARTED, () => refreshCache()),
        // Pick up seeds the off-turn deposit plants after each loop.
        ctx.bus.on(AgentEventType.LOOP_FINISHED, (_e: AgentEvent) => {
          if (postLoopTimer) clearTimeout(postLoopTimer);
          postLoopTimer = setTimeout(refreshCache, retrievalCfg.refreshDelayAfterLoopMs);
          if (typeof postLoopTimer.unref === "function") postLoopTimer.unref();
        }),
      ];

      let lastLogKey = "";
      const contextManager: IContextManager = {
        assembleContext(messages: Message[], maxTurns: number): Message[] {
          refreshCache(); // fire-and-forget; lands for the next call
          const windowed = windowCM.assembleContext(messages, maxTurns);
          const out: Message[] = [];

          const pinned = buildCoreBlockMessage(ctx.agentId, coreBlockCfg);
          if (pinned) out.push(pinned);

          if (strategy.name !== "none" && seedCache.length > 0) {
            const queryText = extractQueryText(messages);
            if (queryText) {
              const selected = selectForInjection(
                queryText,
                seedCache,
                retrievalCfg,
                strategy.fn,
              );
              if (selected.length > 0) {
                out.push({
                  id: generateId(),
                  role: "system",
                  content: [
                    { type: "text", text: formatRecallBlock(selected, retrievalCfg.label) },
                  ],
                  createdAt: Date.now(),
                });
                // Injection-rate audit line — log once per distinct selection.
                const logKey = selected.map((f) => f.seed.seedId).join(",");
                if (logKey !== lastLogKey) {
                  lastLogKey = logKey;
                  console.error(
                    `[memory-context] recalled ${selected.length} seed(s): ` +
                      selected
                        .map((f) => `[${f.type} s=${f.score.toFixed(2)}] "${f.text.slice(0, 60)}"`)
                        .join(" · "),
                  );
                }
              }
            }
          }

          out.push(...windowed);
          return out;
        },
      };

      return {
        contextManager,
        dispose: () => {
          for (const u of unsubs) u();
          if (postLoopTimer) clearTimeout(postLoopTimer);
        },
      };
    },
  };
}

export default createMemoryContextPlugin;
