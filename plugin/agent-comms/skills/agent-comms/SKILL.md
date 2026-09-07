---
name: agent-comms
description: 主代理派发 worker 子代理并需要实时收流/监督时使用：如何生成 comms 频道、派发 prompt 必须写哪两行、如何用 wait_worker_event 形成"等待-处理"循环、超时沉默怎么处置。当需要并行多个 worker、长任务进度监督、或用户要求实时汇报时触发。Use when dispatching worker subagents that need real-time streaming/supervision: channel creation, the two required dispatch-prompt lines, the wait_worker_event loop, and silence handling. Triggers on parallel workers, long-task progress monitoring, or real-time progress reporting.
---

# agent-comms 协调者协议

## 开频道（每次任务批次第一步）

调用 `mcp__plugin_agent-comms_comms__open_channel`（可带 slug 前缀，如 `fix-login`），用**它返回的带随机后缀的频道名**写进派发 prompt。不要自己起频道名——随机后缀保证多个主会话并发时不会串台。

## 派发

用 Agent 工具派发，`subagent_type` 按任务性质二选一（用全名）：

- **`agent-comms:worker`**——执行型（全工具：改代码/跑管线/动文件/联网/浏览器；已硬排除频道消费与孙代理派生）。改东西的任务用它。
- **`agent-comms:scout`**——只读核查型（检索/读取/联网核实，不修改任何文件）。查证、勘察、交叉核验的任务用它。

每个派发 prompt 的开头必须包含两行：

```
comms 频道 <channel>
worker 名 <worker-N>
```

- `<worker-N>`：每个 worker 唯一的名字（如 worker-1、worker-2），用于你在事件里识别谁在说话。

## 等待循环

派发后尽快调用 `mcp__plugin_agent-comms_comms__wait_worker_event({channel, timeout_ms})`：

- 单次最长阻塞 240000ms；**没等齐就再次调用**，形成"等待→处理→再等待"循环。
- **并发建议**：一批 worker ≤3 个——过多并行代理徒增成本与噪声，也容易撞平台并发上限。
- **长批次的省 token 模式**：不需要紧盯进度时，可以不挂 wait——把 worker 全部后台派发后直接结束本回合，后台代理的完成通知与紧急消息会唤醒你。**代价要向用户说清：结束回合期间，worker 的例行里程碑报告不会唤醒你**（文件事件没有唤醒通道，这是内核设计边界），它们会留存在频道里，等你被完成通知/紧急消息/用户消息唤醒后用 wait 或 read_events 一次性补收；若用户想实时盯进度，保持 wait 循环不结束回合。
- 返回 `status="events"`：逐条处理 `events`——`kind="done"` 表示该 worker 完成；`kind="blocked"` 需要你决策（留言纠偏可对其 SendMessage steer）。
- 返回 `status="timeout"`：沉默检测命中，按下节处置。
- 已消费的事件不会重复返回；需要回看历史用 `read_events({channel})`。需要专等某个 worker 时传 `worker` 参数（其它 worker 事件不被消费）。

## 沉默处置（三级递进）

wait 超时返回的 `worker_last_event` 会列出每个 worker 的最后事件与 `age_ms`，按 `age_ms` 从大到小排查：

1. **对照预期**：该 worker 的任务本该多久出结果？尚未超期就继续 wait。
2. **心跳质询**：对其 SendMessage（一句话即可，如「报告当前进度与阻塞点」）；它会 steer 进该 worker 的活跃回合，worker 的回应会作为消息送达你。
3. **转录核实**（不信任自述时的 ground truth）：用子会话 id 查共库里它实际调过什么工具：

   ```bash
   python -c "import sqlite3;db=sqlite3.connect(r'C:\Users\<用户>\.zcode\cli\db\db.sqlite');[print(r) for r in db.execute('SELECT tool_name,status,started_at FROM tool_usage WHERE session_id=? ORDER BY started_at DESC LIMIT 10',(r'<子会话id>',))]"
   ```

   子会话 id 可查 session 表（`parent_id` = 主会话 id）；此表属 ZCode 内部结构，升级后字段可能变，失效就换用客户端可见信息判断。

## 双通道分工（协议已烧进 worker 类型，你只需记住路由）

- 例行进度/里程碑/完成 → worker 调 report 落盘，你通过 wait 聚合收取（可审计、可补读）。
- 紧急事项（验收标准要变/无效功/不可逆/外部阻塞超期）→ worker 直接 RespondToCoordinator 送达你：你活跃时在工具边界送达，你空闲时直接唤醒新回合。你无需为此做任何配置。
