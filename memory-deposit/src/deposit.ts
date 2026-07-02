/**
 * Deposit orchestration (C#2 Step B) — the perfuming (vāsanā) write path.
 *
 * Pure-ish: given the new messages + an extract fn + a plant fn, mine durable
 * facts and plant them as ISeeds. Persistence is done by the caller (index.ts)
 * after this returns. Deps are injectable so the whole flow is unit-testable
 * with fakes (no LLM, no disk).
 *
 * Seed shape: preference/convention/correction facts are tagged skandha
 * `samskara` (行蘊 — volitional formations / 習氣 vāsanā), with type/text/
 * importance carried inside `content` (ISeed has no importance field; content
 * is `unknown` and is preserved verbatim by plant()).
 */

import type { ISeed, Message } from "@openstarry/sdk";
import { generateId } from "@openstarry/shared";
import { messagesToTranscript, type ExtractedFact, type FactType } from "./extract.js";

/** Structured payload stored in ISeed.content for memory facts. */
export interface SeedContent {
  readonly type: FactType;
  readonly text: string;
  readonly importance: number;
}

/** Build an ISeed from an extracted fact. nonce omitted → alaya.plant stamps it. */
export function factToSeed(
  fact: ExtractedFact,
  agentId: string,
  now: () => number = Date.now,
  genId: () => string = generateId,
): ISeed {
  const t = now();
  const content: SeedContent = { type: fact.type, text: fact.text, importance: fact.importance };
  return {
    seedId: genId(),
    agentId,
    skandha: "samskara",
    content,
    visibility: "private",
    createdAt: t,
    updatedAt: t,
  };
}

export interface RunDepositDeps {
  /** Messages new since the last deposit for this session (already sliced). */
  readonly newMessages: readonly Message[];
  /** LLM extraction (index.ts wraps the provider); returns validated facts. */
  readonly extract: (transcript: string) => Promise<ExtractedFact[]>;
  /** Plant a seed into the ālaya store. */
  readonly plant: (seed: ISeed) => Promise<void>;
  readonly agentId: string;
  readonly maxContentChars: number;
  readonly recentTurns: number;
  readonly now?: () => number;
  readonly genId?: () => string;
  readonly onPlanted?: (seed: ISeed, fact: ExtractedFact) => void;
}

/**
 * Mine the new messages for durable facts and plant them. Returns the planted
 * seeds (empty if the transcript is empty or nothing durable was found).
 */
export async function runDeposit(deps: RunDepositDeps): Promise<ISeed[]> {
  const transcript = messagesToTranscript(deps.newMessages, deps.recentTurns, deps.maxContentChars);
  if (transcript.trim().length === 0) return [];

  const facts = await deps.extract(transcript);
  if (facts.length === 0) return [];

  const planted: ISeed[] = [];
  for (const fact of facts) {
    const seed = factToSeed(fact, deps.agentId, deps.now, deps.genId);
    await deps.plant(seed);
    planted.push(seed);
    deps.onPlanted?.(seed, fact);
  }
  return planted;
}
