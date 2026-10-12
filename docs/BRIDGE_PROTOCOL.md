# Bridge Protocol — Text Only

这一版协议只传**文字**。

## 认证

所有请求：

```http
Authorization: Bearer <token>
```

建议给 Adapter 使用独立、最小权限 token。

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

建议返回：

```json
{
  "ok": true,
  "created": true,
  "eventId": "wechat:..."
}
```

同一个 `eventId` 必须幂等。

## 2. 拉取下一条待发送回复

Adapter 长轮询：

```http
GET /wechat/agent/next
```

没有待发送消息：

```json
{
  "command": null
}
```

有待发送消息：

```json
{
  "command": {
    "id": "wechat-command-...",
    "conversationId": "wxid_example",
    "text": "你好呀"
  }
}
```

`command.id` 必须稳定。

Bridge 因超时重复下发同一个 command ID 时，Adapter 会利用本地 journal 去重。

## 3. 回报发送结果

```http
POST /wechat/agent/result
Content-Type: application/json
```

成功：

```json
{
  "commandId": "wechat-command-...",
  "ok": true
}
```

失败：

```json
{
  "commandId": "wechat-command-...",
  "ok": false,
  "error": "send_failed"
}
```

建议 Bridge 对成功 ACK 做幂等处理。

## 4. Heartbeat

```http
POST /wechat/agent/heartbeat
Content-Type: application/json

{}
```

返回：

```json
{
  "ok": true
}
```

## 推荐的 Bridge 处理逻辑

```text
微信文字事件
→ Bridge 接收
→ 持久化 / 排队
→ Agent 领取
→ 生成文字回复
→ 创建 command
→ Adapter 领取
→ 微信真实发送成功
→ Adapter ACK
→ Bridge 标记 completed
```

不要把 webhook / wake “accepted” 当成最终完成。

## 生产建议

Bridge 最好额外实现：

- 持久化 pending queue
- eventId 幂等
- commandId 幂等
- FIFO / 单会话顺序
- Agent 超时重试
- reply backpressure
- watchdog
- 可观测日志

这一版协议不定义图片、语音、文件或其他媒体字段。
