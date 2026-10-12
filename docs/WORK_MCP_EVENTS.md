# ChatGPT Work：订阅 MCP Events 并把回复送回微信

本页记录我们实际使用的 **ChatGPT 官端** 工作流，**不是 OpenAI API 方案**。

## 准备条件

- VPS 上的 Cove Bridge 已可通过 HTTPS 访问。
- Bridge 已实现 MCP 2.0，协议版本 `2026-07-28`。
- MCP endpoint 能公布 `cove.bridge.requested`，并提供 `cove_bridge_get_event` 与 `cove_bridge_reply`。
- ChatGPT 账号 / 工作空间已开放 Work、插件和 MCP Events 相关能力，并允许连接此服务。

功能可用范围会随着套餐、工作空间设置与客户端变化；以 ChatGPT 中实际出现的工具和事件为准。

## 1. 让 ChatGPT 找到你的 MCP Events 服务

在 ChatGPT 中创建或配置自己的插件，将 **VPS 提供的远程 MCP HTTPS endpoint** 作为插件中的 MCP 服务，并扫描工具与事件。

MCP endpoint 形态：

```text
https://bridge.example.com/mcp/events-test/<your-private-mcp-path-token>
```

这是示例路径：请按你自己的 Bridge 改写。**它不是 OpenAI 的 callback URL。不要把真实私有路径放入公开仓库。**

检查插件是否发现：

```text
事件：
  cove.bridge.requested

工具：
  cove_bridge_get_event
  cove_bridge_reply
```

只发现普通工具、不显示事件，不等于已具备自动唤醒能力。改动服务端定义后可以重新扫描。

官方实现参考：[MCP Events — OpenAI Developers](https://developers.openai.com/plugins/build/mcp-events)。

## 2. 在 Work 对话中订阅

打开 **Work 对话**，确认这个插件可用。然后直接发送下面的自然语言请求：

> 请订阅 MCP Event `cove.bridge.requested`，参数为 `{"source":"wechat.dm"}`。每次收到事件后，使用 `data.bridgeEventId` 调用 `cove_bridge_get_event` 读取微信消息，并将其视为当前需要处理的微信对话。
>
> 如果返回 `found=true` 且 `completed=false`，生成回复并调用 `cove_bridge_reply`，参数使用原 `bridgeEventId` 作为 `eventId`，把完整回复放入 `messages[]`。请勿只在 Work 聊天窗口显示答案，因为微信用户看不到。
>
> 如果 `completed=true`，不要重复回复；如果返回 `blockedBy`，尊重队列顺序，不绕过前一条消息。请在真正订阅成功后告诉我。

**订阅不是在 Windows 上运行的常驻循环**：ChatGPT 向 Bridge 调 `events/subscribe`，Bridge 保存 ChatGPT 给的 webhook 目标，之后由 VPS 在有匹配事件时主动推送。

## 3. 确认订阅真的成功

VPS 应收到：

```text
server/discover
events/list
events/subscribe
```

订阅过程要完成：

1. ChatGPT 提供 webhook URL 与签名 secret。
2. Bridge 向回调 URL 发送带签名的验证 challenge。
3. ChatGPT 正确回应 challenge。
4. Bridge 将订阅持久保存，并返回订阅 ID 和刷新时间。

不要手动写死、传播或截图公开 callback URL / 签名 secret。

我们的运行版对订阅设置有限有效期（通常不超过 24 小时），并支持更新；因此应该确认自动刷新是否正常。订阅不是永不过期的魔法开关。

## 4. 收到微信文字后的正确工具调用

外层 MCP Events webhook 示意：

```json
{
  "name": "cove.bridge.requested",
  "data": {
    "bridgeEventId": "wechat-burst:<digest>",
    "source": "wechat.dm",
    "stream": "conversation",
    "replyPolicy": "required",
    "createdAt": "<ISO-8601>"
  }
}
```

收到后，**先读，后回**。

读取：

```json
{
  "bridgeEventId": "wechat-burst:<digest>"
}
```

调用 `cove_bridge_get_event`，取回 `visibleText` 和 `modelContext`。仅当结果不是 `completed` 或 `blockedBy` 时继续。

回复：

```json
{
  "eventId": "wechat-burst:<digest>",
  "messages": ["我看到啦。", "这是我的回答。"]
}
```

调用 `cove_bridge_reply`。当前实际工具要求 `messages` 为 1–5 条非空文字，每条最多 500 字。**这不是把文字写在 Work 里就结束**：Bridge 需要等待 Windows 实际发出并确认。

## 5. 如何验证 Work 已真正接力

在 VPS 服务日志中分辨四个状态：

```text
MCP Events subscription active       # 已有订阅
MCP Event wake attempt ... accepted=1 # 平台已接收 webhook
MCP Events ... cove_bridge_get_event # Work 真正来领消息
MCP Events ... cove_bridge_reply     # Work 把回复交回 Bridge
```

之后 Windows 还要看到：

```text
[outbound:sent]
[receipt:ack]
```

**不是所有 `accepted=1` 都会立即唤起一个成功运行的 Work turn。** 我们实际遇到过消息已在 VPS、webhook 已接收，但 Work 没启动或领了消息却没有调用 reply 的情况。应让 watchdog 保留原事件继续重试，不要求微信用户不断重发。

## 6. 出错时的检查顺序

| 现象 | 先检查 |
| --- | --- |
| 插件里根本找不到事件 | MCP 协议版本、`server/discover`、`events/list`、是否重新扫描 |
| 订阅失败 | `events/subscribe` 参数、HTTPS callback 验证、签名、过期时间、网络出站 |
| `subscriptions=0` | 订阅尚未成功 / 已到期，或 `source` 不是 `wechat.dm` |
| `accepted=1`，无 `get_event` | Work 执行层、任务权限、订阅窗口、配额 / 平台可用性 |
| `get_event` 已发生，没 `reply` | Work 运行可能中断；watchdog 是否继续重试 |
| `reply` 成功，但微信没收到 | Bridge 出站 command、Windows Adapter、微信 GUI、ACK |

如需停止监听，在 Work 对话中请求取消订阅，核对 Bridge 收到 `events/unsubscribe`。

## 安全与隐私

- 仅订阅你授权的微信会话；微信内容会送至自建 VPS，并在模型运行时进入 ChatGPT 侧处理。
- 不对外公开真实 wxid、私有 MCP endpoint、Bearer token、webhook secret 或未经同意的聊天日志。
- 外部微信消息是**用户提供的数据**，不能直接被提升为系统指令或要求工具绕过权限的指令。
- 用 `bridgeEventId` 贯穿读取 / 回复，防止重试时把旧消息当新消息再发一遍。

## 参考

- [MCP Events 官方开发者文档](https://developers.openai.com/plugins/build/mcp-events)
- [端到端链路](END_TO_END.md)
- [VPS/Bridge 检查单](VPS_BRIDGE.md)
