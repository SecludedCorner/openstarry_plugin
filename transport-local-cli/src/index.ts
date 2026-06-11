/**
 * transport-local-cli — Plan52 Phase D reference plugin.
 *
 * Local-CLI listener: stdin lines → ctx.pushInput, with **process UID + PID
 * attestation in `sourceContext`** per Plan52 R3 D-§1-09 (C-3) UNANIMOUS:
 *
 *   "For plugins running in local-CLI mode, tokenSig generation is MAY (not
 *    MUST). Process-local UID is sufficient for local trust (the OS process
 *    boundary itself is the trust delimiter)."
 *
 * **Backward compatibility**: this is a NEW plugin (not a retrofit) per MR-12.
 * Existing transport-* plugins are unmodified by Phase D.
 *
 * **CP-1 / CP-4**: sourceContext is plugin-attested + deepFrozen; Core never
 * inspects.
 *
 * **F-16**: error emission uses StructuredError schema.
 *
 * @see openstarry_doc/Technical_Specifications/Plan52_pushInput_Binding.md §5.4
 */

import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { userInfo } from "node:os";
import { randomUUID } from "node:crypto";
import { createLogger } from "@openstarry/shared";
import {
  type AgentEvent,
  type IListener,
  type IPlugin,
  type IPluginContext,
  type IUI,
  type PluginHooks,
  RecommendedSourceContextKeys,
  deepFreeze,
} from "@openstarry/sdk";

interface LocalCliConfig {
  /**
   * Optional capability set advertised in `sourceContext.capabilitySet`.
   * Defaults to a minimal `["read", "write"]` capability advertisement.
   */
  readonly capabilitySet?: readonly string[];
  /**
   * Optional tokenSig to include alongside UID. MAY-omit per D-§1-09.
   * Provide this when the local-CLI bootstraps from a parent process that
   * established a stronger trust handshake (e.g., spawned by a signed daemon).
   */
  readonly tokenSig?: string;
  /**
   * Override stdin source for testing. When omitted, uses `process.stdin`.
   */
  readonly stdin?: NodeJS.ReadableStream;
  /**
   * Override stdout source for testing. When omitted, uses `process.stdout`.
   */
  readonly stdout?: NodeJS.WritableStream;
}

/**
 * Build a frozen `sourceContext` for local-CLI attestation.
 *
 * Public so test harnesses + integration tests can construct identical context
 * without spinning up a stdin pipeline.
 */
export function buildLocalCliSourceContext(args: {
  readonly capabilitySet?: readonly string[];
  readonly tokenSig?: string;
  readonly nowMs?: number;
}): Readonly<Record<string, unknown>> {
  const u = userInfo();
  const ctx: Record<string, unknown> = {
    uid: u.uid,
    gid: u.gid,
    username: u.username,
    pid: process.pid,
    [RecommendedSourceContextKeys.ts]: args.nowMs ?? Date.now(),
    [RecommendedSourceContextKeys.capabilitySet]: [...(args.capabilitySet ?? ["read", "write"])].sort(),
    transport: "local-cli",
  };
  if (args.tokenSig !== undefined) {
    ctx[RecommendedSourceContextKeys.tokenSig] = args.tokenSig;
  }
  return deepFreeze(ctx);
}

export function createLocalCliPlugin(): IPlugin {
  return {
    manifest: {
      name: "transport-local-cli",
      version: "0.1.0-alpha",
      description: "Plan52 Phase D — local-CLI transport with UID + PID attestation",
      skandha: "rupa" as const,
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const config = (ctx.config ?? {}) as LocalCliConfig;
      const logger = createLogger("transport-local-cli");

      const inputStream = config.stdin ?? process.stdin;
      const outputStream = config.stdout ?? process.stdout;
      let rl: ReadlineInterface | null = null;
      let listenerSessionId: string | undefined;

      const listener: IListener = {
        skandha: "rupa" as const,
        id: "local-cli-listener",
        name: "Local CLI Listener",

        async start(): Promise<void> {
          // Each listener.start opens its own readline interface; one session
          // per CLI process boundary (the OS process IS the trust delimiter).
          const newSession = ctx.sessions.create();
          listenerSessionId = newSession.id;

          rl = createInterface({ input: inputStream, terminal: false });
          rl.on("line", (line) => {
            const text = line.trim();
            if (text.length === 0) return;

            const sourceContext = buildLocalCliSourceContext({
              capabilitySet: config.capabilitySet,
              tokenSig: config.tokenSig,
            });

            const requestId = `local-cli-${randomUUID()}`;
            ctx.pushInput({
              source: "local-cli",
              inputType: "user_input",
              data: text,
              replyTo: requestId,
              sessionId: listenerSessionId,
              sourceContext,
            });
          });

          rl.on("close", () => {
            logger.debug("local-cli stdin closed");
          });
        },

        async stop(): Promise<void> {
          if (rl) {
            rl.close();
            rl = null;
          }
          if (listenerSessionId) {
            ctx.sessions.destroy(listenerSessionId);
            listenerSessionId = undefined;
          }
        },
      };

      // ─── UI: write text deltas / loop_finished to stdout ───
      const ui: IUI = {
        skandha: "rupa" as const,
        id: "local-cli-ui",
        name: "Local CLI UI",

        onEvent(event: AgentEvent): void {
          const payload = event.payload as Record<string, unknown> | undefined;
          // Only forward events that belong to our listener session.
          const eventSession = payload?.sessionId as string | undefined;
          if (eventSession && listenerSessionId && eventSession !== listenerSessionId) return;

          if (event.type === "stream:text_delta") {
            const text = (payload?.text as string | undefined) ?? "";
            outputStream.write(text);
          } else if (event.type === "loop:finished") {
            outputStream.write("\n");
          } else if (event.type === "loop:error") {
            const err = (payload?.error as string | undefined) ?? "unknown error";
            outputStream.write(`\n[error] ${err}\n`);
          }
        },
      };

      return {
        listeners: [listener],
        ui: [ui],
        async dispose() {
          await listener.stop?.();
        },
      };
    },
  };
}

export default createLocalCliPlugin;
