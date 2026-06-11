/**
 * provider-chatgpt-oauth — ChatGPT provider with OpenAI Codex OAuth (PKCE).
 *
 * Uses the same OAuth flow as OpenAI Codex CLI to authenticate with a
 * ChatGPT subscription account. Access token is used as Bearer token
 * against the Codex Responses API (chatgpt.com/backend-api/codex/responses).
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { URL } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  IPlugin,
  IPluginContext,
  PluginHooks,
  IProvider,
  ChatRequest,
  ProviderStreamEvent,
  ModelInfo,
  SlashCommand,
} from "@openstarry/sdk";
import { SecureStore, createLogger } from "@openstarry/shared";
import { streamCodexResponses } from "./api.js";
import { convertMessages, convertTools, sanitizeToolName } from "./message-converter.js";
import type { CodexRequest } from "./api.js";

// ─── OAuth Constants (OpenAI Codex) ───

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

const MODELS: ModelInfo[] = [
  { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", contextWindow: 272000, maxOutputTokens: 128000 },
  { id: "gpt-5.1", name: "GPT-5.1", contextWindow: 272000, maxOutputTokens: 128000 },
  { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", contextWindow: 272000, maxOutputTokens: 128000 },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 272000, maxOutputTokens: 128000 },
  { id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272000, maxOutputTokens: 128000 },
];

// ─── Types ───

interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

// ─── PKCE Helpers ───

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function generateState(): string {
  return randomBytes(16).toString("hex");
}

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] ?? "";
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

function getAccountId(accessToken: string): string | null {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

// ─── OAuth Manager ───

class ChatGptOAuthManager {
  private storage: SecureStore;
  private currentToken: OAuthToken | null = null;
  private codeVerifier: string | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private pendingAuth: {
    state: string;
    resolve: (code: string) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(storage: SecureStore) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    const saved = await this.storage.readSecure<OAuthToken>("oauth_token.json");
    if (saved) {
      if (!saved.expiresAt || saved.expiresAt > Date.now()) {
        this.currentToken = saved;
      } else if (saved.refreshToken) {
        try {
          await this.refreshAccessToken(saved.refreshToken);
        } catch {
          // Refresh failed — user must re-login
        }
      }
    }
  }

  isAuthenticated(): boolean {
    if (!this.currentToken) return false;
    if (this.currentToken.expiresAt && this.currentToken.expiresAt < Date.now()) {
      return false;
    }
    return true;
  }

  getAccessToken(): string | null {
    if (!this.isAuthenticated()) return null;
    return this.currentToken?.accessToken ?? null;
  }

  getAccountId(): string | null {
    return this.currentToken?.accountId ?? null;
  }

  async ensureValidToken(): Promise<string | null> {
    if (this.currentToken?.expiresAt && this.currentToken.expiresAt < Date.now()) {
      if (this.currentToken.refreshToken) {
        try {
          await this.refreshAccessToken(this.currentToken.refreshToken);
        } catch {
          return null;
        }
      } else {
        return null;
      }
    }
    return this.getAccessToken();
  }

  // ─── Auth Flow ───

  async startAuthFlow(): Promise<{ url: string; state: string }> {
    this.codeVerifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(this.codeVerifier);
    const state = generateState();

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });

    await this.startCallbackServer(REDIRECT_PORT);

    return { url: `${AUTHORIZE_URL}?${params.toString()}`, state };
  }

  private async startCallbackServer(port: number): Promise<void> {
    if (this.server) return;

    return new Promise((resolve, reject) => {
      this.server = createServer(
        async (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url ?? "/", `http://localhost:${port}`);
          if (url.pathname !== "/auth/callback") {
            res.writeHead(404);
            res.end("Not Found");
            return;
          }

          const code = url.searchParams.get("code");
          const inState = url.searchParams.get("state");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              `<html><body style="font-family:system-ui;padding:40px;text-align:center;"><h1>Authorization Failed</h1><p>Error: ${error}</p><p>You can close this window.</p></body></html>`,
            );
            if (this.pendingAuth) {
              this.pendingAuth.reject(new Error(`OAuth error: ${error}`));
              this.pendingAuth = null;
            }
            return;
          }

          if (!code || !inState) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              `<html><body style="font-family:system-ui;padding:40px;text-align:center;"><h1>Missing Parameters</h1><p>Please try again.</p></body></html>`,
            );
            return;
          }

          // Verify state
          if (this.pendingAuth && inState !== this.pendingAuth.state) {
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              `<html><body style="font-family:system-ui;padding:40px;text-align:center;"><h1>State Mismatch</h1><p>Invalid state, please try again.</p></body></html>`,
            );
            return;
          }

          try {
            await this.exchangeCodeForToken(code);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              `<html><body style="font-family:system-ui;padding:40px;text-align:center;"><h1>Authorization Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>`,
            );
            if (this.pendingAuth) {
              this.pendingAuth.resolve(code);
              this.pendingAuth = null;
            }
            setTimeout(() => this.stopCallbackServer(), 1000);
          } catch (err) {
            res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
            res.end(
              `<html><body style="font-family:system-ui;padding:40px;text-align:center;"><h1>Token Exchange Failed</h1><p>${err instanceof Error ? err.message : String(err)}</p></body></html>`,
            );
            if (this.pendingAuth) {
              this.pendingAuth.reject(err instanceof Error ? err : new Error(String(err)));
              this.pendingAuth = null;
            }
          }
        },
      );

      this.server.on("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve());
    });
  }

  private stopCallbackServer(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  async waitForCallback(state: string, timeoutMs = 300000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stopCallbackServer();
        this.pendingAuth = null;
        reject(new Error("OAuth callback timeout"));
      }, timeoutMs);

      this.pendingAuth = {
        state,
        resolve: (code) => {
          clearTimeout(timer);
          resolve(code);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });
  }

  // ─── Token Exchange ───

  private async exchangeCodeForToken(code: string): Promise<void> {
    if (!this.codeVerifier) {
      throw new Error("Code verifier not found. Please restart the OAuth flow.");
    }

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: this.codeVerifier,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const token: OAuthToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      accountId: getAccountId(data.access_token) ?? undefined,
    };

    this.currentToken = token;
    this.codeVerifier = null;
    await this.storage.writeSecure("oauth_token.json", token);
  }

  private async refreshAccessToken(refreshToken: string): Promise<void> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    this.currentToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      accountId: getAccountId(data.access_token) ?? this.currentToken?.accountId,
    };

    await this.storage.writeSecure("oauth_token.json", this.currentToken);
  }

  async logout(): Promise<void> {
    this.currentToken = null;
    await this.storage.delete("oauth_token.json");
  }
}

// ─── Provider ───

function getStoragePath(): string {
  return join(homedir(), ".openstarry", "plugins", "chatgpt-oauth");
}

class ChatGptOAuthProvider implements IProvider {
  public readonly skandha = "samjna" as const;
  public readonly id = "chatgpt-oauth";
  public readonly name = "ChatGPT (OAuth)";
  public readonly models = MODELS;
  public readonly loginHint = { usage: "", description: "ChatGPT OAuth" };

  private oauth: ChatGptOAuthManager;

  constructor(oauth: ChatGptOAuthManager) {
    this.oauth = oauth;
  }

  isConfigured(): boolean {
    return this.oauth.isAuthenticated();
  }

  async *chat(request: ChatRequest): AsyncIterable<ProviderStreamEvent> {
    const accessToken = await this.oauth.ensureValidToken();
    if (!accessToken) {
      yield {
        type: "error",
        error: new Error(
          "Not logged in. Use /provider login chatgpt-oauth to authenticate.\n" +
            "Run /provider status to see all available providers.",
        ),
      };
      return;
    }

    const accountId = this.oauth.getAccountId();
    if (!accountId) {
      yield { type: "error", error: new Error("No account ID. Please re-login.") };
      return;
    }

    const input = convertMessages(request.messages);
    const tools = request.tools ? convertTools(request.tools) : undefined;

    // Build reverse name map: sanitized → original (e.g., "fs_list" → "fs.list")
    const nameMap = new Map<string, string>();
    if (request.tools) {
      for (const t of request.tools) {
        const sanitized = sanitizeToolName(t.name);
        if (sanitized !== t.name) nameMap.set(sanitized, t.name);
      }
    }

    const codexRequest: CodexRequest = {
      model: request.model,
      store: false,
      stream: true,
      instructions: request.systemPrompt || "You are a helpful assistant.",
      input,
      ...(tools && tools.length > 0 ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
    };

    // Wrap stream to reverse-map tool names
    for await (const event of streamCodexResponses(accessToken, accountId, codexRequest)) {
      if (nameMap.size > 0 && (event.type === "tool_call_start" || event.type === "tool_call_end")) {
        const e = event as { name?: string };
        if (e.name && nameMap.has(e.name)) {
          e.name = nameMap.get(e.name)!;
        }
      }
      yield event;
    }
  }
}

// ─── Plugin Factory ───

export function createChatGptOAuthPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/provider-chatgpt-oauth",
      version: "0.1.0-alpha",
      skandha: "samjna",
      criticality: "optional-degraded" as const,
      description: "ChatGPT provider with OpenAI Codex OAuth (PKCE) authentication",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const storagePath = getStoragePath();
      const storage = new SecureStore({
        basePath: storagePath,
        saltSuffix: "openstarry-chatgpt-oauth",
      });
      await storage.ensureDir();

      const logger = createLogger("chatgpt-oauth");
      const oauthManager = new ChatGptOAuthManager(storage);
      await oauthManager.initialize();

      const provider = new ChatGptOAuthProvider(oauthManager);

      if (oauthManager.isAuthenticated()) {
        const accountId = oauthManager.getAccountId();
        logger.info(`Logged in (account: ${accountId ?? "unknown"})`);
      } else {
        logger.info("Not logged in. Use /provider login chatgpt-oauth");
      }

      // ─── Slash Commands ───

      const providerCommand: SlashCommand = {
        name: "provider",
        description: "Manage OAuth providers (login/logout/status)",
        execute: async (args: string): Promise<string | undefined> => {
          const parts = (args ?? "").trim().split(/\s+/);
          const subCmd = parts[0]?.toLowerCase();
          const providerName = parts[1]?.toLowerCase();

          // ─── login chatgpt-oauth ───
          if (subCmd === "login" && (providerName === "chatgpt-oauth" || providerName === "chatgpt")) {
            if (oauthManager.isAuthenticated()) {
              return "Already logged in. Use /provider logout chatgpt-oauth first.";
            }

            try {
              const { url, state } = await oauthManager.startAuthFlow();

              // Try to open browser
              try {
                const { exec } = await import("node:child_process");
                const cmd =
                  process.platform === "win32"
                    ? `start "" "${url}"`
                    : process.platform === "darwin"
                      ? `open "${url}"`
                      : `xdg-open "${url}"`;
                exec(cmd);
              } catch {
                // Browser open failed — user can use the URL
              }

              logger.info(
                "Opening browser for ChatGPT OAuth login...\n\n" +
                  `If the browser did not open, visit:\n${url}\n\n` +
                  "Complete the login in your browser.\n(Waiting... up to 5 minutes)",
              );

              await oauthManager.waitForCallback(state);
              const accountId = oauthManager.getAccountId();

              return `Logged in to ChatGPT (account: ${accountId ?? "unknown"})`;
            } catch (err) {
              return `Login failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          }

          // ─── logout chatgpt-oauth ───
          if (subCmd === "logout" && (providerName === "chatgpt-oauth" || providerName === "chatgpt")) {
            await oauthManager.logout();
            return "Logged out from ChatGPT OAuth.";
          }

          // ─── status ───
          if (subCmd === "status") {
            if (oauthManager.isAuthenticated()) {
              const accountId = oauthManager.getAccountId();
              return `chatgpt-oauth: Logged in (account: ${accountId ?? "unknown"})`;
            }
            return "chatgpt-oauth: Not logged in. Use /provider login chatgpt-oauth";
          }

          return undefined;
        },
      };

      return {
        providers: [provider],
        commands: [providerCommand],
      };
    },
  };
}

export default createChatGptOAuthPlugin;
