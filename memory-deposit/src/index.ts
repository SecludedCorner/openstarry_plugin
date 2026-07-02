/**
 * @openstarry-plugin/memory-deposit
 *
 * C#2 Step B — the deposit / perfuming (vāsanā) write path for the ālaya memory
 * loop. Subscribes to LOOP_FINISHED (off-turn, debounced), mines the new messages
 * for durable preference/convention/correction facts via the configured provider,
 * plants them as `samskara` ISeeds into the shared ālaya store, and persists the
 * store to disk (atomic tmp+rename). On startup it faithfully re-plants persisted
 * seeds (preserving every field, only the in-process HMAC signature regenerates).
 *
 * The store is reused from distributed-alaya's exported factories (MR-12), keyed
 * by ctx.agentId, and registered as the DISTRIBUTED_ALAYA service so C#2 Step D's
 * gated retrieval (in memory-context) reads the SAME store. This plugin is the
 * sole registrant of that service — do NOT also JSON-load distributed-alaya.
 *
 * Tenets: #8 (deposit→retrieve feedback path; gate threshold is the control knob,
 * added in Step D), #6 (8th-consciousness single-agent functional), #3 (ISeed.
 * skandha), #4/#5 ($OPENSTARRY_HOME/memory/{agentId}/, private visibility),
 * #2/#7 (core untouched; all knobs in plugin config), #1 (per-agent, no resident
 * daemon), MR-12 (reuse distributed-alaya / no parallel store).
 *
 * @skandha samskara (行蘊 — vāsanā perfuming)
 */

import type {
  AgentEvent,
  IDistributedAlaya,
  IPlugin,
  IPluginContext,
  IPluginService,
  IProvider,
  PluginHooks,
} from "@openstarry/sdk";
import { AgentEventType, SERVICE_KEYS } from "@openstarry/sdk";
import {
  createBijaStore,
  createDistributedAlaya,
  createSeedSignatureService,
} from "@openstarry-plugin/distributed-alaya";
import {
  buildExtractionMessages,
  parseExtractionResponse,
  type ExtractedFact,
} from "./extract.js";
import { runDeposit } from "./deposit.js";
import {
  createDebouncer,
  loadSeedsFromDisk,
  resolveSeedStorePath,
  writeSeedsToDisk,
} from "./persistence.js";

export interface MemoryDepositConfig {
  readonly enabled?: boolean;
  /** Extraction provider id. Default: the first registered provider. */
  readonly provider?: string;
  /** Extraction model id. Default: provider.models[0].id, else "sonnet". */
  readonly model?: string;
  /** Off-turn debounce before running extraction (ms). */
  readonly debounceMs?: number;
  /** Abort the extraction LLM call after this long (ms). */
  readonly timeoutMs?: number;
  /** Max new messages fed to the extractor per deposit. */
  readonly recentTurns?: number;
  /** Per-message content cap in the transcript (bulky → reference, D1). */
  readonly maxContentChars?: number;
  /** Max facts planted per deposit. */
  readonly maxFactsPerTurn?: number;
  /** Seed-store path. Default: $OPENSTARRY_HOME/memory/{agentId}/alaya-seeds.json. */
  readonly persistPath?: string;
}

const DEFAULTS = {
  debounceMs: 1500,
  timeoutMs: 30000,
  recentTurns: 8,
  maxContentChars: 2000,
  maxFactsPerTurn: 5,
} as const;

export { runDeposit, factToSeed, type SeedContent, type RunDepositDeps } from "./deposit.js";
export {
  buildExtractionMessages,
  parseExtractionResponse,
  messagesToTranscript,
  EXTRACT_SYSTEM_PROMPT,
  type ExtractedFact,
  type FactType,
} from "./extract.js";
export {
  resolveSeedStorePath,
  loadSeedsFromDisk,
  writeSeedsToDisk,
  createDebouncer,
} from "./persistence.js";

export function createMemoryDepositPlugin(config: MemoryDepositConfig = {}): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/memory-deposit",
      version: "0.1.0-alpha",
      description:
        "Deposit/perfuming write path (C#2 Step B): mines durable facts on LOOP_FINISHED, plants samskara seeds into the shared ālaya store, persists to disk",
      skandha: "samskara",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const cfg = { ...config, ...((ctx.config ?? {}) as MemoryDepositConfig) };
      if (cfg.enabled === false) return {};

      const agentId = ctx.agentId;
      const debounceMs = cfg.debounceMs ?? DEFAULTS.debounceMs;
      const timeoutMs = cfg.timeoutMs ?? DEFAULTS.timeoutMs;
      const recentTurns = cfg.recentTurns ?? DEFAULTS.recentTurns;
      const maxContentChars = cfg.maxContentChars ?? DEFAULTS.maxContentChars;
      const maxFacts = cfg.maxFactsPerTurn ?? DEFAULTS.maxFactsPerTurn;
      const storePath = resolveSeedStorePath(agentId, cfg.persistPath);

      // --- ālaya store: consume the DISTRIBUTED_ALAYA service if present, else
      //     create it from distributed-alaya's factories and register (sole registrant). ---
      let alaya: IDistributedAlaya;
      const existing = ctx.services?.get(SERVICE_KEYS.DISTRIBUTED_ALAYA) as
        | { getDistributedAlaya?: () => IDistributedAlaya }
        | undefined;
      if (existing?.getDistributedAlaya) {
        alaya = existing.getDistributedAlaya();
      } else {
        const sig = createSeedSignatureService();
        const bija = createBijaStore(agentId, sig);
        alaya = createDistributedAlaya(agentId, bija, sig);
        ctx.services?.register({
          name: "distributed-alaya",
          version: "0.1.0-alpha",
          getDistributedAlaya: () => alaya,
        } as IPluginService & { getDistributedAlaya: () => IDistributedAlaya });
      }

      // --- rehydrate persisted seeds: faithful re-plant (all fields preserved, signature re-generated) ---
      let loaded = 0;
      for (const seed of loadSeedsFromDisk(storePath)) {
        try {
          await alaya.plant(seed);
          loaded++;
        } catch {
          /* skip a seed that fails F-8 / validation — never break startup */
        }
      }
      if (loaded > 0) console.error(`[memory-deposit] rehydrated ${loaded} seed(s) from ${storePath}`);

      // --- provider for off-turn extraction (resolved LAZILY: this plugin may load
      //     before the provider plugin, so ctx.providers is empty at factory time;
      //     it is populated by deposit time, which is well after startup). ---
      async function extractViaProvider(transcript: string): Promise<ExtractedFact[]> {
        const provider: IProvider | undefined = cfg.provider
          ? ctx.providers?.get(cfg.provider)
          : ctx.providers?.list()?.[0];
        if (!provider) return [];
        const model = cfg.model ?? provider.models?.[0]?.id ?? "sonnet";
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const messages = buildExtractionMessages(transcript);
          let text = "";
          for await (const ev of provider.chat({
            model,
            messages,
            maxTokens: 1024,
            temperature: 0,
            signal: controller.signal,
          })) {
            if (ev.type === "text_delta") text += ev.text;
          }
          return parseExtractionResponse(text, maxFacts);
        } catch {
          return [];
        } finally {
          clearTimeout(timer);
        }
      }

      // --- debounced, serialized, per-session deposit job ---
      const lastProcessed = new Map<string, number>();
      const debouncer = createDebouncer(debounceMs);
      let running = false;

      async function depositJob(sessionId: string | undefined): Promise<void> {
        if (running) return;
        running = true;
        try {
          const key = sessionId ?? "__default__";
          const messages = ctx.sessions.getStateManager(sessionId).getMessages();
          const prev = lastProcessed.get(key) ?? 0;
          if (messages.length <= prev) return;
          const newMessages = messages.slice(prev);
          lastProcessed.set(key, messages.length);

          const planted = await runDeposit({
            newMessages,
            extract: extractViaProvider,
            plant: (seed) => alaya.plant(seed),
            agentId,
            maxContentChars,
            recentTurns,
            onPlanted: (_seed, fact) =>
              console.error(
                `[memory-deposit] planted ${fact.type} seed (importance ${fact.importance}): "${fact.text.slice(0, 80)}"`,
              ),
          });

          if (planted.length > 0) {
            const snap = await alaya.snapshot();
            writeSeedsToDisk(storePath, snap.seeds);
            console.error(`[memory-deposit] persisted ${snap.seeds.length} seed(s) → ${storePath}`);
          }
        } catch (err) {
          console.error(`[memory-deposit] deposit failed: ${(err as Error).message}`);
        } finally {
          running = false;
        }
      }

      const unsub = ctx.bus.on(AgentEventType.LOOP_FINISHED, (event: AgentEvent) => {
        const sessionId = (event.payload as { sessionId?: string } | undefined)?.sessionId;
        debouncer.schedule(() => {
          void depositJob(sessionId);
        });
      });

      return {
        dispose: () => {
          unsub();
          debouncer.cancel();
        },
      };
    },
  };
}

export default createMemoryDepositPlugin;
