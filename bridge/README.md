# Cove WeChat Relay Bridge

这是 Cove WeChat Relay 的 VPS 侧最小实现，只保留 **微信文字消息 → MCP Events → ChatGPT Work → 微信文字回复** 所需的功能。

## 包含什么

- 微信 Adapter 的四个 HTTP 接口：
  - `POST /wechat/agent/events`
  - `GET /wechat/agent/next`
  - `POST /wechat/agent/result`
  - `POST /wechat/agent/heartbeat`
- 同一会话的短消息 burst 合并
- FIFO conversation queue
- `cove.bridge.requested` MCP Event
- MCP Events subscription 持久化
- callback challenge、Standard Webhooks 风格签名与 callback URL 安全检查
- `cove_bridge_get_event`
- `cove_bridge_reply`
- Work wake watchdog
- 稳定 command ID、发送 ACK 与重复发送抑制

不包含图片、语音、文件、朋友圈或其他 Cove 私有模块。

## 环境

- Node.js 22
- Linux VPS
- 一个 HTTPS 域名或反向代理

## 安装

```bash
cd bridge
npm ci
npm run typecheck
npm run build
```

复制配置：

```bash
cp .env.example .env
```

至少配置：

```text
PORT=8787
HOST=127.0.0.1
WECHAT_AGENT_TOKEN=<a long random token>
MCP_EVENTS_PATH_TOKEN=<a long url-safe random token>
MCP_EVENTS_STORE_PATH=.local/mcp-event-subscriptions.json
```

然后把这些变量通过 systemd `EnvironmentFile`、容器环境变量或你自己的 secret 管理方式提供给进程。

启动：

```bash
npm start
```

健康检查：

```text
GET /health
```

## MCP Events endpoint

公开给 ChatGPT 插件连接的路径是：

```text
https://bridge.example.com/mcp/events/<MCP_EVENTS_PATH_TOKEN>
```

不要把真实 token 提交到 Git 或放进公开截图。

本实现使用 MCP 2.0 protocol version `2026-07-28`，支持：

```text
server/discover
events/list
events/subscribe
events/unsubscribe
tools/list
tools/call
```

事件：

```text
cove.bridge.requested
arguments: {"source":"wechat.dm"}
```

工具：

```text
cove_bridge_get_event
cove_bridge_reply
```

## 一次消息如何流动

```text
Windows Adapter
  → POST /wechat/agent/events
  → burst buffer
  → conversation queue
  → cove.bridge.requested webhook
  → ChatGPT Work
  → cove_bridge_get_event
  → cove_bridge_reply
  → outbound command
  → GET /wechat/agent/next
  → Windows 微信发送
  → POST /wechat/agent/result
  → completed
```

## Watchdog

Webhook 返回 2xx 只代表平台接收了通知，不代表 Work 已经开始或完成本轮处理。

因此 Bridge 会保留原 `bridgeEventId`，并在没有真正进入 reply 流程时继续尝试唤醒。每次 watchdog 重新唤醒会生成新的通知 event ID，而底层 conversation event ID 保持不变。

## 当前持久化范围

MCP Events subscription 会写入 `MCP_EVENTS_STORE_PATH`。

conversation queue、burst buffer 和尚未 ACK 的出站 command 当前仍保存在进程内存中。VPS 重启时，正在处理中的消息可能无法自动恢复。长期运行时可以把这些状态迁移到 SQLite、Postgres 或其他持久化队列。

## 验证

```bash
npm run typecheck
npm run build
npm test
```

更多端到端部署说明见仓库根目录的 `docs/END_TO_END.md` 和 `docs/WORK_MCP_EVENTS.md`。
