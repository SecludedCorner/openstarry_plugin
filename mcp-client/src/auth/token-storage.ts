/**
 * EncryptedTokenStorage — Secure OAuth token storage with AES-256-GCM + PBKDF2 + machine-binding.
 *
 * Security features:
 * - AES-256-GCM authenticated encryption
 * - PBKDF2 key derivation (100,000 iterations, SHA-512)
 * - Machine-binding (hostname + username)
 * - Auto-refresh with 60s buffer
 *
 * Storage: Uses filesystem in {workingDirectory}/.openstarry-mcp/tokens/
 */
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { IPluginContext } from "@openstarry/sdk";
import { createLogger } from "@openstarry/shared";
import type { OAuthTokens, EncryptedTokenData, McpOAuthConfig } from "./types.js";

const logger = createLogger("mcp-oauth");

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 32; // 256 bits for AES-256
const PBKDF2_DIGEST = "sha512";
const AES_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard
const SALT_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const REFRESH_BUFFER_MS = 60000; // 60s before expiry

export class EncryptedTokenStorage {
  private tokenFile: string;

  constructor(
    private ctx: IPluginContext,
    private serverName: string,
    private oauthConfig?: McpOAuthConfig,
  ) {
    const tokenDir = path.join(ctx.workingDirectory, ".openstarry-mcp", "tokens");
    fs.mkdirSync(tokenDir, { recursive: true });
    this.tokenFile = path.join(tokenDir, `${serverName}.json`);
  }

  /**
   * Get machine identifier for key derivation (hostname + username).
   * Format: {hostname}|{username}|openstarry-mcp-v1
   */
  private getMachineId(): string {
    const hostname = os.hostname();
    const username = os.userInfo().username;
    return `${hostname}|${username}|openstarry-mcp-v1`;
  }

  /**
   * Derive encryption key from machine ID using PBKDF2.
   */
  private deriveKey(salt: Buffer): Buffer {
    const machineId = this.getMachineId();
    return crypto.pbkdf2Sync(machineId, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
  }

  /**
   * Encrypt OAuth tokens with AES-256-GCM.
   */
  private encrypt(tokens: OAuthTokens): EncryptedTokenData {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const key = this.deriveKey(salt);
    const iv = crypto.randomBytes(IV_LENGTH);

    const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv);
    const plaintext = JSON.stringify(tokens);

    let encrypted = cipher.update(plaintext, "utf8", "base64");
    encrypted += cipher.final("base64");

    const tag = cipher.getAuthTag();

    return {
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
      salt: salt.toString("hex"),
      data: encrypted,
    };
  }

  /**
   * Decrypt OAuth tokens with AES-256-GCM.
   * Returns null if decryption fails (wrong machine or corrupted data).
   */
  private decrypt(encrypted: EncryptedTokenData): OAuthTokens | null {
    try {
      const salt = Buffer.from(encrypted.salt, "hex");
      const key = this.deriveKey(salt);
      const iv = Buffer.from(encrypted.iv, "hex");
      const tag = Buffer.from(encrypted.tag, "hex");

      const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv);
      decipher.setAuthTag(tag);

      let decrypted = decipher.update(encrypted.data, "base64", "utf8");
      decrypted += decipher.final("utf8");

      return JSON.parse(decrypted) as OAuthTokens;
    } catch (err) {
      logger.debug("Token decryption failed", {
        server: this.serverName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Save OAuth tokens to encrypted storage.
   */
  async save(tokens: OAuthTokens): Promise<void> {
    const encrypted = this.encrypt(tokens);
    fs.writeFileSync(this.tokenFile, JSON.stringify(encrypted), "utf8");
    logger.debug("OAuth tokens saved", { server: this.serverName });
  }

  /**
   * Load OAuth tokens from encrypted storage.
   * Returns null if not found or decryption fails.
   */
  async load(): Promise<OAuthTokens | null> {
    if (!fs.existsSync(this.tokenFile)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(this.tokenFile, "utf8");
      const encrypted = JSON.parse(raw) as EncryptedTokenData;
      return this.decrypt(encrypted);
    } catch (err) {
      logger.warn("Failed to parse encrypted token data", {
        server: this.serverName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Delete OAuth tokens from storage.
   */
  async delete(): Promise<void> {
    if (fs.existsSync(this.tokenFile)) {
      fs.unlinkSync(this.tokenFile);
    }
    logger.debug("OAuth tokens deleted", { server: this.serverName });
  }

  /**
   * Get current valid access token.
   * Auto-refreshes if token expires in < 60s.
   * Returns null if no token or refresh failed.
   */
  async getToken(): Promise<string | null> {
    const tokens = await this.load();
    if (!tokens) {
      return null;
    }

    const now = Date.now();
    const expiresIn = tokens.expiresAt - now;

    // Token still valid (> 60s remaining)
    if (expiresIn > REFRESH_BUFFER_MS) {
      return tokens.accessToken;
    }

    // Token expired or expiring soon, try refresh
    if (tokens.refreshToken && this.oauthConfig) {
      logger.debug("Access token expiring, attempting refresh", {
        server: this.serverName,
        expiresIn,
      });

      const refreshed = await this.refreshToken(tokens.refreshToken);
      if (refreshed) {
        return refreshed.accessToken;
      }
    }

    // No refresh token or refresh failed
    logger.warn("Access token expired and refresh failed", {
      server: this.serverName,
    });
    await this.delete(); // Clean up invalid tokens
    return null;
  }

  /**
   * Refresh access token using refresh token.
   * Returns null if refresh fails.
   */
  private async refreshToken(refreshToken: string): Promise<OAuthTokens | null> {
    if (!this.oauthConfig) {
      return null;
    }

    try {
      const params = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.oauthConfig.clientId,
      });

      if (this.oauthConfig.clientSecret) {
        params.set("client_secret", this.oauthConfig.clientSecret);
      }

      const response = await fetch(this.oauthConfig.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: params.toString(),
      });

      if (!response.ok) {
        logger.error("Token refresh failed", {
          server: this.serverName,
          status: response.status,
        });
        return null;
      }

      const data = await response.json() as {
        access_token: string;
        token_type: string;
        expires_in?: number;
        refresh_token?: string;
        id_token?: string;
        scope?: string;
      };

      const expiresIn = data.expires_in ?? 3600;
      const newTokens: OAuthTokens = {
        accessToken: data.access_token,
        tokenType: data.token_type,
        expiresAt: Date.now() + expiresIn * 1000,
        refreshToken: data.refresh_token ?? refreshToken, // Keep old refresh token if not provided
        idToken: data.id_token,
        scope: data.scope,
      };

      await this.save(newTokens);
      logger.info("Access token refreshed", { server: this.serverName });
      return newTokens;
    } catch (err) {
      logger.error("Token refresh error", {
        server: this.serverName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Handle 401 Unauthorized response.
   * Attempt token refresh, return true if retry recommended.
   */
  async onUnauthorized(): Promise<boolean> {
    const tokens = await this.load();
    if (!tokens?.refreshToken || !this.oauthConfig) {
      return false;
    }

    const refreshed = await this.refreshToken(tokens.refreshToken);
    return refreshed !== null;
  }
}
