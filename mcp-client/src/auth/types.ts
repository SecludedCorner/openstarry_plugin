/**
 * FROZEN INTERFACE — OAuth 2.1 types for MCP server authentication.
 *
 * MVP: Manual token entry workflow (defer full OAuth flow to Plan06-P4).
 */

/**
 * FROZEN INTERFACE
 * OAuth 2.1 configuration for MCP server authentication (MVP: manual token entry only)
 */
export interface McpOAuthConfig {
  /** Enable OAuth authentication (false = no auth) */
  enabled: boolean;
  /** OAuth token endpoint URL (for manual token exchange/refresh) */
  tokenUrl: string;
  /** OAuth client ID */
  clientId: string;
  /** OAuth client secret (optional for public clients) */
  clientSecret?: string;
  /** OAuth scopes (space-separated) */
  scopes?: string;
}

/**
 * FROZEN INTERFACE
 * OAuth token set (RFC 6749 + OpenID Connect)
 */
export interface OAuthTokens {
  /** Access token (Bearer token for API requests) */
  accessToken: string;
  /** Token type (usually "Bearer") */
  tokenType: string;
  /** Expiration timestamp (Unix ms) */
  expiresAt: number;
  /** Refresh token (optional, used to renew access token) */
  refreshToken?: string;
  /** ID token (optional, OpenID Connect) */
  idToken?: string;
  /** Scope granted by server (may differ from requested) */
  scope?: string;
}

/**
 * FROZEN INTERFACE
 * Encrypted token storage format (AES-256-GCM + PBKDF2)
 */
export interface EncryptedTokenData {
  /** Initialization vector (12 bytes, hex-encoded) */
  iv: string;
  /** GCM authentication tag (16 bytes, hex-encoded) */
  tag: string;
  /** PBKDF2 salt (16 bytes, hex-encoded) */
  salt: string;
  /** Encrypted token JSON (base64-encoded) */
  data: string;
}
