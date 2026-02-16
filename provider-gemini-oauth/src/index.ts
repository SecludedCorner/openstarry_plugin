/**
 * provider-gemini-oauth — Gemini LLM provider with PKCE + OAuth 2.0 authentication.
 *
 * Implements IPlugin and IProvider for the OpenStarry agent system.
 * Uses Google Code Assist v1internal endpoint with SecureStore encrypted credential storage.
 *
 * SECURITY: OAuth client credentials (CLIENT_ID / CLIENT_SECRET) are NOT hardcoded.
 * They must be provided by the user via `/provider login gemini-oauth <clientId> <clientSecret>`
 * and are encrypted at rest using SecureStore (AES-256-GCM, machine-bound).
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { URL } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  IPlugin,
  IPluginContext,
  IProvider,
  PluginHooks,
  ChatRequest,
  ProviderStreamEvent,
  ModelInfo,
  Message,
  SlashCommand,
  ContentSegment,
} from "@openstarry/sdk";
import { SecureStore, createLogger } from "@openstarry/shared";

// ─── Constants ───

const GEMINI_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

const GEMINI_REDIRECT_PORT = 8085;

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const GEMINI_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

const CODE_ASSIST_HEADERS: Record<string, string> = {
  "User-Agent": "google-api-nodejs-client/9.15.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata":
    "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
};

const MODELS: ModelInfo[] = [
  {
    id: "gemini-2.0-flash",
    name: "Gemini 2.0 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
  },
  {
    id: "gemini-1.5-pro",
    name: "Gemini 1.5 Pro",
    contextWindow: 2097152,
    maxOutputTokens: 8192,
  },
  {
    id: "gemini-1.5-flash",
    name: "Gemini 1.5 Flash",
    contextWindow: 1048576,
    maxOutputTokens: 8192,
  },
];

// ─── Types ───

interface OAuthClientCreds {
  clientId: string;
  clientSecret: string;
}

interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

interface UserInfoData {
  email?: string;
  name?: string;
}

interface GeminiMessage {
  role: "user" | "model";
  parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> }; functionResponse?: { name: string; response: { result: string } } }>;
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface GeminiRequest {
  contents: GeminiMessage[];
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{ functionDeclarations: GeminiFunctionDeclaration[] }>;
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string;
  currentTier?: { id?: string };
  allowedTiers?: Array<{ id?: string }>;
}

interface OnboardUserPayload {
  done?: boolean;
  response?: {
    cloudaicompanionProject?: { id?: string };
  };
}

// ─── PKCE Helpers ───

function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// ─── Project Auto-Provisioning ───

function buildMetadata(projectId?: string): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };
  if (projectId) metadata.duetProject = projectId;
  return metadata;
}

async function loadManagedProject(
  accessToken: string,
  projectId?: string,
): Promise<LoadCodeAssistPayload | null> {
  try {
    const metadata = buildMetadata(projectId);
    const body: Record<string, unknown> = { metadata };
    if (projectId) body.cloudaicompanionProject = projectId;

    const response = await fetch(
      `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...CODE_ASSIST_HEADERS,
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) return null;
    return (await response.json()) as LoadCodeAssistPayload;
  } catch {
    return null;
  }
}

async function onboardManagedProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  attempts = 10,
  delayMs = 5000,
): Promise<string | undefined> {
  const metadata = buildMetadata(projectId);
  const body: Record<string, unknown> = { tierId, metadata };
  if (tierId !== "FREE" && projectId) body.cloudaicompanionProject = projectId;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(
        `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...CODE_ASSIST_HEADERS,
          },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) return undefined;

      const payload = (await response.json()) as OnboardUserPayload;
      const managedId = payload.response?.cloudaicompanionProject?.id;
      if (payload.done && managedId) return managedId;
      if (payload.done && projectId) return projectId;
    } catch {
      return undefined;
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }

  return undefined;
}

// ─── OAuth Manager ───

class GeminiOAuthManager {
  private storage: SecureStore;
  private clientCreds: OAuthClientCreds | null = null;
  private currentToken: OAuthToken | null = null;
  private userInfoData: UserInfoData | null = null;
  private managedProjectId: string | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private codeVerifier: string | null = null;
  private configProjectId?: string;
  private pendingAuth: {
    state: string;
    resolve: (code: string) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(storage: SecureStore, configProjectId?: string) {
    this.storage = storage;
    this.configProjectId = configProjectId;
  }

  async initialize(): Promise<void> {
    // Load client credentials
    this.clientCreds = await this.storage.readSecure<OAuthClientCreds>("oauth-client.enc.json");

    // Load OAuth token
    const saved = await this.storage.readSecure<OAuthToken>("oauth_token.json");
    if (saved) {
      if (!saved.expiresAt || saved.expiresAt > Date.now()) {
        this.currentToken = saved;
      } else if (saved.refreshToken) {
        try {
          await this.refreshToken(saved.refreshToken);
        } catch {
          // Refresh failed — user must re-login
        }
      }
    }

    const ui = await this.storage.read<UserInfoData>("user_info.json");
    if (ui) this.userInfoData = ui;

    const proj = await this.storage.read<{ projectId: string }>("managed_project.json");
    if (proj?.projectId) this.managedProjectId = proj.projectId;
  }

  hasClientCreds(): boolean {
    return this.clientCreds !== null;
  }

  async setClientCreds(clientId: string, clientSecret: string): Promise<void> {
    this.clientCreds = { clientId, clientSecret };
    await this.storage.writeSecure("oauth-client.enc.json", this.clientCreds);
  }

  isAuthenticated(): boolean {
    if (!this.currentToken) return false;
    if (this.currentToken.expiresAt && this.currentToken.expiresAt < Date.now())
      return false;
    return true;
  }

  getAccessToken(): string | null {
    if (!this.isAuthenticated()) return null;
    return this.currentToken?.accessToken ?? null;
  }

  getUserInfo(): UserInfoData | null {
    return this.userInfoData;
  }

  getProjectId(): string | undefined {
    return (
      this.configProjectId ??
      process.env.OPENSTARRY_GEMINI_PROJECT_ID ??
      this.managedProjectId ??
      undefined
    );
  }

  async ensureProjectId(): Promise<string | null> {
    const configured =
      this.configProjectId ?? process.env.OPENSTARRY_GEMINI_PROJECT_ID;
    if (configured) return configured;
    if (this.managedProjectId) return this.managedProjectId;

    const accessToken = await this.ensureValidToken();
    if (!accessToken) return null;

    const loadPayload = await loadManagedProject(accessToken);
    if (loadPayload?.cloudaicompanionProject) {
      this.managedProjectId = loadPayload.cloudaicompanionProject;
      await this.storage.write("managed_project.json", {
        projectId: this.managedProjectId,
      });
      return this.managedProjectId;
    }

    if (!loadPayload) return null;

    const currentTierId = loadPayload.currentTier?.id;
    if (currentTierId && currentTierId !== "FREE") return null;

    const managedId = await onboardManagedProject(accessToken, "FREE");
    if (managedId) {
      this.managedProjectId = managedId;
      await this.storage.write("managed_project.json", {
        projectId: this.managedProjectId,
      });
      return this.managedProjectId;
    }

    return null;
  }

  async ensureValidToken(): Promise<string | null> {
    if (this.isAuthenticated()) return this.currentToken!.accessToken;

    if (this.currentToken?.refreshToken) {
      try {
        await this.refreshToken(this.currentToken.refreshToken);
        return this.currentToken!.accessToken;
      } catch {
        // Refresh failed
      }
    }

    return null;
  }

  async startOAuthFlow(): Promise<{ url: string; state: string }> {
    if (!this.clientCreds) {
      throw new Error("No OAuth client credentials configured.");
    }

    const state = randomBytes(16).toString("hex");
    const port = GEMINI_REDIRECT_PORT;
    const redirectUri = `http://localhost:${port}/oauth2callback`;

    this.codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(this.codeVerifier);

    await this.startCallbackServer(port);

    const params = new URLSearchParams({
      client_id: this.clientCreds.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GEMINI_SCOPES.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
    });

    return { url: `${GOOGLE_AUTH_URL}?${params.toString()}`, state };
  }

  private async startCallbackServer(port: number): Promise<void> {
    if (this.server) return;

    return new Promise((resolve, reject) => {
      this.server = createServer(
        async (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url ?? "/", `http://localhost:${port}`);
          if (url.pathname !== "/oauth2callback") {
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

          if (this.pendingAuth && inState) {
            const expected = Buffer.from(this.pendingAuth.state, "utf-8");
            const received = Buffer.from(inState, "utf-8");
            const stateValid =
              expected.length === received.length &&
              timingSafeEqual(expected, received);
            if (!stateValid) {
              res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
              res.end(
                `<html><body style="font-family:system-ui;padding:40px;text-align:center;"><h1>State Mismatch</h1><p>Invalid state, please try again.</p></body></html>`,
              );
              return;
            }
          }

          try {
            await this.exchangeCodeForToken(code, port);
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
              this.pendingAuth.reject(
                err instanceof Error ? err : new Error(String(err)),
              );
              this.pendingAuth = null;
            }
          }
        },
      );

      this.server.on("error", reject);
      this.server.listen(port, "localhost", () => resolve());
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

  private async exchangeCodeForToken(
    code: string,
    port: number,
  ): Promise<OAuthToken> {
    if (!this.codeVerifier) {
      throw new Error("Code verifier not found. Please restart the OAuth flow.");
    }
    if (!this.clientCreds) {
      throw new Error("No OAuth client credentials configured.");
    }

    const redirectUri = `http://localhost:${port}/oauth2callback`;

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: this.clientCreds.clientId,
        client_secret: this.clientCreds.clientSecret,
        code_verifier: this.codeVerifier,
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
      scope?: string;
    };

    const token: OAuthToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : undefined,
      scope: data.scope,
    };

    this.currentToken = token;
    this.codeVerifier = null;
    await this.storage.writeSecure("oauth_token.json", token);
    await this.fetchUserInfo();

    return token;
  }

  private async refreshToken(refreshToken: string): Promise<OAuthToken> {
    if (!this.clientCreds) {
      throw new Error("No OAuth client credentials configured.");
    }

    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.clientCreds.clientId,
        client_secret: this.clientCreds.clientSecret,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    const token: OAuthToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: data.expires_in
        ? Date.now() + data.expires_in * 1000
        : undefined,
      scope: data.scope,
    };

    this.currentToken = token;
    await this.storage.writeSecure("oauth_token.json", token);
    return token;
  }

  private async fetchUserInfo(): Promise<void> {
    const accessToken = this.getAccessToken();
    if (!accessToken) return;

    try {
      const response = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      if (response.ok) {
        const data = (await response.json()) as {
          email?: string;
          name?: string;
        };
        this.userInfoData = { email: data.email, name: data.name };
        await this.storage.write("user_info.json", this.userInfoData);
      }
    } catch {
      // Non-blocking
    }
  }

  /** Clean up resources (callback server) without removing persisted tokens. */
  cleanup(): void {
    this.stopCallbackServer();
  }

  /** Logout: clear OAuth token + user info but keep client credentials. */
  async logout(): Promise<void> {
    this.currentToken = null;
    this.userInfoData = null;
    this.managedProjectId = null;
    this.codeVerifier = null;
    await this.storage.delete("oauth_token.json");
    await this.storage.delete("user_info.json");
    await this.storage.delete("managed_project.json");
    this.stopCallbackServer();
  }

  /** Remove: clear everything including client credentials. */
  async removeAll(): Promise<void> {
    await this.logout();
    this.clientCreds = null;
    await this.storage.delete("oauth-client.enc.json");
  }
}

// ─── Gemini API Streaming ───

async function* callGeminiStream(
  accessToken: string,
  projectId: string,
  model: string,
  request: GeminiRequest,
): AsyncGenerator<ProviderStreamEvent> {
  const endpoint = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;

  const wrappedBody = {
    project: projectId,
    model,
    request,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...CODE_ASSIST_HEADERS,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(wrappedBody),
  });

  if (!response.ok) {
    const text = await response.text();
    yield {
      type: "error",
      error: new Error(`Gemini API error: ${response.status} ${text}`),
    };
    return;
  }

  if (!response.body) {
    yield { type: "error", error: new Error("No response body") };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasYieldedFinish = false;

  let pendingFunctionCalls: Array<{
    name: string;
    args: Record<string, unknown>;
  }> = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") {
          if (!hasYieldedFinish) {
            const stopReason =
              pendingFunctionCalls.length > 0 ? "tool_use" : "end_turn";
            yield {
              type: "finish",
              stopReason: stopReason as "end_turn" | "tool_use",
            };
            hasYieldedFinish = true;
          }
          continue;
        }

        try {
          const raw = JSON.parse(jsonStr) as Record<string, unknown>;
          const data = (raw.response ?? raw) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{
                  text?: string;
                  functionCall?: {
                    name: string;
                    args: Record<string, unknown>;
                  };
                }>;
              };
              finishReason?: string;
            }>;
            error?: { message?: string };
          };

          if (data.error) {
            yield {
              type: "error",
              error: new Error(data.error.message ?? "Gemini API error"),
            };
            return;
          }

          if (data.candidates?.[0]?.content?.parts) {
            for (const part of data.candidates[0].content.parts) {
              if (part.text) {
                yield { type: "text_delta", text: part.text };
              }
              if (part.functionCall) {
                const tcId = randomBytes(8).toString("hex");
                pendingFunctionCalls.push({
                  name: part.functionCall.name,
                  args: part.functionCall.args,
                });
                yield {
                  type: "tool_call_start",
                  toolCallId: tcId,
                  name: part.functionCall.name,
                };
                yield {
                  type: "tool_call_delta",
                  toolCallId: tcId,
                  input: JSON.stringify(part.functionCall.args),
                };
                yield {
                  type: "tool_call_end",
                  toolCallId: tcId,
                  name: part.functionCall.name,
                  input: JSON.stringify(part.functionCall.args),
                };
              }
            }
          }

          if (data.candidates?.[0]?.finishReason === "STOP" && !hasYieldedFinish) {
            yield { type: "finish", stopReason: "end_turn" };
            hasYieldedFinish = true;
          }
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Handle remaining buffer
    if (buffer.trim().startsWith("data:")) {
      const jsonStr = buffer.trim().slice(5).trim();
      if (jsonStr && jsonStr !== "[DONE]") {
        try {
          const raw = JSON.parse(jsonStr) as Record<string, unknown>;
          const data = (raw.response ?? raw) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string }>;
              };
            }>;
          };

          if (data.candidates?.[0]?.content?.parts) {
            for (const part of data.candidates[0].content.parts) {
              if (part.text) {
                yield { type: "text_delta", text: part.text };
              }
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    if (!hasYieldedFinish) {
      const stopReason =
        pendingFunctionCalls.length > 0 ? "tool_use" : "end_turn";
      yield {
        type: "finish",
        stopReason: stopReason as "end_turn" | "tool_use",
      };
    }
  } catch (err) {
    yield {
      type: "error",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

// ─── Message Conversion ───

function convertMessages(
  messages: Message[],
  systemPrompt?: string,
): { geminiMessages: GeminiMessage[]; systemInstruction?: { parts: Array<{ text: string }> } } {
  const geminiMessages: GeminiMessage[] = [];
  let collectedSystemPrompt = systemPrompt;

  for (const msg of messages) {
    if (msg.role === "system") {
      const texts = msg.content
        .filter((c): c is ContentSegment & { type: "text" } => c.type === "text")
        .map((c) => c.text);
      if (texts.length > 0) {
        collectedSystemPrompt = texts.join("\n");
      }
      continue;
    }

    if (msg.role === "user") {
      const texts = msg.content
        .filter((c): c is ContentSegment & { type: "text" } => c.type === "text")
        .map((c) => c.text);
      if (texts.length > 0) {
        geminiMessages.push({
          role: "user",
          parts: texts.map((text) => ({ text })),
        });
      }
    } else if (msg.role === "assistant") {
      const parts: GeminiMessage["parts"] = [];
      for (const seg of msg.content) {
        if (seg.type === "text") {
          parts.push({ text: seg.text });
        } else if (seg.type === "tool_call") {
          parts.push({
            functionCall: {
              name: seg.toolCall.name,
              args: seg.toolCall.arguments,
            },
          });
        }
      }
      if (parts.length > 0) {
        geminiMessages.push({ role: "model", parts });
      }
    } else if (msg.role === "tool") {
      const parts: GeminiMessage["parts"] = [];
      for (const seg of msg.content) {
        if (seg.type === "tool_result") {
          parts.push({
            functionResponse: {
              name: seg.toolResult.name,
              response: { result: seg.toolResult.result },
            },
          });
        }
      }
      if (parts.length > 0) {
        geminiMessages.push({ role: "user", parts });
      }
    }
  }

  const systemInstruction = collectedSystemPrompt
    ? { parts: [{ text: collectedSystemPrompt }] }
    : undefined;

  return { geminiMessages, systemInstruction };
}

// ─── Provider Adapter ───

function createGeminiOAuthAdapter(
  oauthManager: GeminiOAuthManager,
): IProvider {
  return {
    id: "gemini-oauth",
    name: "Gemini (Google OAuth)",
    models: MODELS,
    loginHint: { usage: "<ID> <SECRET>", description: "Google OAuth" },

    isConfigured(): boolean {
      return oauthManager.isAuthenticated();
    },

    async *chat(request: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const accessToken = await oauthManager.ensureValidToken();

      if (!accessToken) {
        yield {
          type: "error",
          error: new Error(
            "Not logged in. Use /provider login gemini-oauth to authenticate.\nRun /provider status to see all available providers.",
          ),
        };
        return;
      }

      const projectId = await oauthManager.ensureProjectId();
      if (!projectId) {
        yield {
          type: "error",
          error: new Error(
            "Cannot auto-provision Google Cloud Project.\n" +
              "Set OPENSTARRY_GEMINI_PROJECT_ID env var or configure geminiOAuth.projectId.",
          ),
        };
        return;
      }

      const { geminiMessages, systemInstruction } = convertMessages(
        request.messages,
        request.systemPrompt,
      );

      let tools: GeminiRequest["tools"] = undefined;
      if (request.tools && request.tools.length > 0) {
        tools = [
          {
            functionDeclarations: request.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ];
      }

      const geminiRequest: GeminiRequest = {
        contents: geminiMessages,
        systemInstruction,
        tools,
        generationConfig: {
          temperature: request.temperature,
          maxOutputTokens: request.maxTokens,
        },
      };

      yield* callGeminiStream(
        accessToken,
        projectId,
        request.model,
        geminiRequest,
      );
    },
  };
}

// ─── Plugin Export ───

function getStoragePath(): string {
  return join(homedir(), ".openstarry", "plugins", "gemini-oauth");
}

export function createGeminiOAuthPlugin(): IPlugin {
  return {
    manifest: {
      name: "provider-gemini-oauth",
      version: "0.1.0-alpha",
      description: "Gemini LLM provider with PKCE + OAuth 2.0",
    },

    async factory(ctx: IPluginContext): Promise<PluginHooks> {
      const storagePath = getStoragePath();
      const storage = new SecureStore({
        basePath: storagePath,
        saltSuffix: "openstarry-gemini-oauth",
      });
      await storage.ensureDir();

      const logger = createLogger("gemini-oauth");

      const pluginConfig = ctx.config as Record<string, unknown> | undefined;
      const configProjectId = pluginConfig?.projectId as string | undefined;
      const oauthManager = new GeminiOAuthManager(storage, configProjectId);
      await oauthManager.initialize();

      // Auto-configure client credentials from plugin config if not already set
      const configClientId = pluginConfig?.clientId as string | undefined;
      const configClientSecret = pluginConfig?.clientSecret as string | undefined;
      if (!oauthManager.hasClientCreds() && configClientId && configClientSecret) {
        await oauthManager.setClientCreds(configClientId, configClientSecret);
        logger.info("Client credentials loaded from agent config.");
      }

      if (oauthManager.isAuthenticated()) {
        const user = oauthManager.getUserInfo();
        const email = user?.email ?? "";
        logger.info(
          `Logged in${email ? ` (${email})` : ""}, ${MODELS.length} models available.`,
        );
      } else if (oauthManager.hasClientCreds()) {
        logger.info(
          "Client configured but not logged in. Use /provider login gemini-oauth",
        );
      } else {
        logger.info(
          "Not configured. Use /provider login gemini-oauth <CLIENT_ID> <CLIENT_SECRET>",
        );
      }

      const provider = createGeminiOAuthAdapter(oauthManager);

      const commands: SlashCommand[] = [
        {
          name: "provider",
          description: "Manage OAuth providers (login/logout/status/remove)",
          async execute(args: string): Promise<string | undefined> {
            const parts = args.trim().split(/\s+/);
            const subCmd = parts[0];
            const providerName = parts[1];

            // ─── login gemini-oauth [clientId] [clientSecret] ───
            if (subCmd === "login" && (providerName === "gemini-oauth" || providerName === "gemini")) {
              // If client credentials provided as args, store them first
              if (parts.length >= 4) {
                const clientId = parts[2];
                const clientSecret = parts[3];
                await oauthManager.setClientCreds(clientId, clientSecret);
              }

              // Check if we have client credentials
              if (!oauthManager.hasClientCreds()) {
                return [
                  "No OAuth client credentials found.",
                  "",
                  "Please provide your Google OAuth client credentials:",
                  "  /provider login gemini-oauth <CLIENT_ID> <CLIENT_SECRET>",
                  "",
                  "You can obtain credentials from the Google Cloud Console:",
                  "  https://console.cloud.google.com/apis/credentials",
                ].join("\n");
              }

              // Already authenticated?
              if (oauthManager.isAuthenticated()) {
                const user = oauthManager.getUserInfo();
                const email = user?.email ? ` (${user.email})` : "";
                return `Already logged in to Google${email}. Use /provider logout gemini-oauth first.`;
              }

              // Start OAuth flow
              try {
                const { url, state } = await oauthManager.startOAuthFlow();

                try {
                  const openMod = await import("open" as string);
                  const openFn =
                    (openMod.default as (url: string) => Promise<unknown>) ??
                    (openMod as unknown as (url: string) => Promise<unknown>);
                  await openFn(url);
                } catch {
                  // User will open manually
                }

                oauthManager.waitForCallback(state).catch(() => {});

                return [
                  "Opening browser for Google OAuth login...",
                  "",
                  "If the browser did not open, visit:",
                  url,
                  "",
                  "Complete the login in your browser.",
                  "(Waiting... up to 5 minutes)",
                ].join("\n");
              } catch (err) {
                return `Login failed: ${err instanceof Error ? err.message : String(err)}`;
              }
            }

            // ─── logout gemini-oauth ───
            if (subCmd === "logout" && (providerName === "gemini-oauth" || providerName === "gemini")) {
              await oauthManager.logout();
              return "Logged out from Google account. Client credentials preserved.";
            }

            // ─── remove gemini-oauth ───
            if (subCmd === "remove" && (providerName === "gemini-oauth" || providerName === "gemini")) {
              await oauthManager.removeAll();
              return "All Gemini OAuth credentials removed (client credentials + tokens).";
            }

            // Not handled by this plugin → pass to next handler
            return undefined;
          },
        },
      ];

      return {
        providers: [provider],
        commands,
        dispose() {
          oauthManager.cleanup();
        },
      };
    },
  };
}

export default createGeminiOAuthPlugin;
