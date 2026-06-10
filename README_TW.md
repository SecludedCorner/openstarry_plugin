# OpenStarry 插件生態系統

[OpenStarry](https://github.com/openstarry/openstarry) AI Agent 框架的官方插件生態系統。

[English](./README.md)

## 概述

本 repo 包含 15 個官方插件，透過 **五蘊** 架構擴展 OpenStarry 的功能。每個插件都是獨立套件，採用 factory 模式。

## 插件清單

### 工具 (ITool — 行)

| 插件 | 套件名 | 說明 |
|------|--------|------|
| `standard-function-fs` | `@openstarry-plugin/standard-function-fs` | 檔案系統操作（讀取、寫入、列出、刪除） |
| `standard-function-stdio` | `@openstarry-plugin/standard-function-stdio` | 標準 I/O，CLI 互動 |
| `standard-function-skill` | `@openstarry-plugin/standard-function-skill` | 技能執行（Markdown 定義的技能） |
| `devtools` | `@openstarry-plugin/devtools` | 開發者工具（inspect、debug） |
| `workflow-engine` | `@openstarry-plugin/workflow-engine` | YAML 工作流引擎 |

### 監聽器 (IListener — 受)

| 插件 | 套件名 | 說明 |
|------|--------|------|
| `transport-websocket` | `@openstarry-plugin/transport-websocket` | WebSocket 傳輸層 |
| `transport-http` | `@openstarry-plugin/transport-http` | HTTP/SSE 傳輸層 |
| `http-static` | `@openstarry-plugin/http-static` | 靜態檔案伺服 |
| `mcp-client` | `@openstarry-plugin/mcp-client` | MCP 客戶端（連接外部 MCP 伺服器） |
| `mcp-server` | `@openstarry-plugin/mcp-server` | MCP 伺服器（將 agent 曝露為 MCP 服務） |

### 供應者 (IProvider — 想)

| 插件 | 套件名 | 說明 |
|------|--------|------|
| `provider-gemini-oauth` | `@openstarry-plugin/provider-gemini-oauth` | Google Gemini OAuth（支援免費額度） |

### 介面 (IUI — 色)

| 插件 | 套件名 | 說明 |
|------|--------|------|
| `tui-dashboard` | `@openstarry-plugin/tui-dashboard` | 終端介面 Dashboard (Ink) |
| `web-ui` | `@openstarry-plugin/web-ui` | 瀏覽器聊天介面 |

### 引導 (IGuide — 識)

| 插件 | 套件名 | 說明 |
|------|--------|------|
| `guide-character-init` | `@openstarry-plugin/guide-character-init` | 角色初始化引導 |

### 共用

| 插件 | 套件名 | 說明 |
|------|--------|------|
| `mcp-common` | `@openstarry-plugin/mcp-common` | MCP 共用型別與工具 |

## 使用方式

### 搭配核心框架

本 repo 需與 `openstarry` 核心 repo 放在同一個父目錄下：

```
your-workspace/
├── openstarry/            ← 核心框架
└── openstarry_plugin/     ← 本 repo
```

核心的 `pnpm-workspace.yaml` 已包含 `../openstarry_plugin/*`，所有插件自動納入工作區。

```bash
cd openstarry
pnpm install    # 安裝全部（含插件）
pnpm build      # 編譯所有套件與插件
pnpm test       # 執行所有測試
```

### 透過 CLI 管理插件

```bash
# 搜尋插件
node apps/runner/dist/bin.js plugin search fs

# 安裝單一插件
node apps/runner/dist/bin.js plugin install standard-function-fs

# 安裝全部官方插件
node apps/runner/dist/bin.js plugin install --all

# 列出已安裝插件
node apps/runner/dist/bin.js plugin list

# 卸載插件
node apps/runner/dist/bin.js plugin uninstall standard-function-fs
```

## 建立新插件

每個插件匯出一個 factory 函式，回傳 `IPlugin`：

```typescript
import type { IPlugin, IPluginContext, PluginHooks } from "@openstarry/sdk";

export function createMyPlugin(): IPlugin {
  return {
    manifest: {
      name: "@openstarry-plugin/my-plugin",
      version: "1.0.0",
      description: "我的自訂插件",
      aggregates: ["tool"],
    },
    factory(ctx: IPluginContext): PluginHooks {
      return {
        tools: [
          {
            name: "my-tool",
            description: "做一些有用的事",
            parameters: z.object({ input: z.string() }),
            execute: async ({ input }) => {
              return { success: true, result: input.toUpperCase() };
            },
          },
        ],
        dispose() {
          // 關閉時清理資源
        },
      };
    },
  };
}
```

快速建立插件骨架：

```bash
node apps/runner/dist/bin.js create-plugin my-plugin
```

## 授權

MIT
