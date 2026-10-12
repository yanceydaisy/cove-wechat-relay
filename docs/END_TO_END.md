# 从微信到 ChatGPT 官端：端到端链路

> **范围：文字流 v0。** 本教程依据真实运行的 **Windows 官方微信 → Windows Adapter → VPS Cove Bridge → MCP Events → ChatGPT Work → Cove Bridge → Windows 微信** 链路整理。
>
> **发布状态说明**：本仓库当前包含 Windows Adapter、HTTP 协议和部署说明；完整的 VPS Cove Bridge 是另一套服务，**其独立可部署的开源精简版尚未随本仓库发布**。因此仅克隆本仓库还不能一键复现全链路。文中的 VPS 部分是部署要求和接口契约，不应误当作已经附带的 Bridge 安装脚本。

## 总览：为什么需要这么长的链路

```text
                           ┌────────────── Windows 电脑 ──────────────┐
                           │                                         │
你在微信发送文字 ────────────→│ 官方微信 4.x                           │
                           │   ↓ WeChatDB + Listener                 │
                           │ Windows Adapter                         │
                           │   └─ POST /wechat/agent/events          │
                           └───────────────┬─────────────────────────┘
                                           │ HTTPS / Bearer token
                                           ▼
                           ┌────────────── VPS ─────────────────────┐
                           │ Cove Bridge                             │
                           │   ├─ 接收、去重、整理事件                │
                           │   ├─ 会话队列 / required reply          │
                           │   ├─ MCP Events 订阅管理                │
                           │   └─ webhook wake + watchdog            │
                           └───────────────┬─────────────────────────┘
                                           │ MCP Events webhook
                                           ▼
                           ┌────────── ChatGPT 官端 ─────────────────┐
                           │ Work 对话 / 已连接 MCP 插件             │
                           │   1. 收到 cove.bridge.requested         │
                           │   2. 调 cove_bridge_get_event           │
                           │   3. 生成回复                           │
                           │   4. 调 cove_bridge_reply               │
                           └───────────────┬─────────────────────────┘
                                           │ MCP tool call
                                           ▼
                           ┌────────────── VPS ─────────────────────┐
                           │ Bridge 将回复变成待发送 command          │
                           │ Adapter GET /wechat/agent/next         │
                           └───────────────┬─────────────────────────┘
                                           │ HTTPS
                                           ▼
                           ┌────────────── Windows ─────────────────┐
                           │ Adapter → 官方微信 GUI 发送文字          │
                           │ Adapter POST /wechat/agent/result      │
                           │ Bridge 记录成功 ACK                     │
                           └─────────────────────────────────────────┘
```

这不是让 Windows 微信直接调用 OpenAI API。**模型推理在 ChatGPT 官端的 Work 运行中进行**，VPS 只负责接力、保存状态、通知和回执。

## 三个位置，各负责什么

| 位置 | 必须运行的组件 | 负责什么 | 不负责什么 |
| --- | --- | --- | --- |
| Windows | 官方微信、Python Adapter、Supervisor | 收文字、发文字、确认发送、保持在线 | 不运行模型、不主动启动 Work |
| 你的 VPS | HTTPS 入口、Cove Bridge、MCP Events 服务 | 入站、排队、发唤醒 webhook、MCP tools、回复交付 | 不替 Work 执行模型推理 |
| ChatGPT 官端 | 可使用 Work + MCP Events 的对话、已连接插件 | 收事件、读取消息、生成文字、调用 reply 工具 | 不能替代 Windows 操作真实微信 |

## 按顺序部署

**第一步｜准备 VPS Bridge**

建议准备 Linux VPS、域名、HTTPS、Node.js 22，并部署具有 [Bridge 协议](BRIDGE_PROTOCOL.md) 的服务。具体检查项和 systemd / 反向代理示例见 [VPS 与 Bridge](VPS_BRIDGE.md)。

注意：单有 HTTP `/wechat/agent/*` 还不够，Bridge 还需要 MCP 2.0 Events 订阅、webhook 投递、`cove_bridge_get_event` / `cove_bridge_reply` 两个工具，以及回复路由和状态机。

**第二步｜准备 Windows Adapter**

Windows 登录官方微信 4.x，配置：

```text
COVE_WECHAT_BRIDGE_URL=https://bridge.example.com
COVE_WECHAT_AGENT_TOKEN=<your-agent-token>
COVE_WECHAT_TARGET=<your-whitelisted-conversation-id>
```

按 [README](../README.md) 完成安装，先手动运行，通过后再安装计划任务。

**第三步｜ChatGPT 官端连接 MCP Events**

将 Bridge 的私有 MCP Events HTTPS endpoint 连接为 ChatGPT 可用的插件，并在 Work 对话中订阅 `cove.bridge.requested`，过滤 `source=wechat.dm`。详细步骤与可复制指令见 [Work 订阅指南](WORK_MCP_EVENTS.md)。

**第四步｜从微信发送一条文字测试**

先发非常短的一句话，在 Windows / VPS / Work 三侧依次查：

```text
Windows [inbound]
    ↓
Bridge POST /wechat/agent/events 返回 ok
    ↓
Bridge 产生待回复事件
    ↓
MCP Event wake attempt: subscriptions=1 accepted=1
    ↓
Work cove_bridge_get_event
    ↓
Work cove_bridge_reply
    ↓
Windows [outbound:sent]
    ↓
Bridge 回复标记 completed
```

不要用“Work 对话里显示了回复”代替“微信真的收到了回复”作为最终验收。

## 文字消息的一次完整往返

1. Windows `Listener` 从已登录官方微信读取**文本**消息，并检查目标会话。
2. Adapter 为消息生成确定性 `eventId`，将 `conversationId` 和 `text` 用 Bearer token POST 给 Bridge。
3. Bridge 接收后按会话整理；我们的实际运行版会对同一会话 4 秒安静窗口内的消息合并成一轮（最长 8 秒，最多 10 条）。这属于 Bridge 逻辑，**不是本仓库 Adapter 的功能**。
4. Bridge 将该轮记录为需要回复的 `wechat.dm` conversation event，并为已订阅的 Work webhook 发送 `cove.bridge.requested`；唤醒载荷只带事件标识及少量元数据，不直接把完整文字当 webhook 正文。
5. Work 根据 `data.bridgeEventId` 调 `cove_bridge_get_event`，读取本轮 `visibleText` 和 `modelContext`。
6. 模型生成回复后，必须调 `cove_bridge_reply`，例如 `{"eventId":"<bridgeEventId>","messages":["收到啦","我来回答你"]}`。
7. Bridge 按每条 bubble 建立稳定 command ID；Windows Adapter 长轮询拿到 command 后通过官方微信 GUI 发文字、确认、ACK。
8. Bridge 全部收到发送结果，才将本轮回复视为已交付。

## 两类事件 ID，不能混用

- **微信入站 eventId**：Windows Adapter 生成，如 `wechat:<target>:<create_time>:<local_id>`；用于上报去重。
- **Bridge eventId**：VPS 聚合的一轮对话，例如 `wechat-burst:<digest>`；用它让 `get_event` 找到消息，并在 `reply` 中回传。

MCP webhook 本身还有独立 `eventId`，用于 webhook 的幂等投递；**需要传给 `cove_bridge_get_event` 的是 `data.bridgeEventId`，不是外层 webhook eventId**。

## 状态与故障边界

| 已看到的日志 / 现象 | 意味着 | 下一步检查 |
| --- | --- | --- |
| Windows 没有 `[inbound]` | 还未确认本地监听到文字 | 登录状态、会话白名单、微信版本、Listener |
| Windows `[inbound:error]` | 入站 HTTP 重试后仍失败 | 网络 / token / Bridge HTTPS |
| Bridge 已收到入站但无 `subscriptions=1` | 订阅不存在、失效或 source 不匹配 | Work MCP Events 订阅 |
| `accepted=1`，但没有 `get_event` | webhook 被接收，**不代表** Work 一定启动了 | Work 可用性、权限、额度、订阅窗口 |
| 有 `get_event`，但没有 `reply` | Work 读过消息，但未完成回传 | Work 任务执行、重试与路由指令 |
| 已有 `reply`，但没有 `outbound:sent` | Bridge → Windows 下发 / 发送环节未完成 | command 队列、长轮询、微信 GUI |
| 已有 `outbound:sent`，但无 ACK | 可能已真实发出，仅回执待重试 | Adapter journal 和 `/result` |

### 两个特别重要的限制

**1. webhook accepted 只是平台接收成功。** MCP Events 回调 2xx 并不保证 Work run 已启动或已回复。Bridge 应保留同一个 `bridgeEventId`，为 watchdog 重试生成新的 webhook delivery ID。

**2. 不要把现有 Bridge 说成“全持久化零丢失”。** 我们目前真实运行的 conversation queue 和出站 command 状态有内存部分；生产 VPS 重启时，未完成事件有丢失风险。公开教程必须明确这点，推荐先实现持久化队列再对外承诺更强可靠性。

## 安全和发布边界

- 仓库不得提交真实 wxid、Bridge token、MCP endpoint 私有路径或订阅 callback URL / secret。
- Windows Adapter 用独立 Bearer token；MCP endpoint 要做访问控制。仅靠长随机秘密路径不是通用鉴权方案。
- 从生产 VPS 提取开源 Bridge 时，只提取微信文本 + MCP Events 所需模块，不能把我们私人的其他模块、账户信息、数据文件和历史聊天一起打包。
- 这一版不传图片、语音、文件或其他媒体；本教程也不引入这些能力。

## 下一步阅读

- [VPS 与 Bridge](VPS_BRIDGE.md)
- [Work MCP Events 订阅](WORK_MCP_EVENTS.md)
- [文字版 Bridge HTTP 协议](BRIDGE_PROTOCOL.md)
- [Windows 部署与排错](DEPLOY.md)
