# Windows Adapter 部署与排错

本页只讲 Windows 微信侧。完整链路见 [端到端链路](END_TO_END.md)。

## 推荐结构

```text
Windows PC
├─ 官方微信 4.x
└─ Cove WeChat Adapter
       │ HTTPS
       ▼
VPS Cove Bridge
       │ MCP Events
       ▼
ChatGPT Work
```

## 1. 准备环境

需要 Windows 10 / 11、已登录的官方微信桌面版 4.x、Python 3.12+ 和 Git。

```powershell
git clone https://github.com/yanceydaisy/cove-wechat-relay.git
cd cove-wechat-relay
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## 2. 配置

设置三个 Windows 用户环境变量：

```text
COVE_WECHAT_BRIDGE_URL=https://bridge.example.com
COVE_WECHAT_AGENT_TOKEN=<same token as VPS>
COVE_WECHAT_TARGET=<target conversation id>
```

- `COVE_WECHAT_BRIDGE_URL`：VPS Bridge 的 HTTPS 根地址
- `COVE_WECHAT_AGENT_TOKEN`：Windows Adapter 专用 Bearer token
- `COVE_WECHAT_TARGET`：允许监听与回复的单个微信会话 ID

不要把真实凭据或会话 ID 写进仓库。

## 3. 手动启动

先确保微信已经登录：

```powershell
.\.venv\Scripts\python.exe .\adapter.py
```

正常启动会看到 Listener、outbound sender 和 heartbeat 状态。

## 4. 设置登录后自动启动

手动运行确认正常后：

```powershell
.\install-autostart.ps1
```

计划任务名为 `Cove WeChat Adapter`。Supervisor 会等待 `Weixin.exe`、拉起 Adapter、异常退出后重启，并写入滚动日志。

## 5. 日志

Supervisor 日志：

```text
logs/supervisor.log
```

Adapter 常见关键字：

```text
[listener] active
[inbound]
[inbound:error]
[outbound]
[outbound:sent]
[outbound:dedupe]
[receipt:ack]
[receipt:deferred]
[heartbeat]
```

## 6. 微信发了文字，但 Bridge 没收到

按顺序检查微信登录、Listener、目标会话 ID、Bridge HTTPS 与 Bearer token。

如果已经出现：

```text
[inbound] ... created=True
```

说明 Windows Adapter 已把消息交给 Bridge。后续没有 Work 回复时，应继续查看 VPS Bridge 与 MCP Events，而不是反复重启 Windows Adapter。

## 7. Bridge 收到了，但 ChatGPT Work 没回复

优先检查：

1. VPS `/health` 中 conversation queue 是否有 pending。
2. MCP Events subscription 是否 active。
3. VPS 日志中的 `subscriptions` 与 `accepted`。
4. Work 是否调用 `cove_bridge_get_event`。
5. Work 是否调用 `cove_bridge_reply`。

详见 [Work MCP Events](WORK_MCP_EVENTS.md)。


## 8. Work 已回复，但微信没收到

检查：

```text
cove_bridge_reply
    ↓
Bridge 生成 command
    ↓
Adapter 从 /wechat/agent/next 领取
    ↓
[outbound:sent]
    ↓
[receipt:ack]
```

如果没有 `[outbound]`，优先检查 Bridge command 队列和 Windows 到 VPS 的连接。

如果出现 `[outbound]` 但发送失败，检查微信是否仍登录、微信 GUI 是否可操作，以及 Adapter 日志中的错误。

## 9. 为什么成功发送后还需要 ACK

Adapter 只有在微信发送成功并通过本地 DB 确认后，才会把 command ID 写入：

```text
.local/delivered_commands.json
```

随后向 Bridge POST `/wechat/agent/result`。

如果微信已经发出，但网络在 ACK 阶段中断：

- command ID 已经落盘
- Adapter 不会重复发送同一条微信
- receipt worker 会继续补 ACK

这用于避免“消息已经发出，但因为回执丢失又发送第二遍”。

## 10. 看到多个 pythonw.exe

使用 venv 时，一个 Python 程序在 Windows 进程树里可能表现为启动器 + 实际解释器两层。

正常结构类似：

```text
Scheduled Task
└─ supervisor launcher
   └─ supervisor Python
      └─ adapter launcher
         └─ adapter Python
```

所以看到多层 `pythonw.exe` 不等于运行了多套 Adapter。判断重复实例时，应同时看父子进程树、Scheduled Task、named mutex 和日志。

## 11. 长轮询偶尔报网络错误

Adapter 会持续长轮询：

```text
GET /wechat/agent/next
```

网络、代理或反向代理连接复位可能产生临时错误。Adapter 会等待后继续拉取。

单次连接错误本身不代表消息已经丢失。判断是否真正影响回复，应结合 Bridge queue、command 状态和后续 `[outbound:sent]`。

## 12. 文字版范围

公开 v0 只处理微信文本类型。

以下消息会被忽略：

- 图片
- 动画表情
- 语音
- 文件
- 视频
- 拍一拍
- 朋友圈

需要更多微信自动化能力时，可以参考上游 `wechatauto-replica` 自行扩展。

## 13. 安全建议

- 只允许单个白名单会话。
- Windows Bearer token 使用高强度随机值。
- Bridge 只通过 HTTPS 访问。
- 不提交真实凭据、会话 ID 或聊天日志。
- 不把非文字消息“降级猜测”为文字内容。
