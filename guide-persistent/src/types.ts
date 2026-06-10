/**
 * guide-persistent plugin config types.
 * @skandha vijnana (識蘊)
 */

import type { CognitiveDirective } from "@openstarry/sdk";

export interface GuidePersistentConfig {
  readonly maxDirectives?: number;  // default: 100
  readonly storagePath?: string;     // override ~/.openstarry/guides/<agentId>
}

export interface DirectiveStore {
  readonly version: 1;
  readonly directives: CognitiveDirective[];
}
