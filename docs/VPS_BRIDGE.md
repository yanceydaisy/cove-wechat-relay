# VPS 与 Cove Bridge：部署结构和实现检查单

> **重要**：本文件描述我们的真实部署架构以及独立 Bridge 必须实现的功能；**当前公开工作区还没有可直接克隆部署的最小 Bridge 服务代码**。下面是环境与运行模板，不能代替 Bridge 实现。

## 目标结构

```text
Windows WeChat Adapter
       │ HTTPS + Agent Bearer token
       ▼
VPS public domain / TLS reverse proxy
       ▼
Cove Bridge (Node.js 22)
       ├─ POST /wechat/agent/events
       ├─ GET  /wechat/agent/next
       ├─ POST /wechat/agent/result
       ├─ POST /wechat/agent/heartbeat
       │
       ├─ conversation queue
       ├─ WeChat burst + routing
       ├─ webhook wake / retry watchdog
       │
       └─ MCP Events 2.0 endpoint (private, authenticated)
           ├─ server/discover
           ├─ events/list
           ├─ events/subscribe
           ├─ events/unsubscribe
           ├─ tools/list
           └─ tools/call
               ├─ cove_bridge_get_event
               └─ cove_bridge_reply
```

我们的实际生产环境是 Linux VPS + Node.js 22 + systemd + 反向代理。开发源码是 TypeScript，先编译再用 Node 启动。当前源工程还包含 Cove Home、音乐、其他 MCP 模块，**它们都不属于微信文字开源最小链路**。

## 1. VPS 基础环境

建议：

- Ubuntu 24.04 LTS 或其他受支持的 Linux
- Node.js 22
- 域名指向 VPS
- HTTPS/TLS 终止与反向代理（可用 Caddy / Nginx）
- 只开放必要的 22/80/443 端口；不直接把内部 Node 端口裸露公网
- 单独的服务账户、严格的 secret 文件权限、日志与自动重启机制

Node 版本确认：

```bash
node --version
npm --version
```

## 2. 反向代理示意

用 Caddy 时，可考虑以下**示意配置**（请按你的真实域名、已有服务和安全策略调整）：

```caddyfile
bridge.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

仅用于说明拓扑。**不要在没有鉴权与安全检查时把内部管理接口、调试接口或 MCP 入口全部公开。**

## 3. Bridge 需要的配置

以下仅是示意名称，实际代码所使用的环境变量和密钥读取方式应与 Bridge 实现一致：

```text
PORT=8787
WECHAT_AGENT_TOKEN_PATH=/etc/cove-relay/wechat-agent.token
EVENTS_TEST_TOKEN_PATH=/etc/cove-relay/mcp-events.token
EVENTS_TEST_STORE_PATH=/var/lib/cove-relay/mcp-event-subscriptions.json
```

实际 Cove Bridge 的 MCP Events 路径按私有 token 派生：

```text
https://bridge.example.com/mcp/events-test/<secret-path-token>
```

这是连接 ChatGPT 的 MCP endpoint，**不是微信 Agent token，也不是 webhook callback URL**。生产使用时应额外考虑成熟的身份校验方案、密钥轮换和网络暴露范围；不要在 README、截图、日志中公开实际路径。

## 4. 本地编译与 systemd

如果你已拥有 **Bridge 代码**，实际工程使用：

```bash
npm ci
npm run typecheck
npm run build
npm start
```

以下仅是 systemd 单元**模板**（假设实际启动命令就是 `node dist/src/server.js`，根据部署目录和服务用户调整）：

```ini
[Unit]
Description=Cove WeChat Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cove-relay
WorkingDirectory=/opt/cove-relay
EnvironmentFile=/etc/cove-relay/bridge.env
ExecStart=/usr/bin/node /opt/cove-relay/dist/src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

以上模板不是当前生产 systemd unit 的逐字复制。生产环境可能通过包装脚本设置路径、环境变量和 Unix socket；不要照抄后假定无需修改。

可用这些命令确认服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cove-relay
systemctl status cove-relay
journalctl -u cove-relay -n 100 --no-pager
```

**重要**：在真实 VPS 上对已有服务执行 restart 前，先检查 pending / reserved conversation 和未完成微信命令。当前 Bridge 队列的部分状态在内存里，贸然重启可能丢失未完成消息。

## 5. Bridge 实现所需的四段逻辑

### 微信入站 HTTP

实现 [文字版协议](BRIDGE_PROTOCOL.md) 的四个 HTTP endpoints。对 `/events` 做 token 校验、参数校验、按 `eventId` 幂等，并产生 `wechat.dm` 对话事件。

我们的运行版把短时间内的连续微信文字合并为一轮：安静窗口约 4 秒、最多等待 8 秒、每轮最多 10 条。聚合归 Bridge 管，Adapter 不负责。

### MCP Events 订阅

MCP 2.0 endpoint 至少支持：

```text
server/discover
events/list
events/subscribe
events/unsubscribe
tools/list
tools/call
```

协议版本是 `2026-07-28`。

`events/list` 公布：

```json
{
  "name": "cove.bridge.requested",
  "inputSchema": {
    "type": "object",
    "properties": {
      "source": { "type": "string", "enum": ["wechat.dm"] }
    },
    "required": ["source"]
  }
}
```

上面是核心字段示意，不是完整 `events/list` 响应，真实实现还需符合 MCP Events schema。

当 ChatGPT 执行 `events/subscribe` 时，Bridge 需存储订阅参数、回调 URL、签名密钥与过期时间，并按规范校验并完成 callback challenge。不要自己预先编造 OpenAI callback URL。

### 唤醒与读取

为符合 `source=wechat.dm` 的订阅发送签名 webhook，示意：

```json
{
  "eventId": "evt_bridge_<digest>_r0",
  "name": "cove.bridge.requested",
  "timestamp": "<ISO-8601>",
  "data": {
    "bridgeEventId": "wechat-burst:<digest>",
    "source": "wechat.dm",
    "stream": "conversation",
    "replyPolicy": "required",
    "createdAt": "<ISO-8601>"
  },
  "cursor": null
}
```

Bridge 要对用户消息保持单会话顺序。收到 Work 的 `cove_bridge_get_event` 时，按 `data.bridgeEventId` 找到原事件，返回 `visibleText`、`modelContext` 等内容。已完成返回 `completed=true`，排队受阻返回 `blockedBy`。

`accepted=1` **只代表 webhook 平台接收**。我们在 VPS 上用独立 watchdog 周期检查状态；未完成可重试唤醒。重新唤醒时外层 webhook ID 可以更新，但底层 `bridgeEventId` 保持稳定。

### 回复与真实发送回执

Work 调 `cove_bridge_reply`，Bridge 校验原事件、按 `messages[]` 构造文字 command，等待 Windows Adapter 通过 `GET /next` 拉取并在官方微信真正发出。

只有在 `POST /result` 收到成功 ACK 后才把本轮回复视为已交付。发送失败不应被误判成已经完成，重试必须保持稳定 command ID。

## 6. 订阅持久化 ≠ 会话持久化

我们的真实实现将 MCP Events subscriptions 写入私有 JSON 文件，并对 secret 做访问限制；**但当前会话待办 queue、outbound pending / inflight 仍存在内存部分**。

生产可靠性最关键的待办是把待回复对话、command 及 ACK 状态落到持久化存储，恢复进程后能继续执行，而不是只靠重试 webhook。

## 7. 何时才能称为“可自建部署”

需要至少提供并验证：

1. 可独立运行的文字版 Bridge 源码（不依赖 Home / Together / XHS 等私人模块）。
2. `package.json`、锁文件、环境变量模板，以及启动文档。
3. 完整 MCP Events 订阅、webhook 校验 / 签名、`get_event` / `reply` 实现。
4. HTTPS 部署方式与无秘密的配置例子。
5. 从 Windows 文字上报到 Work，再到微信回复的端到端验收。

在这五项完成前，这个仓库应描述为 **“Windows Relay + 端到端集成说明”**，而不是“克隆即可跑通 ChatGPT 微信”。
