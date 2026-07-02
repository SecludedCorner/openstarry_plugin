export { createKeywordRetrievalContextManager, terms } from "./context.js";
export type { KeywordRetrievalOptions } from "./context.js";

import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { createKeywordRetrievalContextManager, type KeywordRetrievalOptions } from "./context.js";

export function createKeywordRetrievalContextPlugin(
  config: KeywordRetrievalOptions = {},
): IPlugin {
  return {
    manifest: {
      name: '@openstarry-plugin/context-keyword-retrieval',
      version: '0.1.0-alpha',
      description: 'Relevance-aware context manager — keeps recent turns plus the top-K older turns most lexically relevant to the latest user message (in-memory, deterministic; not a vector store)',
      skandha: 'samjna',
    },
    async factory(_ctx: IPluginContext): Promise<PluginHooks> {
      const contextManager = createKeywordRetrievalContextManager(config);
      return { contextManager };
    },
  };
}
