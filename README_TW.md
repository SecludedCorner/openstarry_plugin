# OpenStarry 插件

[OpenStarry](https://github.com/SecludedCorner/openstarry) AI Agent 框架的官方插件生態系。

[English](./README.md)

## 總覽

本 repo 含 **45 個套件——44 個可載入插件，加上一個共享型別庫（`mcp-common`）**，透過**五蘊**架構擴展 OpenStarry 的能力。每個插件都是獨立套件，遵循工廠模式（`createXxxPlugin()` → 帶 `manifest` ＋ `factory(ctx)` 的 `IPlugin`）。

> canonical 蘊歸屬（見文件庫 [Deep Dive 14](https://github.com/SecludedCorner/openstarry_doc/blob/main/Agent_Core_Components_Deep_Dive/14_Agent_Core_Philosophy_Five_Aggregates.md)）：**色 Form = `IRupa` = `IUI`（輸出）＋ `IListener`（輸入）**——監聽器是感官根門，所以 transport/listener 歸**色蘊**，不是受蘊。**受 Sensation = `IVedana`**（感受品質）。**想 Perception = `ISamjna` = `IProvider`**（與 context manager）。**行 Formation = `ISamskara` = `ITool`**。**識 Consciousness = `IVijnana` = `IGuide`**（身份、治理、意志）。

## 插件清單

### 色 Form（IRupa — IUI 輸出 ＋ IListener 輸入）

| 插件 | 說明 |
|--------|------|
| `web-ui` | 瀏覽器聊天介面 |
| `tui-dashboard` | 終端機 UI 面板（Ink） |
| `standard-function-stdio` | CLI 互動的標準 I/O 監聽器 |
| `transport-websocket` | WebSocket 傳輸 |
| `transport-http` | HTTP/SSE 傳輸 |
| `transport-local-cli` | 本地 CLI 傳輸 |
| `http-static` | 靜態檔案伺服器 |
| `mcp-client` | MCP 客戶端（連外部 MCP server） |
| `mcp-server` | MCP server（把 agent 暴露為 MCP 服務） |
| `comm-pipeline` | 跨代理通訊頻道（驗證層——見帳本 #10） |

### 受 Sensation（IVedana — 感受品質）

| 插件 | 說明 |
|--------|------|
| `vedana-sensor-core` | 三通道感受偵測（苦／樂／捨）→ `createVedanaFn` |

### 想 Perception（ISamjna — 供應者＋記憶策略）

| 插件 | 說明 |
|--------|------|
| `provider-claude` | Anthropic Claude（直連 API） |
| `provider-claude-cli` | 透過本地 `claude` CLI |
| `provider-chatgpt` | OpenAI ChatGPT（API key） |
| `provider-chatgpt-oauth` | OpenAI ChatGPT（OAuth） |
| `provider-gemini` | Google Gemini（API key） |
| `provider-gemini-oauth` | Google Gemini（OAuth，支援免費額度） |
| `provider-lmstudio` | LM Studio（OpenAI 相容本地推理） |
| `provider-local-llama` | Ollama／本地 llama（原生 API） |
| `context-sliding-window` | 滑動窗口記憶管理（`IContextManager`） |
| `context-summary` | 摘要式記憶管理（`IContextManager`） |

### 行 Formation（ISamskara — 工具）

| 插件 | 說明 |
|--------|------|
| `standard-function-fs` | 檔案系統操作（讀/寫/列/建/刪） |
| `workflow-engine` | 工作流引擎（loop/while 步驟＋落盤狀態） |
| `devtools` | 開發者工具（inspect、debug） |
| `agent-ask` | 把認知迴圈暴露為可委派工具（分形組合，帳本 #10） |
| `agent-spawn` | `agent.spawnChild` 工具——agent 自己的迴圈生成子進程（帳本 #10；僅 daemon 模式） |
| `confirmation-gate-standard` | 工具呼叫確認閘（approve／deny／ask_user） |
| `comm-proxy` | 故障隔離裝飾器（熔斷器＋艙壁——驗證層） |

### 識 Consciousness（IVijnana — 引導、治理、意志）

| 插件 | 說明 |
|--------|------|
| `guide-character-init` | 角色／系統提示初始化引導 |
| `guide-persistent` | 持久化引導狀態 |
| `auditor-threshold` | 信心閾值審計 |
| `auditor-passthrough` | 直通審計（no-op 基準） |
| `monitor-loop-quality` | 認知迴圈品質監控 |
| `volition-rule-engine` | 意志審議規則引擎 |
| `standard-function-skill` | Markdown 定義的技能執行 |
| `api-runtime` | API 運行時能力面 |

### 運行時、治理與共享

| 插件 | 說明 |
|--------|------|
| `gear-arbiter-static` | 靜態雙齒輪仲裁（`IGearArbiter`） |
| `gear-arbiter-dynamic` | 動態雙齒輪仲裁 |
| `distributed-alaya` | 跨進程種子庫（八識／阿賴耶；N=2 單機、HMAC 簽章、replay nonce） |
| `vasana-engine` | 習氣引擎 |
| `mesh` | Mesh 協調子系統 |
| `spc-monitor` | 統計製程管制監控 |
| `standard-model-selector` | 模型／供應者選擇服務 |
| `standard-core-commands` | 內建斜線指令 |
| `mcp-common` | **共享 MCP 型別/常數——是函式庫，非可載入插件**（無 manifest） |

> 誠實邊界：`comm-pipeline`／`comm-proxy`／獨立的 `openstarry-channel` 中樞為驗證層或未接入已實證路徑（路由走 MCP）。見[十大宣言兌現帳本](https://github.com/SecludedCorner/openstarry_doc/blob/main/TENETS_FULFILLMENT.md) #10。

## 使用方式

本 repo 與 `openstarry` 核心 repo 並列：

```
your-workspace/
├── openstarry/            ← 核心框架
└── openstarry_plugin/     ← 本 repo
```

核心的 `pnpm-workspace.yaml` 含 `../openstarry_plugin/*`，所有插件自動納入 workspace：

```bash
cd openstarry
pnpm install    # 安裝全部（含插件）
pnpm build      # 編譯全部套件與插件
pnpm test       # 跑全部測試
```

### 透過 CLI 安裝插件

```bash
node apps/runner/dist/bin.js plugin search fs
node apps/runner/dist/bin.js plugin install standard-function-fs
node apps/runner/dist/bin.js plugin install --all
node apps/runner/dist/bin.js plugin list
```

## 建立插件

每個插件 export 一個回傳 `IPlugin` 的工廠函數：

```typescript
import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";
import { z } from "zod";

export function createMyPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/my-plugin",
      version: "1.0.0",
      description: "My custom plugin",
      skandha: "samskara",
    },
    factory(ctx: IPluginContext): PluginHooks {
      return {
        tools: [
          {
            name: "my-tool",
            description: "Does something useful",
            parameters: z.object({ input: z.string() }),
            execute: async ({ input }) => ({ success: true, result: input.toUpperCase() }),
          },
        ],
        dispose() { /* 關閉時清理 */ },
      };
    },
  };
}
```

## 授權

Apache-2.0——見 [LICENSE](./LICENSE) 與 [NOTICE](./NOTICE)。
