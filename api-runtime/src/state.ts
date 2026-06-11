/**
 * api-runtime / state — in-memory plugin runtime state registry.
 *
 * **Plugin-internal namespace** per Plan59 §5.1 + boundary invariant §6.2.
 * `PluginRuntimeRecord` is NOT exported through any IRuntime method that
 * could expose ε-surface envelope fields. The on-the-wire shape used by
 * `observe()` is `PluginRuntimeStateView` from `@openstarry/sdk`.
 *
 * **Default state on registration**: log_level=info / debug_flag=false /
 * soft_tracing=false. These three are the only mutable fields per Plan59
 * §6.3 bounded intervention 4-tuple.
 */

import type { LogLevel } from '@openstarry/sdk';

/**
 * Per-plugin record held in the registry. Plugin-internal type — fields
 * MUST NOT be re-exported through any ε-surface envelope schema.
 */
export interface PluginRuntimeRecord {
  log_level: LogLevel;
  debug_flag: boolean;
  soft_tracing: boolean;
}

const DEFAULT_RECORD: PluginRuntimeRecord = Object.freeze({
  log_level: 'info' as const,
  debug_flag: false,
  soft_tracing: false,
});

/**
 * Snapshot the default record for a newly registered plugin. Returned
 * record is mutable so call sites may apply intervention before insertion.
 */
export function newRecord(): PluginRuntimeRecord {
  return { ...DEFAULT_RECORD };
}

/**
 * In-memory registry — `Map<plugin_id, PluginRuntimeRecord>`. Single-process
 * lifetime per Plan59 §6 forward constraint (cross-process out of scope this
 * cycle).
 */
export class PluginStateRegistry {
  private readonly store = new Map<string, PluginRuntimeRecord>();

  /** Register a plugin with default state. Idempotent — re-register is no-op. */
  register(plugin_id: string): void {
    if (!this.store.has(plugin_id)) {
      this.store.set(plugin_id, newRecord());
    }
  }

  /** Return true if plugin_id is registered. */
  has(plugin_id: string): boolean {
    return this.store.has(plugin_id);
  }

  /**
   * Read a defensive snapshot of a plugin's record. Returns null on
   * unknown plugin. Mutating the returned object does NOT affect the registry.
   */
  snapshot(plugin_id: string): PluginRuntimeRecord | null {
    const r = this.store.get(plugin_id);
    return r ? { ...r } : null;
  }

  /**
   * Apply a partial mutation under the bounded intervention 4-tuple.
   * Returns false on unknown plugin (caller maps to `plugin_unregistered`).
   */
  mutate(plugin_id: string, patch: Partial<PluginRuntimeRecord>): boolean {
    const r = this.store.get(plugin_id);
    if (!r) return false;
    if (patch.log_level !== undefined) r.log_level = patch.log_level;
    if (patch.debug_flag !== undefined) r.debug_flag = patch.debug_flag;
    if (patch.soft_tracing !== undefined) r.soft_tracing = patch.soft_tracing;
    return true;
  }

  /** Iterate registered plugin ids (insertion order). */
  ids(): string[] {
    return Array.from(this.store.keys());
  }
}
