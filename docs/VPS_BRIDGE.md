# VPS Bridge 部署

本仓库的 `bridge/` 是可独立运行的文字版 Cove Bridge。它负责连接 Windows Adapter 与 ChatGPT Work：

```text
Windows Adapter
      │ HTTPS + Bearer token
      ▼
VPS Cove Bridge
      ├─ /wechat/agent/events
      ├─ /wechat/agent/next
      ├─ /wechat/agent/result
      ├─ /wechat/agent/heartbeat
      │
      ├─ burst buffer
      ├─ conversation queue
      ├─ MCP Events subscription store
      ├─ webhook wake / watchdog
      │
      └─ /mcp/events/<private-token>
          ├─ server/discover
          ├─ events/list
          ├─ events/subscribe
          ├─ events/unsubscribe
          ├─ tools/list
          └─ tools/call
              ├─ cove_bridge_get_event
              └─ cove_bridge_reply
```

## 1. 环境

推荐：

- Ubuntu 24.04 LTS 或其他仍受支持的 Linux
- Node.js 22
- 域名指向 VPS
- Caddy / Nginx 提供 HTTPS
- systemd 管理 Bridge 进程

确认 Node：

```bash
node --version
npm --version
```

## 2. 安装

```bash
git clone https://github.com/yanceydaisy/cove-wechat-relay.git
cd cove-wechat-relay/bridge

npm ci
npm run typecheck
npm run build
npm test
```

如果四项都通过，说明当前源码、类型与核心队列测试可以正常工作。

## 3. 配置

可以使用 systemd `EnvironmentFile`、容器环境变量或其他 secret 管理方式提供以下配置：

```text
PORT=8787
HOST=127.0.0.1
WECHAT_AGENT_TOKEN=<long-random-token>
MCP_EVENTS_PATH_TOKEN=<long-url-safe-random-token>
MCP_EVENTS_STORE_PATH=/var/lib/cove-wechat-relay/mcp-event-subscriptions.json
```

### `WECHAT_AGENT_TOKEN`

Windows Adapter 访问四个 `/wechat/agent/*` HTTP 接口时使用的 Bearer token。

Windows 侧的：

```text
COVE_WECHAT_AGENT_TOKEN
```

必须与它一致。

### `MCP_EVENTS_PATH_TOKEN`

组成 ChatGPT 插件连接的私有 MCP endpoint：

```text
https://bridge.example.com/mcp/events/<MCP_EVENTS_PATH_TOKEN>
```

它与 Windows Agent token 是两套独立凭据。

### `MCP_EVENTS_STORE_PATH`

MCP Events subscription 的持久化文件。建议放在服务用户可写、不会随发布目录清空的位置，并限制文件权限。

## 4. 本地启动

```bash
npm start
```

默认监听：

```text
127.0.0.1:8787
```

健康检查：

```bash
curl http://127.0.0.1:8787/health
```

返回内容包含：

- conversation queue 状态
- Windows Adapter 在线状态
- burst buffer 状态
- wake watchdog 状态

健康检查不返回 token、callback URL 或聊天正文。

## 5. HTTPS 反向代理

以 Caddy 为例：

```caddyfile
bridge.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Bridge 默认绑定 `127.0.0.1`，因此公网只需要暴露反向代理的 443 端口。

如果你的部署环境需要容器或跨主机访问，可以修改 `HOST`，同时配合防火墙限制来源。

## 6. systemd

示例：

```ini
[Unit]
Description=Cove WeChat Relay Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cove-relay
Group=cove-relay
WorkingDirectory=/opt/cove-wechat-relay/bridge
EnvironmentFile=/etc/cove-wechat-relay/bridge.env
ExecStart=/usr/bin/node /opt/cove-wechat-relay/bridge/dist/src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

安装并启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cove-wechat-relay
systemctl status cove-wechat-relay
journalctl -u cove-wechat-relay -n 100 --no-pager
```

更新代码时建议先查看 `/health`。当前 conversation queue 和未完成 command 仍含内存状态，因此有正在处理的消息时不要随意重启服务。

## 7. Windows HTTP 接口

Bridge 实现：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/wechat/agent/events` | Adapter 上报文字消息 |
| `GET` | `/wechat/agent/next` | Adapter 长轮询待发送回复 |
| `POST` | `/wechat/agent/result` | Adapter 回报发送结果 |
| `POST` | `/wechat/agent/heartbeat` | Adapter 在线心跳 |

全部要求：

```http
Authorization: Bearer <WECHAT_AGENT_TOKEN>
```

字段详见 [Bridge Protocol](BRIDGE_PROTOCOL.md)。

## 8. Burst 与 conversation queue

同一微信会话的连续短消息会先进入 burst buffer：

- 安静窗口：4 秒
- 最长等待：8 秒
- 单轮最多：10 条

聚合完成后生成：

```text
wechat-burst:<24 hex chars>
```

并按 FIFO 进入 conversation queue。

一条需要回复的事件未完成时，后面的事件不会越过它直接进入 Work。

## 9. MCP Events

Bridge 使用 MCP 2.0 protocol version：

```text
2026-07-28
```

公开事件：

```text
cove.bridge.requested
arguments: {"source":"wechat.dm"}
```

公开工具：

```text
cove_bridge_get_event
cove_bridge_reply
```

订阅过程由 ChatGPT 提供 webhook callback URL 和 `whsec_...` signing secret。Bridge 会：

1. 校验 event name 与 arguments。
2. 校验 callback URL 必须为允许的 HTTPS 公网地址。
3. 发送签名 challenge。
4. 只有 challenge 正确回显后才激活订阅。
5. 将 subscription 写入 `MCP_EVENTS_STORE_PATH`。
6. 对 webhook 使用 Standard Webhooks 兼容签名。

callback URL 与 signing secret 不需要人工预设。

## 10. Wake watchdog

Webhook 返回 2xx 只表示通知被平台接收。

Bridge 会跟踪当前 `bridgeEventId`：

- 第一次通知后约 40 秒可重试
- 之后退避到 60 秒、120 秒、再到 5 分钟
- Work 已调用 `get_event` 后给予生成回复的宽限时间
- 一旦 `cove_bridge_reply` 进入发送流程，不再并行唤醒同一事件

watchdog 的重新唤醒会使用新的通知 event ID，但底层 `bridgeEventId` 不变，因此回复幂等仍围绕同一条 conversation event。

## 11. Reply command 与 ACK

`cove_bridge_reply` 接收 1–5 条文字 bubble。

Bridge 对每条 bubble 根据：

```text
bridgeEventId + index + text
```

生成稳定 command ID。

Windows Adapter 从 `/wechat/agent/next` 领取 command，发送到真实微信后调用 `/wechat/agent/result`。

Bridge 收到成功 ACK 后才认为对应 bubble 已送达。

## 12. 当前持久化范围

已经持久化：

- MCP Events subscriptions
- Windows Adapter 自己的已发送 command journal

Bridge 进程内存中仍保存：

- conversation queue
- burst buffer
- pending / inflight outbound commands

所以 VPS 重启可能影响正在处理中的消息。需要跨重启恢复时，可以把这些状态迁移到 SQLite、Postgres 或其他持久化队列。

## 13. 安全建议

- Bridge 放在 HTTPS 后面。
- Node 内部端口尽量只监听 `127.0.0.1`。
- Windows Bearer token 与 MCP endpoint token 分开生成。
- 不在仓库、日志或截图中公开真实凭据。
- 保留 callback SSRF 防护，不要为了调试关闭公网地址校验。
- 微信正文按不受信任的用户输入处理。
