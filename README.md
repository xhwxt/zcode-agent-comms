# agent-comms — Real-time Main↔Subagent Communication for ZCode

**ZCode 主/子代理实时互通插件**（中文说明见下）

## English

### What it is

A zero-dependency ZCode plugin that gives main agents and subagents **real-time, auditable communication**: subagents proactively report progress to an auditable anchor-artifact spool, and the main agent gets a Codex-`wait_agent`-style primitive — **block waiting for ANY live worker**, with silence detection and per-worker status summaries.

ZCode already ships the hard pipes (SendMessage can steer a running subagent; subagents can `RespondToCoordinator` to reach the main agent at tool boundaries, even waking an idle one). What's missing is the **proactive reporting protocol** (soft half) and the **wait-for-any-worker primitive** (hard half). This plugin adds both:

- **Protocol baked into bundled agent types** (resent with every request — context compaction can't erase it), following the official "tool surface follows role" pattern:
  - `agent-comms:worker` — executor type: full tool surface (`*`), hard-excluded via `disallowedTools` from channel consumption and grandchild spawning
  - `agent-comms:scout` — read-only recon type: 7 read-only tools (Read/Grep/Glob/Bash/WebFetch/WebSearch + report), mirroring the official Explore pattern
- **Four MCP tools**: `open_channel` (random-suffixed channel per batch, cross-session collision-proof), `report` (atomic anchor-artifact writes, server-side throttle: non-`done` reports ≥2s apart per worker), `wait_worker_event` (long-poll for any worker's event; timeout summary includes each worker's last event age), `read_events` (catch-up reads)
- **Mailbox storage semantics**: events live in `~/.zcode/agent-comms/spool/<channel>/{unread,read}/`; `wait` drains `unread`→`read`, so events dispatched-before-waiting are never lost, and everything stays plaintext-auditable (a deliberate contrast to Codex's encrypted inter-agent messages)
- **Two-channel routing** (in protocol text): routine milestones → `report` (auditable, aggregate-waitable); urgent (acceptance criteria changing / wasted work ahead / irreversible ops / external blocker overdue) → kernel `RespondToCoordinator` for instant delivery or idle wakeup

### Install

**Official marketplace flow (recommended):** the repo root ships a ZCode marketplace manifest. In ZCode: Settings → Plugin Management → Discover → add `https://github.com/xhwxt/zcode-agent-comms` → install **Agent Comms**. The plugin is copied into ZCode's plugin cache and registered like any marketplace plugin — no local checkout needed.

**Dev flow:** register your repo checkout as a local directory marketplace (`plugins.extraKnownMarketplaces` in `~/.zcode/cli/config.json`) — edits to plugin files take effect immediately, no reinstall.

Prerequisite: Node.js (≥18) on PATH. The MCP server is spawned as `node ${ZCODE_PLUGIN_ROOT}/mcp/server.mjs`; the `${ZCODE_PLUGIN_ROOT}` placeholder is expanded by ZCode to the plugin install root, so the repo can live anywhere.

### Usage (coordinator side)

The plugin ships a skill (`agent-comms`) that the main agent picks up when dispatching workers:

```
1. open_channel {slug}                       → channel like "fix-login-a3f2c1"
2. Dispatch Agent(subagent_type="agent-comms:worker", prompt:
     comms 频道 <channel>
     worker 名 worker-1
     <task...>)
3. wait_worker_event {channel, timeout_ms}   → loop until all workers report done
4. On timeout: silence summary lists per-worker last-event age → SendMessage nudge, or verify via shared-DB tool trace
```

### Verification

Scenario-tested on ZCode 0.16.5 headless CLI (T0–T9): type registration, protocol probes, event persistence (filesystem-verified), blocking wait semantics, silence detection, urgent-channel delivery while the coordinator is blocked in `wait`, cross-session channel isolation, and runtime `disallowedTools` enforcement. See `docs/` for the full design doc and evidence (Chinese).

## 中文

### 这是什么

零依赖的 ZCode 插件，让主代理与子代理获得**实时、可审计的沟通能力**：子代理按注入协议主动汇报进度（落锚工件），主代理获得对位 Codex `wait_agent` 的原语——**阻塞等待任意存活 worker**，带沉默检测与逐 worker 状态摘要。

ZCode 内核已有硬管道（SendMessage 可 steer 运行中的子代理；子代理可经 RespondToCoordinator 在工具边界送达主代理、空闲时直接唤醒），缺的是**主动汇报协议**（软的一半）与**等任意 worker 原语**（硬的一半）。本插件补齐两者：

- **协议烧进自带 agent 类型**（随系统提示词每请求重发，上下文压缩清不掉），按官方"工具面跟随角色"原则配两型：
  - `agent-comms:worker` ——执行型：全工具，`disallowedTools` 硬排除频道消费与孙代理派生
  - `agent-comms:scout` ——只读核查型：7 个只读工具，对齐官方 Explore
- **四个 MCP 工具**：`open_channel`（slug+随机后缀频道，多会话并发不串台）、`report`（原子写锚工件，服务端节流：非 done 每 worker ≥2s）、`wait_worker_event`（长轮询等任意 worker，超时摘要含各 worker 最后事件时间）、`read_events`（断线补读）
- **邮箱存储语义**：事件落 `~/.zcode/agent-comms/spool/<频道>/{unread,read}/`，wait 抽干 unread→read——先派发后等待不丢事件，全程明文可审计（与 Codex 加密代理间消息的刻意反向选择）
- **双通道路由**（写进协议）：例行里程碑 → report（可审计可聚合）；紧急四情形（验收标准要变/即将无效功/不可逆操作/外部阻塞超期）→ 内核 RespondToCoordinator 即时送达或空闲唤醒

### 安装与使用

**官方市场流程（推荐）**：仓库根自带 ZCode 市场清单。ZCode → 设置 → 插件管理 → 发现 → 添加 `https://github.com/xhwxt/zcode-agent-comms` → 安装 **Agent Comms**；插件会像市场插件一样被复制进 ZCode 的插件缓存注册，无需本地检出。

**开发者流程**：把仓库检出注册为本地目录市场（`~/.zcode/cli/config.json` 的 `plugins.extraKnownMarketplaces`），改插件文件即时生效、无需重装。

前置要求：PATH 上有 Node.js（≥18）。MCP 服务器以 `node ${ZCODE_PLUGIN_ROOT}/mcp/server.mjs` 启动，`${ZCODE_PLUGIN_ROOT}` 占位符由 ZCode 内核展开为插件安装根目录，仓库放哪都能跑。协调者侧用法见上方英文节的四步循环（插件自带 skill 会在派发场景自动触发引导）。

### 验证与文档

已在 ZCode 0.16.5 headless CLI 完成 T0–T9 场景实测（类型注册、协议探针、事件落盘文件侧核验、阻塞等待、沉默检测、协调者阻塞中收紧急消息、双会话频道隔离、黑名单运行时生效）。完整开发方案与证据见 [docs/子代理沟通-开发方案-2026-09-08.md](docs/子代理沟通-开发方案-2026-09-08.md)。

## Status / 状态

v0.2.6. Works on ZCode desktop + headless CLI（Windows 先行）. Roadmap: per-channel report authentication, spool retention/cleanup, spawn preflight, board integration (mailbox pump for comment relays).
