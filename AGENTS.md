# 任务看板 — 工作区指令

## 验证方式偏好（2026-09-08 用户确认）

- **未要求不主动开浏览器目检**。
- **功能迭代只跑相关测试，全量测试留到发布前**。

## 当前状态（2026-09-08 更新）

- 本工作区已 `git init`，首个落地代码是子代理沟通插件 **agent-comms v0.2.7（P0–P2 + 双类型 + 双审查整改 + M1/M2/低危挂账全部收口，已公开发布）**：https://github.com/xhwxt/zcode-agent-comms（Public，干净历史）。开发方案与验证记录见 [docs/子代理沟通-开发方案-2026-09-08.md](docs/子代理沟通-开发方案-2026-09-08.md)。
- **目录结构**：`plugin/`（本地市场根，marketplace.json）＋ `plugin/agent-comms/`（插件本体：agents/ 双类型协议注入（worker 全工具 + scout 只读）、mcp/server.mjs 四个工具、skills/ 协调者协议）；`tests/headless_run.py`（headless 场景测试运行器）、`tests/test_server.py`（确定性回归套件）、`scripts/bump_version.py`（版本号 4 处统一）；`docs/`（方案与调研）。
- **测试命令**：确定性回归（零模型成本）`python tests/test_server.py`；headless 场景测试（密钥运行时读取不入库）`python tests/headless_run.py "<单行 prompt>"`；插件侧功能测试=派发 `agent-comms:worker` 后对 `C:\Users\<用户>\.zcode\agent-comms\spool\<频道>\` 做文件系统侧独立核验（unread→read 消费语义）。改 server.mjs 必跑确定性套件。
- **安全模型（v0.2.7 起）**：每频道一枚随机令牌（open_channel 签发，落 `<channel>/.token`），report/wait/read 全部必验；派发 prompt 必须含三行「comms 频道 / worker 名 / comms 令牌」。read/ 每频道只保留最新 200 条（`AGENT_COMMS_READ_KEEP` 可调）。
- **开发期安装状态**：插件以本地市场方式装在用户级（`installed_plugins.json` 条目 agent-comms@zcode-agent-comms + `cli/config.json` 的 enabledPlugins/extraKnownMarketplaces 指向本仓库根的 marketplace.json）；他人可走官方流程安装（插件管理 → 发现 → 粘贴 https://github.com/xhwxt/zcode-agent-comms）。**改动 plugin/ 下文件即时生效，无需重装**（installPath 直指仓库）。
- 项目方向已由用户确认：**自研任务看板，第一阶段支持 ZCode，后期扩充 Codex、Hermes Agent**。
- 前期调研已完成，见 [docs/调研笔记-2026-09-06.md](docs/调研笔记-2026-09-06.md)：含 ZCode 三层数据源（`~/.zcode/v2/tasks-index.sqlite`、`~/.zcode/cli/db/db.sqlite` 的 session/todo/usage 表、文件+原子锁协议先例）与 GitHub 高星同类项目对比；改数据读取逻辑前先读它。
- 产品形态已定：**Web 起步，独立本机服务**；交互模型为"人发任务 → 看板调 AI 拆解 → agent 自主接单执行 → 人验收"。需求拆解见 [docs/需求拆解草案-2026-09-06.md](docs/需求拆解草案-2026-09-06.md)。
- 技术栈边界：插件本体是 Node（ZCode 插件 MCP 服务器用 node spawn，零依赖 .mjs）；**看板服务的技术栈仍未最终确认**（草案推荐 Python FastAPI + SQLite + Vite/React），确认前不得假设任何框架、依赖或构建命令。
- 插件相关实测事实（勿重查）：本地插件注册机制、agent 定义格式、headless CLI 运行配方（provider/model 格式 + key 来源），全部记录在方案文档 §3 与项目记忆。

## 维护规则

- 本文件只写"未来 agent 不查就会漏掉"的项目事实。落地新模块时，由当时的 agent 补充：技术栈、目录结构、构建 / 类型检查 / lint / 测试命令、架构边界与编码约定，并同步更新"当前状态"一节。
