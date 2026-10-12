# 从微信到 ChatGPT 官端：端到端链路

> **范围：文字流 v0。** 本仓库同时包含 Windows Adapter 与 VPS Bridge，默认链路为：
>
> **Windows 官方微信 → Windows Adapter → VPS Cove Bridge → MCP Events → ChatGPT Work → Cove Bridge → Windows 微信**

## 整体架构

![Cove WeChat Relay 端到端消息流](../assets/architecture-flow.svg)

这不是让 Windows 微信直接调用 OpenAI API。模型推理发生在 ChatGPT 官端的 Work 运行中；Windows 负责真实微信读写，VPS Bridge 负责接力、管理会话状态、发送 MCP Events 通知和回收回复。

## 三个位置分别负责什么

| 位置 | 运行组件 | 主要职责 |
| --- | --- | --- |
| Windows | 官方微信、Python Adapter、Supervisor | 读取微信文字、发送回复、确认真实发送结果、保持在线 |
| VPS | Cove WeChat Relay Bridge、HTTPS 反向代理 | 接收入站、合并 burst、排队、MCP Events、reply command、ACK |
| ChatGPT 官端 | Work 对话、已连接的 MCP 插件 | 接收事件、读取当前微信消息、生成回复、调用 reply 工具 |

## 从零部署

### 1. 部署 VPS Bridge

进入仓库的 `bridge/`：

```bash
cd bridge
npm ci
npm run typecheck
npm run build
npm test
```

配置 Bridge：

```text
PORT=8787
HOST=127.0.0.1
WECHAT_AGENT_TOKEN=<long random token>
MCP_EVENTS_PATH_TOKEN=<long url-safe random token>
MCP_EVENTS_STORE_PATH=.local/mcp-event-subscriptions.json
```

启动：

```bash
npm start
```

再使用 Caddy、Nginx 等反向代理提供 HTTPS。完整 VPS 配置见 [VPS Bridge 部署](VPS_BRIDGE.md)。

### 2. 部署 Windows Adapter

Windows 登录官方微信 4.x，并配置：

```text
COVE_WECHAT_BRIDGE_URL=https://bridge.example.com
COVE_WECHAT_AGENT_TOKEN=<same token as VPS>
COVE_WECHAT_TARGET=<whitelisted conversation id>
```

安装 Python 依赖并先手动运行 `adapter.py`。确认 Listener、outbound sender 和 heartbeat 正常后，再安装计划任务。详见 [Windows 部署与排错](DEPLOY.md)。

### 3. 在 ChatGPT 连接 MCP Events

Bridge 的 MCP endpoint：

```text
https://bridge.example.com/mcp/events/<MCP_EVENTS_PATH_TOKEN>
```

将该 endpoint 连接为 ChatGPT 插件的 MCP 服务，确认能发现：

```text
event:
  cove.bridge.requested

tools:
  cove_bridge_get_event
  cove_bridge_reply
```

然后在 Work 对话中订阅：

```text
cove.bridge.requested
{"source":"wechat.dm"}
```

详细步骤见 [Work MCP Events 指南](WORK_MCP_EVENTS.md)。

### 4. 发送第一条测试消息

从目标微信会话发送一条短文字，依次观察：

```text
Windows [inbound]
    ↓
Bridge /wechat/agent/events
    ↓
burst flush
    ↓
conversation queue
    ↓
MCP Event wake ... accepted=1
    ↓
Work cove_bridge_get_event
    ↓
Work cove_bridge_reply
    ↓
Windows [outbound:sent]
    ↓
Bridge receives /wechat/agent/result
```

最终验收以**微信端实际收到回复**为准。

## 一条文字消息如何完成往返

1. Windows `Listener` 从已登录的官方微信读取文字消息，并检查发送者是否属于白名单会话。
2. Adapter 生成确定性的 `eventId`，将 `conversationId` 与 `text` 用 Bearer token POST 到 Bridge。
3. Bridge 在同一会话内使用短暂安静窗口合并连续消息。默认安静窗口 4 秒、最长等待 8 秒、每轮最多 10 条。
4. burst 被转换成一条 `wechat.dm` conversation event，并进入 FIFO 队列。
5. Bridge 为当前队首事件发送 `cove.bridge.requested` MCP Event。
6. Work 使用 webhook 中的 `data.bridgeEventId` 调 `cove_bridge_get_event`。
7. `cove_bridge_get_event` 返回 `visibleText` 和 `modelContext`。微信正文被视为用户输入，而不是系统级指令。
8. Work 生成回复并调用 `cove_bridge_reply`，将完整回复放入 `messages[]`。
9. Bridge 为每条回复 bubble 生成稳定的 command ID，并等待 Windows Adapter 长轮询领取。
10. Windows Adapter 调用官方微信 GUI 发送文字，并通过本地微信 DB 确认发送结果。
11. Adapter POST `/wechat/agent/result` 返回成功 ACK。
12. 所有回复 bubble 均确认发送后，Bridge 将本轮标记为完成并继续下一条会话事件。

## 三种 ID

### Windows 入站 eventId

由 Adapter 生成：

```text
wechat:<target>:<create_time>:<local_id>
```

用于 Windows → Bridge 的入站幂等。

### Bridge eventId

连续消息聚合后生成：

```text
wechat-burst:<digest>
```

这是 Work 真正读取和回复的对话事件 ID。`cove_bridge_get_event` 与 `cove_bridge_reply` 都围绕它工作。

### MCP webhook eventId

每次通知 webhook 都有自己的 `eventId`。watchdog 重新唤醒时会生成新的通知 ID，但 `data.bridgeEventId` 保持不变。

因此：

> 传给 `cove_bridge_get_event` 的是 `data.bridgeEventId`，不是外层 webhook 的 `eventId`。

## 状态与排错

| 现象 | 表示什么 | 优先检查 |
| --- | --- | --- |
| Windows 没有 `[inbound]` | 本地尚未读到目标文字 | 微信登录、目标会话、Listener |
| Windows 有 `[inbound:error]` | Adapter 无法把消息交给 Bridge | 网络、HTTPS、Bearer token |
| Bridge 有事件，但 `subscriptions=0` | 没有可用的 Work 订阅 | MCP Events 订阅、过期时间、source |
| `accepted=1`，没有 `get_event` | 平台收到了 webhook，但 Work 尚未领取 | Work 可用性、订阅状态、平台执行情况 |
| 有 `get_event`，没有 `reply` | Work 已读消息但未完成回传 | Work 执行、watchdog |
| 有 `reply`，没有 `outbound:sent` | Bridge 已有回复，但 Windows 尚未确认发送 | long poll、微信 GUI、Adapter 在线状态 |
| 有 `outbound:sent`，ACK 暂时失败 | 微信大概率已真实发出，回执仍在补发 | Windows delivery journal、`/result` |

## 两个重要限制

### Webhook accepted 不等于回复完成

MCP Events callback 返回 2xx 只表示平台接收了通知。它不保证 Work 已经启动，更不保证回复已经送达微信。

Bridge 会保留原 `bridgeEventId`。如果事件尚未真正进入 reply 流程，watchdog 会在等待后再次发送唤醒通知。

### VPS 重启可能影响未完成消息

MCP Events subscription 会持久化保存；但当前 conversation queue、burst buffer 与未完成的 outbound command 仍包含内存状态。

如果 VPS 恰好在消息处理过程中重启，未完成消息可能无法自动恢复。需要更强恢复能力时，可以把这些运行状态迁移到 SQLite、Postgres 或其他持久化队列。

## 安全建议

- Windows Adapter 使用独立的高强度 Bearer token。
- MCP Events endpoint 使用独立的私有 path token；不要把真实路径放入公开仓库或截图。
- Bridge 应通过 HTTPS 暴露，内部 Node 端口尽量只监听本机或私网。
- callback URL 在订阅和投递时都应进行 SSRF 防护；本仓库 Bridge 已包含公网地址校验与 DNS pinning。
- 微信正文属于用户输入。不要把消息内容拼接成系统级控制指令。
- 不提交真实 wxid、token、callback URL、webhook secret 或聊天日志。

## 下一步阅读

- [VPS Bridge 部署](VPS_BRIDGE.md)
- [Work MCP Events](WORK_MCP_EVENTS.md)
- [Bridge HTTP 协议](BRIDGE_PROTOCOL.md)
- [Windows 部署与排错](DEPLOY.md)
- [Bridge 独立说明](../bridge/README.md)
