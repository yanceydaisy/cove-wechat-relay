# Bridge HTTP Protocol — Text Only

Windows Adapter 与 VPS Bridge 之间只使用四个 HTTP 接口。

所有请求都通过同一个 Bearer token 认证：

```http
Authorization: Bearer <WECHAT_AGENT_TOKEN>
```

公开 v0 只传文字，不定义图片、语音、文件或其他媒体字段。

## 1. 上报微信文字消息

```http
POST /wechat/agent/events
Content-Type: application/json
```

请求：

```json
{
  "eventId": "wechat:<conversation>:<create_time>:<local_id>",
  "conversationId": "wxid_example",
  "text": "你好"
}
```

字段：

| 字段 | 说明 |
| --- | --- |
| `eventId` | Windows Adapter 生成的稳定入站 ID |
| `conversationId` | 当前白名单微信会话 ID |
| `text` | 微信文字正文 |

Bridge 接收新事件时：

```json
{
  "ok": true,
  "created": true,
  "buffered": true,
  "eventId": "wechat:..."
}
```

如果相同 `eventId` 已经进入当前 Bridge 进程的 burst 去重窗口：

```json
{
  "ok": true,
  "created": false,
  "buffered": false,
  "eventId": "wechat:..."
}
```

Adapter 可以安全重试同一个 `eventId`。

## 2. 拉取待发送回复

Adapter 使用长轮询：

```http
GET /wechat/agent/next
```

没有待发送消息：

```json
{
  "command": null
}
```

有消息：

```json
{
  "command": {
    "id": "wechat-<digest>",
    "eventId": "wechat-burst:<digest>",
    "conversationId": "wxid_example",
    "index": 0,
    "text": "你好呀",
    "createdAt": "<ISO-8601>"
  }
}
```

`command.id` 根据 Bridge event、bubble index 和文字生成，重试时保持稳定。

Windows Adapter 会用这个 ID 做本地已发送去重。

## 3. 回报发送结果

```http
POST /wechat/agent/result
Content-Type: application/json
```

成功：

```json
{
  "commandId": "wechat-<digest>",
  "ok": true
}
```

失败：

```json
{
  "commandId": "wechat-<digest>",
  "ok": false,
  "error": "send_failed"
}
```

Bridge 对成功 ACK 做幂等处理。

Windows Adapter 会先把成功 command ID 写入本地 journal，再发送成功 ACK。因此 ACK 网络失败时，后续重复 command 不会再次发送微信，只会继续补回执。

## 4. Heartbeat

```http
POST /wechat/agent/heartbeat
Content-Type: application/json

{}
```

返回：

```json
{
  "ok": true,
  "status": {
    "online": true,
    "lastSeenAt": "<ISO-8601>",
    "pending": 0,
    "inflight": 0,
    "inbound": 0,
    "completedReceipts": 0
  }
}
```

Bridge 也会在 Adapter 长轮询和 result ACK 时更新在线时间。

## 5. 一次完整的出站确认

```text
ChatGPT Work
→ cove_bridge_reply
→ Bridge 创建稳定 command
→ Adapter GET /wechat/agent/next
→ Adapter 调官方微信 GUI
→ Windows 本地 DB 确认真实发送
→ Adapter journal 记录 command ID
→ POST /wechat/agent/result
→ Bridge 完成 bubble
```

只有微信侧真实发送得到确认后，Bridge 才把对应 bubble 当作已交付。

## 6. 超时与重试

### 入站

Windows Adapter 对 `POST /wechat/agent/events` 做有限次数网络重试，并保持同一个 `eventId`。

### 出站 command

Bridge 在等待发送 ACK 时，会重新把同一个稳定 command 放回待领取队列。

### 成功 ACK

如果微信已经发出而成功 ACK 暂时到不了 Bridge，Windows Adapter 会从本地 journal 重试 ACK。

## 7. 当前持久化边界

Windows Adapter 的已发送 command journal 是持久化的。

VPS Bridge 的 MCP Events subscription 也是持久化的。

但 Bridge conversation queue、burst buffer 和 pending / inflight command 当前仍在内存中。VPS 在消息处理中重启时，这些未完成状态可能无法自动恢复。
