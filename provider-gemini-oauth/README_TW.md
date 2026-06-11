# @openstarry-plugin/provider-gemini-oauth

Google Gemini LLM provider，採 PKCE OAuth 2.0 認證 + 機器綁定 token 加密。

## 五蘊定位

**IProvider (想蘊)** — 透過 Gemini API 進行認知處理（含 streaming 支援）。

## 安裝

```bash
pnpm add @openstarry-plugin/provider-gemini-oauth
```

## 設定

加入 `agent.json`:

```json
{
  "plugins": [
    {
      "name": "@openstarry-plugin/provider-gemini-oauth",
      "config": {
        "projectId": "openstarry-491612"
      }
    }
  ],
  "cognition": {
    "provider": "gemini-oauth"
  }
}
```

**`projectId` 為必填**（cycle 03-21 hotfix v0.55.2-alpha）。Google API 規則：
OAuth 認證呼叫 `generativelanguage.googleapis.com` **必須**含
`X-Goog-User-Project` header 指定 quota 計費的 GCP project。Plugin 依序從以下
位置讀取 `projectId`：

1. `OPENSTARRY_GEMINI_PROJECT_ID` 環境變數（覆寫 config）
2. `agent.json` plugin `config.projectId`
3. Managed-project provisioning（若 `/provider login gemini-oauth` 已 provision project 則自動探得）

若以上皆無解，inference 將以 operator-actionable error 立即失敗。

首次使用前先登入：

```bash
/provider login gemini-oauth
```

## 安全機制

- **PKCE OAuth 2.0**：以 code_verifier + code_challenge 防 authorization code 攔截
- **機器綁定加密**：token 用 hostname + username 衍生的 key 加密
- **檔案權限**：token 檔案以 `chmod 600` 儲存
- **自動續 token**：access token 用 refresh token 自動續發

## OAuth Scopes（cycle 03-21 hotfix v0.55.1-alpha）

本 plugin 在 PKCE login 期間要求以下 Google OAuth scopes：

| Scope | 用途 |
|-------|------|
| `https://www.googleapis.com/auth/cloud-platform` | Inference（`generateContent` / `streamGenerateContent`）+ 未來 Gemini API 擴展 |
| `openid` | 身份斷言 |
| `https://www.googleapis.com/auth/userinfo.email` | 帳戶 email 查詢 |
| `https://www.googleapis.com/auth/userinfo.profile` | 帳戶 profile metadata |

**遷移說明（v0.55.1-alpha）**：hotfix 之前的版本請求 `generative-language.tuning`，
該 scope 僅允許 fine-tuning（訓練模型）— **不允許 inference**。升版後 Master
必須刪除既有 token 並重新登入：

```bash
rm ~/.openstarry/plugins/gemini-oauth/oauth_token.json
# 然後重跑：
/provider login gemini-oauth
```

Google Cloud Console 的 OAuth client 必須在 OAuth consent screen 內 whitelist
`cloud-platform`，重新登入才會成功。若 client 未 whitelist，需要重新註冊一組
新 client 並重新 bake `oauth-client.enc.json`。

## 環境變數

| Variable | 說明 |
|----------|------|
| `OPENSTARRY_GEMINI_PROJECT_ID` | 覆寫自動配發的 project ID |

## 開發

```bash
pnpm build
pnpm test
```

## 參見

- OpenStarry SDK: `IProvider` interface
