# @openstarry-plugin/provider-claude-cli

Claude CLI subprocess provider — 透過 `claude -p` print mode 包裝本機 `claude`
binary（Anthropic Claude Code）。**不需 auth setup**、**plugin 不持有任何
key 材料**，子行程繼承使用者既有 OAuth/Pro session。

## 五蘊定位

**IProvider (想蘊)** — 透過 Claude CLI subprocess 進行認知處理。

## 前置需求

- 安裝 CLI：`npm install -g @anthropic-ai/claude-code`
- 認證一次：`claude auth login`（Pro/Max 走瀏覽器 OAuth）或設 `ANTHROPIC_API_KEY`
- 驗證：`claude auth status`

## 設定

加入 `agent.json`：

```json
{
  "plugins": [
    {
      "name": "@openstarry-plugin/provider-claude-cli",
      "config": {
        "model": "sonnet",
        "effort": "medium",
        "maxTurns": 1,
        "timeout": 60000
      }
    }
  ],
  "cognition": {
    "provider": "claude-cli",
    "model": "sonnet"
  }
}
```

| 選項 | 預設 | 說明 |
|------|------|------|
| `model` | `"sonnet"` | 模型別名（`sonnet`/`opus`/`haiku`）或完整 id（如 `claude-sonnet-4-6`） |
| `effort` | （略） | `low`/`medium`/`high`/`max`/`auto` reasoning-effort 提示，傳給 `--effort` |
| `maxTurns` | `1` | 子行程 `--max-turns`（1 = 純 inference，無 agentic loop） |
| `timeout` | `60000` | 子行程 kill 門檻（ms） |

## 行程級隔離保證（5 點）

本 plugin 提供 Tier-0 隔離保證（per Master directive cycle 03-21 in-flight
2026-05-03）。違反任一點為 critical bug。

1. **每次 call 建新 subprocess** — `chat()` 呼叫都生成全新 `claude` 行程；無 state carry。
2. **OAuth 相容隔離三件組強制** (HOTFIX v4 v0.55.4-alpha):
   - `--system-prompt <minimal>` — 覆蓋繼承的 `CLAUDE.md` / 使用者 prompt context，
     用一行 "inference-engine" persona 取代。
   - `--strict-mcp-config --mcp-config <empty.json>` — 把 subprocess 指向寫在 OS
     tmpdir 的空 MCP server map，skip MCP discovery。
   - `--disable-slash-commands` — skills 無法 invoke。

   *（`--bare` 已移除，因其要求 `ANTHROPIC_API_KEY`，與從 `claude auth login` 繼承的
   Pro/Max OAuth session 不相容。）*
3. **強制 `--disallowedTools`** — Bash、Read、Edit、Write、WebSearch、WebFetch、Grep、Glob、NotebookEdit 全停用。OpenStarry agent loop 自己管 tools；CLI subprocess 只做 text inference。
4. **強制 `--no-session-persistence`** — 不寫 session log 到 disk。
5. **不動 settings 檔** — plugin **永不**寫 `~/.claude/*`、`.claude/*` 或任何相關設定。空 MCP 檔寫在
   `<os.tmpdir()>/openstarry-claude-cli-mcp-empty-<pid>.json`（per-PID 隔離）。
   通訊嚴格走 `argv` + `stdin/stdout` + 繼承環境變數。

這些保證確保你的互動 Claude session（或任何並行 `claude` CLI session）
完全不受本 plugin 的 subprocess 影響。

## 模型

| 別名 | 說明 |
|------|------|
| `sonnet` | 最新 Claude Sonnet（預設） |
| `opus`   | 最新 Claude Opus |
| `haiku`  | 最新 Claude Haiku |

完整 model id（例：`claude-sonnet-4-6`）也接受。

## Function Calling

**不支援**。CLI 的 stream-json 輸出不暴露 OpenStarry agent loop 可用的 tool
schema。Plugin 宣告 text-only inference；OpenStarry agent loop 自然 fallback。

對 W2-R26 verification scope（deterministic NEG/POS cases + σ_regime
composition_index），text-only inference 已足。

## Cycle 03-25 M3 Security Fixes (v0.57.2-alpha)

依 Master directive 2026-05-07 + Master Ratification Batch 22 14/14 APPROVED，
本 plugin 接受 M3 P1+P2+P4 = 9-finding security fix。**ε-surface 不變
Δ=0**（不改 manifest / provider-id / model list / schema / HMAC posture —
僅內部行為修正）。

### P1 — Critical defenses

- **F-CY25-§4-R1-07** Claude CLI 主版號 pin（縱深防禦）：`AUDITED_CLI_MAJORS`
  常數記錄已通過 9-tool `--disallowedTools` list 安全 audit 的 CLI 主版號。
  當 live binary 回報主版號超出 set 時，adapter warn-log re-audit-required
  事件（operator-aware；非硬阻擋）。9-tool disallow-list 仍為第二層。
- **F-CY25-§4-R1-08** 未知 stream-event 行類型不再 silent drop：
  `mapStreamEvent` 接受可選 `onUnknown(lineType)` callback；production
  call site (`streamClaudeCli`) warn-log 未知類型。Stream 維持存活
  （defensive — 新 CLI 版本不會 break inference）。

### P2 — Important defenses

- **F-CY25-§4-R1-01** PATH-shadowing 安全二進制解析：`cliPath` 在 adapter
  init 透過 `resolveClaudeBinary()` (PATH-walk + `realpathSync`) 解析為絕對
  filesystem path。Subprocess 不再看到 relative path（PATH 較前面的惡意
  `claude` 無法 shadow）。
- **F-CY25-§4-R1-03** subprocess env 改為明確 ALLOWLIST (`ALLOWED_ENV_KEYS`)
  — 僅 `claude` 確需的 env vars (HOME / PATH / locale / OAuth dirs / TMPDIR
  / Windows essentials / 明確 Anthropic auth) 轉發。Agent-side 應用 secrets
  全部 drop。
- **F-CY25-§4-R2-04** multi-turn forward-gap warn：`cfg.maxTurns > 1` 配置
  時 adapter init warn-log（subprocess agentic loop 跑在內部；OpenStarry
  agent loop 無法 inspect 中間狀態 — 任何依賴 per-turn observability 的
  consumer 需要 re-audit）。

### P4 — Documentation (this section)

#### Prompt Channel + Role-Prefix Injection (F-CY25-§4-R1-06 + F-CY25-§4-R2-02)

Claude CLI 暴露單一 positional prompt argument (`-p <prompt>`)。本 plugin 的
`collapseToPrompt()` 將 multi-message `ChatRequest.messages` + 可選
`ChatRequest.systemPrompt` 序列化為帶 `System: ` / `User: ` / `Assistant: `
行 prefix 的 single transcript。

**呼叫者契約**：僅 app-supplied messages。若惡意 assistant message 含 literal
`\n\nUser: ...` sentinel，可能在 collapsed prompt 內 spoof 新 user turn。
OpenStarry agent loop 被信任只傳 application-controlled 內容；下游 consumer
若嵌入 untrusted user input，MUST 在 `chat()` 前 sanitize role-prefix sentinels。

#### Empty MCP Config 檔 mode 0o600 (F-CY25-§4-R2-06)

空 MCP config 檔 (`<os.tmpdir()>/openstarry-claude-cli-mcp-empty-<pid>.json`，
內容 `{"mcpServers": {}}`) 以 file mode `0o600` 建立 (僅 owner 讀寫)。
Same-host info-leak via 空 config 檔已 mitigate。檔案位於 OS tmpdir 且
per-PID 隔離 — 並行 process 不衝突。

#### HMAC Posture — Leaf Provider Non-Participation (F-CY25-§4-R1-09)

本 plugin 為 Plan52~Plan60 isomorph topology 的 **leaf provider**。**不**
參與 OpenStarry HMAC-SHA256 + nonce + replay-cache attestation 鏈（不
register `psh:` / `ac9:` / `mvq:` / `vsn:` / `msh:` / `apr:` / `aly:`
prefix）。Claude CLI subprocess 只提供 text inference；不 deposit seeds、
不 route mesh messages、不 queue volitions、不 invoke API runtime。

5-point process-level isolation guarantees (`--system-prompt` +
`--strict-mcp-config` + `--disable-slash-commands` + `--disallowedTools` +
`--no-session-persistence` + 不動 settings 檔) 為本 plugin 的 local defense
surface。HMAC 參與需要 non-leaf integration (forward-binding；不在 scope)。

## Cycle 03-27 衛生修補（v0.57.4-alpha）

依 Master directive 2026-05-09 §3.1 PASS path — cycle 03-25 R3 §4 延後的
5 個 LOW-tier P3 項目。ε-surface Δ=0 保持（manifest / provider-id /
model-list / schema / HMAC posture 皆未變動）。

| 項目 | 範圍 | 對外符號 |
|------|------|----------|
| F-CY25-§4-R1-02 | stderr disclosure 紅化（sk- / Bearer / ANTHROPIC_*=）+ 截斷 500 → 200 | `redactStderrForError` |
| F-CY25-§4-R1-04 | subprocess `cwd = tmpdir()` 編碼為可測試 export（v0.57.2 已隱含） | `getSubprocessCwd` |
| F-CY25-§4-R1-05 | per-PID `mcp-empty-${pid}.json` 由 `process.on("exit")` + dispose() 清除 | `cleanupEmptyMcpConfigPath` |
| F-CY25-§4-R2-03 | plugin `dispose()` 呼叫清理 + 重置 cached path | `dispose()` 接線 |
| F-CY25-§4-R2-05 | `resolveClaudeBinary` 在 module scope memoize（PATH-shadow fan-out → 1/input） | `_resolveBinaryCache` |

均為衛生細化；單獨來看不修補任何 security defect — 它們僅收緊
cycle 03-25 M3 P1+P2+P4 已建立的 defense-in-depth 表面。

## Stream-JSON Schema (HOTFIX v5 v0.55.5-alpha)

Plugin parse `claude -p --output-format stream-json --include-partial-messages`
ndjson 輸出，schema per Hermes SKILL.md（line 149-163）：

| Line type | Shape | OpenStarry event |
|-----------|-------|-------------------|
| `stream_event` | `{type:"stream_event", event:{delta:{type:"text_delta", text:"…"}}}` | `{type:"text_delta", text}` |
| `result` (success) | `{type:"result", subtype:"success", is_error:false, result:"<full text>", session_id, num_turns, total_cost_usd, …}` | `{type:"finish", stopReason:"end_turn"}` |
| `result` (error) | `{type:"result", subtype:"error_max_turns" \| "error_*", is_error:true, …}` | `{type:"error", error: Error("Claude CLI error: <subtype>")}` |
| `system` / `api_retry` | informational | 靜默 skip |

`result.result` 字串為完整 aggregated 回應文字 — 已透過 `stream_event` deltas
streamed，所以 plugin 只 emit `finish`（不重複 yield 整段）。

## 錯誤處理

| 情況 | 行為 |
|------|------|
| `claude` binary 找不到 | emit `error` event 含安裝指示 |
| Subprocess exit code ≠ 0 | emit `error` event 含 stderr 片段 |
| Subprocess 卡住超 timeout | kill 行程；emit timeout error |
| Stream JSON parse 失敗 | log warning；繼續（best-effort） |
| Subprocess 輸出空 | emit `error` event |

## 開發

```bash
pnpm build
pnpm test
```

## 參見

- OpenStarry SDK: `IProvider` interface
- Hermes orchestration guide: `claude research/人類資料區/學習資料/hermes agent skill for claude/SKILL.md`
- Claude Code reference: <https://code.claude.com/docs/en/cli-reference>
