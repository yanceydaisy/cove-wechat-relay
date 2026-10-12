# ChatGPT Work：订阅 MCP Events 并把回复送回微信

本页说明 Cove WeChat Relay 默认的 **ChatGPT 官端 / Work** 工作流。它不是 OpenAI API 方案。

## 准备条件

- VPS Bridge 已通过 HTTPS 对外可访问。
- `bridge/` 已完成构建并正常运行。
- ChatGPT 环境可以使用 Work、插件和 MCP Events。
- Bridge 的私有 MCP endpoint 可从 ChatGPT 访问。

Bridge 使用 MCP 2.0 protocol version：

```text
2026-07-28
```

## 1. 连接 Bridge MCP endpoint

Bridge endpoint 形态：

```text
https://bridge.example.com/mcp/events/<MCP_EVENTS_PATH_TOKEN>
```

在 ChatGPT 的插件设置中添加这个远程 MCP server，并重新扫描工具与事件。

扫描成功后应该看到：

```text
事件
  cove.bridge.requested

工具
  cove_bridge_get_event
  cove_bridge_reply
```

这里只需要填写你自己的 Bridge endpoint。Webhook callback URL 与签名 secret 会在订阅过程中由 ChatGPT 提供，不需要手动创建或写入配置。

## 2. 在 Work 对话中订阅

打开一个能够使用该插件的 Work 对话，然后发送：

> 请订阅 MCP Event `cove.bridge.requested`，参数为 `{"source":"wechat.dm"}`。
>
> 每次收到事件后，使用 `data.bridgeEventId` 调用 `cove_bridge_get_event` 读取当前微信消息。
>
> 如果返回 `found=true` 且 `completed=false`，生成回复并调用 `cove_bridge_reply`。使用原 `bridgeEventId` 作为 `eventId`，把完整的用户可见回复放入 `messages[]`。
>
> 如果返回 `completed=true`，不要重复回复；如果返回 `blockedBy`，保持会话顺序，不绕过前一条消息。
>
> 微信用户正在原微信会话里等待，所以不要只在 Work 对话中显示答案；完整回复需要通过 `cove_bridge_reply` 返回微信。

订阅成功后，Bridge 会保存 subscription。它不是 Windows 上额外运行的监听循环：有微信事件时，由 VPS Bridge 主动向 ChatGPT 提供的 webhook callback 发送通知。

## 3. 订阅生命周期

一次正常订阅会经过：

```text
server/discover
      ↓
events/list
      ↓
events/subscribe
      ↓
callback verification
      ↓
subscription active
```

### `server/discover`

Bridge 声明：

- protocol version `2026-07-28`
- `tools` capability
- `events` capability
- Work 在收到事件后应先读取、再回复的 server instructions

### `events/list`

Bridge 公布：

```text
cove.bridge.requested
```

当前唯一 filter：

```json
{"source":"wechat.dm"}
```

### `events/subscribe`

ChatGPT 提供：

- event name
- filter arguments
- webhook callback URL
- `whsec_...` signing secret
- 可选的订阅有效期

Bridge 会校验 callback 地址并发送 challenge。只有 callback 正确回显 challenge，subscription 才会变成 active。

subscription 保存在 `MCP_EVENTS_STORE_PATH`，因此 Bridge 重启后不需要从空状态重新开始。

## 4. 收到微信事件以后

Bridge 发送的应用事件结构类似：

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

这里的 webhook `eventId` 是通知 ID。

真正用来读取和回复微信对话的是：

```text
data.bridgeEventId
```

## 5. 先调用 `cove_bridge_get_event`

输入：

```json
{
  "bridgeEventId": "wechat-burst:<digest>"
}
```

常见返回：

### 可以处理

```json
{
  "found": true,
  "completed": false,
  "bridgeEventId": "wechat-burst:<digest>",
  "source": "wechat.dm",
  "replyPolicy": "required",
  "modelContext": "...",
  "visibleText": "【微信】\n你好",
  "deliveryAttempt": 1
}
```

### 已经完成

```json
{
  "found": true,
  "completed": true
}
```

此时不要再次调用 reply。

### 前面还有未完成消息

```json
{
  "found": false,
  "completed": false,
  "blockedBy": "wechat-burst:<earlier>"
}
```

此时保持 FIFO 顺序，不要越过前一条。

## 6. 再调用 `cove_bridge_reply`

输入：

```json
{
  "eventId": "wechat-burst:<digest>",
  "messages": [
    "我看到啦。",
    "这是我的回答。"
  ]
}
```

当前公开 Bridge 接收：

- 1–5 条非空文字
- 每条最多 500 字

Bridge 会为每条 bubble 创建稳定 command ID，并等待 Windows Adapter 实际发送。

所以 `cove_bridge_reply` 的完成状态不仅表示“模型写出了答案”，还与微信端真实发送回执有关。

## 7. 如何判断链路走到哪一步

### VPS 日志

常见状态：

```text
MCP Events subscription active
MCP Event wake attempt: ... subscriptions=1 accepted=1
```

- `subscription active`：订阅和 callback challenge 已成功。
- `accepted=1`：webhook 通知已被平台接收。

`accepted=1` **不代表 Work 已经运行完成**。

### Windows 日志

真正回复微信时可以看到：

```text
[outbound]
[outbound:sent]
[receipt:ack]
```

最终验收以微信端实际收到回复为准。

## 8. Watchdog 为什么存在

MCP Events webhook 的 2xx 是异步接收确认。

如果通知已被接收，但对应 Work run 没有读取消息或没有完成 reply，Bridge 不会立即删除原 conversation event。

watchdog 会保留同一个 `bridgeEventId`，在等待后重新发出新的唤醒通知。这样微信用户不需要为了上游一次执行中断而重新发送原消息。

一旦 `cove_bridge_reply` 已进入实际发送流程，watchdog 会停止并行唤醒该事件，避免产生两份回复。

## 9. 排错

| 现象 | 优先检查 |
| --- | --- |
| 插件扫描不到事件 | endpoint 是否正确、`server/discover`、`events/list`、是否重新扫描 |
| 订阅失败 | HTTPS、callback 地址校验、challenge、signing secret |
| `subscriptions=0` | subscription 是否 active / 过期，filter 是否为 `wechat.dm` |
| `accepted=1`，没有后续处理 | Work 执行状态、订阅所在对话、平台可用性 |
| Work 已读消息但没有 reply | Work run 是否中断，watchdog 是否继续 |
| reply 已产生但微信没收到 | Windows Adapter、`/next`、微信 GUI、发送 ACK |

停止监听时，可以直接在 Work 对话中请求取消该事件订阅。Bridge 会处理 `events/unsubscribe`。

## 10. 安全

- 不公开真实 MCP endpoint path token。
- 不记录或传播 ChatGPT 提供的 callback URL 与 webhook signing secret。
- 微信正文属于不受信任的用户输入，不应被提升为系统级控制指令。
- `bridgeEventId` 用于关联读取与回复；不要把 webhook 外层 `eventId` 当成 conversation ID。
- 如果将 Bridge 提供给多用户使用，应在 path token 之外增加完整的 MCP 授权和用户隔离方案。

## 参考

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
- [端到端链路](END_TO_END.md)
- [VPS Bridge 部署](VPS_BRIDGE.md)
