/**
 * Tests for EncryptedTokenStorage — OAuth token encryption with machine-binding
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EncryptedTokenStorage } from "./token-storage.js";
import type { OAuthTokens, EncryptedTokenData, McpOAuthConfig } from "./types.js";
import type { IPluginContext } from "@openstarry/sdk";

describe("EncryptedTokenStorage", () => {
  let mockContext: IPluginContext;
  let tempDir: string;
  let storage: EncryptedTokenStorage;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `openstarry-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    mockContext = {
      bus: { emit: vi.fn(), on: vi.fn(), once: vi.fn(), onAny: vi.fn() },
      workingDirectory: tempDir,
      agentId: "test-agent",
      config: {},
      pushInput: vi.fn(),
      sessions: {} as any,
    };

    storage = new EncryptedTokenStorage(mockContext, "test-server");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates token directory on initialization", () => {
    const tokenDir = path.join(tempDir, ".openstarry-mcp", "tokens");
    expect(fs.existsSync(tokenDir)).toBe(true);
  });

  it("saves and loads tokens with encryption round-trip", async () => {
    const tokens: OAuthTokens = {
      accessToken: "secret-access-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600000,
      refreshToken: "secret-refresh-token",
      scope: "read write",
    };

    await storage.save(tokens);

    const loaded = await storage.load();
    expect(loaded).toEqual(tokens);
  });

  it("returns null if token file does not exist", async () => {
    const loaded = await storage.load();
    expect(loaded).toBeNull();
  });

  it("encrypts tokens differently each time (random IV and salt)", async () => {
    const tokens: OAuthTokens = {
      accessToken: "test-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600000,
    };

    await storage.save(tokens);
    const file1 = fs.readFileSync(
      path.join(tempDir, ".openstarry-mcp", "tokens", "test-server.json"),
      "utf8"
    );

    await storage.delete();
    await storage.save(tokens);
    const file2 = fs.readFileSync(
      path.join(tempDir, ".openstarry-mcp", "tokens", "test-server.json"),
      "utf8"
    );

    // Files should be different (different IV and salt)
    expect(file1).not.toBe(file2);

    // But decryption should yield same tokens
    const loaded = await storage.load();
    expect(loaded).toEqual(tokens);
  });

  it("deletes token file", async () => {
    const tokens: OAuthTokens = {
      accessToken: "test-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600000,
    };

    await storage.save(tokens);
    const tokenFile = path.join(tempDir, ".openstarry-mcp", "tokens", "test-server.json");
    expect(fs.existsSync(tokenFile)).toBe(true);

    await storage.delete();
    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it("delete is safe when file does not exist", async () => {
    await expect(storage.delete()).resolves.toBeUndefined();
  });

  it("returns valid token if not expired", async () => {
    const tokens: OAuthTokens = {
      accessToken: "valid-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 120000, // 2 minutes from now
    };

    await storage.save(tokens);

    const token = await storage.getToken();
    expect(token).toBe("valid-token");
  });

  it("returns null if token is expired and no refresh token", async () => {
    const tokens: OAuthTokens = {
      accessToken: "expired-token",
      tokenType: "Bearer",
      expiresAt: Date.now() - 1000, // Expired 1s ago
    };

    await storage.save(tokens);

    const token = await storage.getToken();
    expect(token).toBeNull();

    // Token file should be deleted after failed refresh
    const loaded = await storage.load();
    expect(loaded).toBeNull();
  });

  it("machine-binding: encrypted data cannot be decrypted with a different PBKDF2 key", async () => {
    const tokens: OAuthTokens = {
      accessToken: "machine-bound-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600000,
    };

    await storage.save(tokens);

    // Read the encrypted file
    const tokenFile = path.join(tempDir, ".openstarry-mcp", "tokens", "test-server.json");
    const raw = fs.readFileSync(tokenFile, "utf8");
    const encrypted = JSON.parse(raw) as EncryptedTokenData;

    // Try to decrypt with a different key (simulate different machine)
    const salt = Buffer.from(encrypted.salt, "hex");
    const differentKey = crypto.pbkdf2Sync(
      "different-host|different-user|openstarry-mcp-v1",
      salt,
      100000,
      32,
      "sha512"
    );
    const iv = Buffer.from(encrypted.iv, "hex");
    const tag = Buffer.from(encrypted.tag, "hex");

    const decipher = crypto.createDecipheriv("aes-256-gcm", differentKey, iv);
    decipher.setAuthTag(tag);

    // Decryption with wrong key should throw (GCM authentication failure)
    expect(() => {
      let decrypted = decipher.update(encrypted.data, "base64", "utf8");
      decrypted += decipher.final("utf8");
    }).toThrow();
  });

  it("machine-binding: key derivation uses hostname and username", () => {
    // Verify that different machine IDs produce different PBKDF2 keys
    const salt = crypto.randomBytes(16);
    const key1 = crypto.pbkdf2Sync(
      `${os.hostname()}|${os.userInfo().username}|openstarry-mcp-v1`,
      salt,
      100000,
      32,
      "sha512"
    );
    const key2 = crypto.pbkdf2Sync(
      "other-host|other-user|openstarry-mcp-v1",
      salt,
      100000,
      32,
      "sha512"
    );

    // Keys must be different for different machine IDs
    expect(key1.equals(key2)).toBe(false);
  });

  it("token refresh: attempts refresh when token expires soon", async () => {
    const oauthConfig: McpOAuthConfig = {
      enabled: true,
      tokenUrl: "https://oauth.example.com/token",
      clientId: "test-client",
      scopes: "read",
    };

    const storageWithOAuth = new EncryptedTokenStorage(mockContext, "test-server", oauthConfig);

    const tokens: OAuthTokens = {
      accessToken: "expiring-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 30000, // Expires in 30s (< 60s buffer)
      refreshToken: "refresh-token-123",
    };

    await storageWithOAuth.save(tokens);

    // Mock fetch for token refresh
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "new-refresh-token",
          }),
      } as Response)
    );

    const token = await storageWithOAuth.getToken();

    expect(global.fetch).toHaveBeenCalledWith(
      oauthConfig.tokenUrl,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/x-www-form-urlencoded",
        }),
      })
    );

    expect(token).toBe("new-access-token");

    // Verify new tokens are saved
    const loaded = await storageWithOAuth.load();
    expect(loaded?.accessToken).toBe("new-access-token");
    expect(loaded?.refreshToken).toBe("new-refresh-token");
  });

  it("token refresh: deletes tokens if refresh fails", async () => {
    const oauthConfig: McpOAuthConfig = {
      enabled: true,
      tokenUrl: "https://oauth.example.com/token",
      clientId: "test-client",
    };

    const storageWithOAuth = new EncryptedTokenStorage(mockContext, "test-server", oauthConfig);

    const tokens: OAuthTokens = {
      accessToken: "expiring-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 30000,
      refreshToken: "invalid-refresh-token",
    };

    await storageWithOAuth.save(tokens);

    // Mock fetch to fail
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 401,
      } as Response)
    );

    const token = await storageWithOAuth.getToken();
    expect(token).toBeNull();

    // Tokens should be deleted
    const loaded = await storageWithOAuth.load();
    expect(loaded).toBeNull();
  });

  it("onUnauthorized: returns true if refresh succeeds", async () => {
    const oauthConfig: McpOAuthConfig = {
      enabled: true,
      tokenUrl: "https://oauth.example.com/token",
      clientId: "test-client",
    };

    const storageWithOAuth = new EncryptedTokenStorage(mockContext, "test-server", oauthConfig);

    const tokens: OAuthTokens = {
      accessToken: "old-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600000,
      refreshToken: "refresh-token",
    };

    await storageWithOAuth.save(tokens);

    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
      } as Response)
    );

    const shouldRetry = await storageWithOAuth.onUnauthorized();
    expect(shouldRetry).toBe(true);
  });

  it("onUnauthorized: returns false if no refresh token", async () => {
    const tokens: OAuthTokens = {
      accessToken: "token-no-refresh",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600000,
    };

    await storage.save(tokens);

    const shouldRetry = await storage.onUnauthorized();
    expect(shouldRetry).toBe(false);
  });

  it("handles corrupted token file gracefully", async () => {
    const tokenFile = path.join(tempDir, ".openstarry-mcp", "tokens", "test-server.json");
    fs.writeFileSync(tokenFile, "corrupted-json-{{{", "utf8");

    const loaded = await storage.load();
    expect(loaded).toBeNull();
  });
});
