/**
 * standard-model-selector — Aggregates /provider subcommands (status, model).
 *
 * Owns the "cognition-config" service: registers it on init, provides
 * per-session model/provider selection via SessionConfig metadata.
 *
 * Handles:
 * - `/provider status`  → Aggregate status from all registered providers
 * - `/provider model`   → List available models from configured providers
 * - `/provider model <id>` → Set runtime model via cognition-config service
 * - Other subcommands   → return undefined (pass to next handler)
 */

import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  SlashCommand,
  IProvider,
  ICognitionConfigService,
} from "@openstarry/sdk";
import { getSessionConfig, setSessionConfig } from "@openstarry/sdk";

export function createModelSelectorPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/standard-model-selector",
      version: "0.1.0-alpha",
      description: "Provider status aggregation and model selection",
      services: ["cognition-config"],
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      // ─── Cognition config service (per-session + global) ───
      let globalModel: string | undefined;
      let globalProvider: string | undefined;

      const cognitionConfigService: ICognitionConfigService = {
        name: "cognition-config",
        version: "1.0.0",

        getModel(sessionId?: string): string | undefined {
          if (sessionId) {
            const session = ctx.sessions.get(sessionId);
            if (session) {
              const cfg = getSessionConfig(session.metadata);
              if (cfg?.model) return cfg.model;
            }
          }
          return globalModel;
        },

        setModel(modelId: string, sessionId?: string): void {
          if (sessionId) {
            const session = ctx.sessions.get(sessionId);
            if (session) {
              const cfg = getSessionConfig(session.metadata) ?? {};
              cfg.model = modelId;
              setSessionConfig(session.metadata, cfg);
              return;
            }
          }
          globalModel = modelId;
        },

        getProvider(sessionId?: string): string | undefined {
          if (sessionId) {
            const session = ctx.sessions.get(sessionId);
            if (session) {
              const cfg = getSessionConfig(session.metadata);
              if (cfg?.provider) return cfg.provider;
            }
          }
          return globalProvider;
        },

        setProvider(providerId: string, sessionId?: string): void {
          if (sessionId) {
            const session = ctx.sessions.get(sessionId);
            if (session) {
              const cfg = getSessionConfig(session.metadata) ?? {};
              cfg.provider = providerId;
              setSessionConfig(session.metadata, cfg);
              return;
            }
          }
          globalProvider = providerId;
        },
      };

      // Register the cognition-config service
      ctx.services?.register(cognitionConfigService);

      const commands: SlashCommand[] = [
        {
          name: "provider",
          description: "Manage providers (status/model)",
          async execute(args: string, _ctx: IPluginContext, sessionId?: string): Promise<string | undefined> {
            const parts = args.trim().split(/\s+/);
            const subCmd = parts[0];

            // ─── /provider status ───
            if (subCmd === "status") {
              const providers = ctx.providers?.list() ?? [];
              if (providers.length === 0) {
                return "No providers registered.";
              }

              const lines: string[] = ["Provider Status:"];
              for (const p of providers) {
                const configured = p.isConfigured?.() ?? false;
                const status = configured ? "Configured" : "Not configured";
                const modelList = p.models.map((m) => m.id).join(", ");
                lines.push(`  ${p.name} (${p.id}): ${status}`);
                if (configured && modelList) {
                  lines.push(`    Models: ${modelList}`);
                }
              }

              // Show current model selection
              const currentModel = cognitionConfigService.getModel(sessionId);
              if (currentModel) {
                lines.push("");
                lines.push(`Active model: ${currentModel}`);
              }

              return lines.join("\n");
            }

            // ─── /provider model [id] ───
            if (subCmd === "model") {
              const modelId = parts[1];

              // No model ID → list available models
              if (!modelId) {
                const providers = ctx.providers?.list() ?? [];
                const configuredProviders = providers.filter(
                  (p) => p.isConfigured?.() ?? false,
                );

                if (configuredProviders.length === 0) {
                  const loginLines: string[] = ["No configured providers. Login first:"];
                  for (const p of providers) {
                    const hint = p.loginHint;
                    const args = hint?.usage ? ` ${hint.usage}` : "";
                    loginLines.push(`  /provider login ${p.id}${args}`);
                  }
                  if (providers.length === 0) {
                    loginLines.push("  (no providers loaded)");
                  }
                  return loginLines.join("\n");
                }

                const lines: string[] = ["Available models:"];
                for (const p of configuredProviders) {
                  lines.push(`  ${p.name}:`);
                  for (const m of p.models) {
                    lines.push(`    ${m.id} — ${m.name}`);
                  }
                }

                const currentModel = cognitionConfigService.getModel(sessionId);
                if (currentModel) {
                  lines.push("");
                  lines.push(`Current: ${currentModel}`);
                }

                lines.push("");
                lines.push("Usage: /provider model <model-id>");
                return lines.join("\n");
              }

              // Model ID provided → set it
              // Verify the model exists in some provider
              const providers = ctx.providers?.list() ?? [];
              let found: IProvider | undefined;
              for (const p of providers) {
                if (p.models.some((m) => m.id === modelId)) {
                  found = p;
                  break;
                }
              }

              if (!found) {
                return `Unknown model "${modelId}". Use /provider model to list available models.`;
              }

              if (found.isConfigured && !found.isConfigured()) {
                return `Provider "${found.name}" is not configured. Use /provider login ${found.id} first.`;
              }

              cognitionConfigService.setModel(modelId, sessionId);
              cognitionConfigService.setProvider(found.id, sessionId);
              return `Model set to: ${modelId} (provider: ${found.name})`;
            }

            // ─── /provider (no subcommand or unknown) → show help ───
            if (!subCmd || subCmd === "help") {
              return [
                "Usage:",
                "  /provider login <name> <key>   — Configure a provider",
                "  /provider logout <name>        — Remove credentials",
                "  /provider remove <name>        — Remove credentials",
                "  /provider status               — Show all provider status",
                "  /provider model                — List available models",
                "  /provider model <id>           — Select a model",
              ].join("\n");
            }

            // Not handled → pass to next handler
            return undefined;
          },
        },
      ];

      return { commands };
    },
  };
}

export default createModelSelectorPlugin;
