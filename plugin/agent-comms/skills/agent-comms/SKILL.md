---
name: agent-comms
description: 主代理派发 worker 子代理并需要实时收流/监督时使用：如何生成 comms 频道、派发 prompt 必须写哪两行、如何用 wait_worker_event 形成"等待-处理"循环、超时沉默怎么处置。当需要并行多个 worker、长任务进度监督、或用户要求实时汇报时触发。
---

# agent-comms 协调者协议

## 派发

用 Agent 工具派发，`subagent_type` 填 `agent-comms:worker`（用全名）。每个派发 prompt 的开头必须包含两行：

```
comms 频道 <channel>
worker 名 <worker-N>
```

- `<channel>`：本批任务的频道标识，只含字母数字 `._-`，≤64 字符（建议用任务 slug 或会话相关标识），同批 worker 共用一个频道。
- `<worker-N>`：每个 worker 唯一的名字（如 worker-1、worker-2），用于你在事件里识别谁在说话。

## 等待循环

派发后尽快调用 `mcp__plugin_agent-comms_comms__wait_worker_event({channel, timeout_ms})`：

- 单次最长阻塞 240000ms；**没等齐就再次调用**，形成"等待→处理→再等待"循环。
- 返回 `status="events"`：逐条处理 `events`——`kind="done"` 表示该 worker 完成；`kind="blocked"` 需要你决策（留言纠偏可对其 SendMessage steer）。
- 返回 `status="timeout"`：沉默检测命中。对照 `workers_in_channel` 判断谁没动静，可 SendMessage 质询、检查其是否已结束；不要无限干等。
- 已消费的事件不会重复返回；需要回看历史用 `read_events({channel})`。

## 双通道分工（协议已烧进 worker 类型，你只需记住路由）

- 例行进度/里程碑/完成 → worker 调 report 落盘，你通过 wait 聚合收取（可审计、可补读）。
- 紧急事项（验收标准要变/无效功/不可逆/外部阻塞超期）→ worker 直接 RespondToCoordinator 送达你：你活跃时在工具边界送达，你空闲时直接唤醒新回合。你无需为此做任何配置。
