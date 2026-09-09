# 开发指南

🌐 [English](./developer-guide.md) | **中文**

本文件面向本地开发工作流。

关于贡献规则与期望，请参阅 [../CONTRIBUTING.md](../CONTRIBUTING.md)。

## 🚀 快速开始

### 开发环境配置

1. **前置要求**
    - `macOS` / `Linux` / `WSL`
    - `node.js ^22.13 || >=24`，且 `npm >= 11`
    - 支持 `ts/eslint/prettier` 的编辑器
    - 确保 `eslint`、`prettier` 和 `commitlint` 能正常工作。未通过 lint 的代码无法通过 CI。

2. **安装与启动**

    ```bash
    npm i            # 若不想改动 lockfile，可使用 `npm ci`
    npm start        # 启动 website 开发服务器
    npm run build    # 构建所有内容
    ```

## 📦 项目结构

这是一个基于 npm workspaces 的 **monorepo**。

已发布的包：

- **Page Agent** (`packages/page-agent/`) - 主入口，内置 UI 面板 (npm: `page-agent`)
- **MCP** (`packages/mcp/`) - 通过 Page Agent 扩展控制浏览器的 MCP 服务器 (npm: `@page-agent/mcp`)
- **Core** (`packages/core/`) - 不含 UI 的核心 agent 逻辑 (npm: `@page-agent/core`)
- **LLMs** (`packages/llms/`) - 采用「先反思、再行动」心智模型的 LLM 客户端
- **Page Controller** (`packages/page-controller/`) - DOM 操作与视觉反馈，独立于 LLM
- **UI** (`packages/ui/`) - 面板与国际化 (i18n)，与 PageAgent 解耦

应用：

- **Extension** (`packages/extension/`) - 浏览器扩展 (WXT + React)
- **Website** (`packages/website/`) - React 文档、落地页与开发调试场（私有，不发布）

> 源码优先的 monorepo，采用 `npm workspaces + ts references + vite alias`。开发期间，库的 `package.json` 中 `exports` 指向 `src/*.ts`；发布时则指向 `dist/*.js`。根目录 `package.json` 中的 `workspaces` 必须按拓扑顺序排列。

## 🤖 AGENTS.md 别名

如果你的 AI 助手不支持 [AGENTS.md](https://agents.md/)，请为它添加一个别名 (alias)。

## 🔧 开发工作流

### 使用你自己的 LLM API 进行测试

- 在仓库根目录创建 `.env` 文件，写入你的 LLM API 配置

    ```env
    LLM_MODEL_NAME=gpt-5.2
    LLM_API_KEY=your-api-key
    LLM_BASE_URL=https://api.your-llm-provider.com/v1
    ```

- **Ollama 示例**（已在 0.15 + qwen3:14b、RTX3090 24GB 上验证）：

    ```env
    LLM_BASE_URL="http://localhost:11434/v1"
    LLM_API_KEY="NA"
    LLM_MODEL_NAME="qwen3:14b"
    ```

    > 配置说明参见 https://alibaba.github.io/page-agent/docs/features/models#ollama

- **重启开发服务器**以加载新的环境变量
- 若未提供上述配置，demo 默认使用免费的测试代理。使用即表示你同意其[条款](./terms-and-privacy.md)。

### 扩展开发

```bash
npm run dev:ext
npm run build:ext
```

- 涉及 API 集成时，请同步更新 `packages/extension/docs/extension_api.md`

### 在其他网站上测试

- 启动并托管一个本地 `iife` 脚本

    ```bash
    npm run dev:demo # 以 IIFE 形式提供服务，修改时自动重建，地址 http://localhost:5174/page-agent.demo.js
    ```

- 添加一个新书签

    ```javascript
    javascript:(function(){var s=document.createElement('script');s.src=`http://localhost:5174/page-agent.demo.js?lang=en-US&t=${Math.random()}`;s.onload=()=>console.log(%27PageAgent ready!%27);document.head.appendChild(s);})();
    ```

- 在任意页面点击该书签即可加载 Page-Agent

> 警告：本地 `.env` 中的 AK (API Key) 会被内联进 iife 脚本中。分发该脚本时务必格外小心。

### 添加文档

让 AI 帮你向 `website/` 包添加文档，并遵循现有风格。

> 我们的 AGENTS.md 文件与护栏 (guardrails) 正是为此而设计。但请务必仔细审查任何 AI 生成的内容。
