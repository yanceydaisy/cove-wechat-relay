# Cove WeChat Relay

把 **Windows 官方微信 4.x** 的私聊文字消息接到 **ChatGPT 官端**，再把回复送回微信。

本项目按我们实际使用的链路设计：**Cove Bridge → MCP Events → ChatGPT 官端 / Work**。如果你要迁移到 API、第三方前端或其他 MCP Host，请根据自己的运行环境调整 Bridge、唤醒和协议适配。

这一版只做一件事：**文字聊天接力**。

不做图片、不做语音、不做文件、不做朋友圈、不做拍一拍。上游自动化项目本身已经有更丰富的能力；这个仓库只把最核心的“微信文字聊天 ↔ Agent”链路整理成一个小而清晰、方便复现的版本。

## 从零部署整条链路

这个项目不是单独运行一个 Windows 脚本就能让 ChatGPT 自动回微信的。完整链路分为 **Windows Adapter、VPS Cove Bridge、ChatGPT Work 的 MCP Events 订阅** 三段。

如果你想照着我们的官端路线从头搭起来，先读 **[端到端部署路线图](docs/END_TO_END.md)**，再分别按 [VPS 与 Bridge](docs/VPS_BRIDGE.md) 和 [Work MCP Events 订阅](docs/WORK_MCP_EVENTS.md) 配置。

> 当前仓库提供 Windows 文字 Relay、HTTP 协议与完整链路说明；独立的文字版 VPS Bridge 可部署源码仍待整理发布。仅 clone 本仓库还不能一键跑通 ChatGPT 端到端聊天。

## 数据流

```text
微信文字消息
   ↓
Windows 官方微信
   ↓
Cove WeChat Adapter
   ↓
Cove Bridge
   ↓
MCP Events → ChatGPT 官端 / Work
   ↓
模型生成文字回复
   ↓
Cove WeChat Adapter
   ↓
微信收到文字回复
```

## 当前能力

- 监听指定微信私聊的**文字消息**
- 把文字消息转发给你自己的 Bridge
- 从 Bridge 长轮询待发送回复
- 调用官方微信桌面端发送文字回复
- 发送后做本地确认
- 对已成功发送的 command 做持久化去重
- ACK 失败后自动补回执
- Windows 登录后自动启动
- Adapter 异常退出后由 Supervisor 自动拉起
- 单目标会话白名单
- 本地滚动日志

**非文字消息会被直接忽略。**

## 适合谁

适合希望把 **Windows 官方微信直接接进 ChatGPT 官端工作流** 的人。

本仓库公开的是 Windows 微信侧的 Relay；ChatGPT 的唤醒链路按 **MCP Events** 设计。你需要自己的 Cove Bridge（或自行实现同协议 Bridge）来接收微信文字消息、触发 ChatGPT 官端，并把回复 command 交回 Relay。

如果你使用 API Agent、第三方 ChatGPT 前端或其他 MCP Host，也可以基于本仓库自行适配；相关迁移、唤醒方式和兼容性调整请根据自己的环境处理。

如果你只想研究微信 4.x 的文字监听、发送确认、重试和去重，这个仓库也可以独立作为参考。

## 环境要求

- Windows 10 / 11
- 官方微信桌面版 4.x，且已登录
- Python 3.12+
- `wechatauto-replica`
- 一台 Windows 能访问到的 Bridge

当前依赖固定在经过验证的 upstream commit：

```text
wechatauto-replica @ git+https://github.com/fanyuantaier/wechatauto-replica.git@91dc0e1
```

## 快速开始

### 1. 克隆并安装

```powershell
git clone https://github.com/yanceydaisy/cove-wechat-relay.git
cd cove-wechat-relay

py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

### 2. 配置环境变量

设置三个 Windows **用户环境变量**：

```text
COVE_WECHAT_BRIDGE_URL=https://your-bridge.example.com
COVE_WECHAT_AGENT_TOKEN=replace-me
COVE_WECHAT_TARGET=wxid_replace_me
```

- `COVE_WECHAT_BRIDGE_URL`：你的 Bridge 地址
- `COVE_WECHAT_AGENT_TOKEN`：Bridge 为本 Adapter 分配的专用 token
- `COVE_WECHAT_TARGET`：允许监听和回复的单个微信会话 wxid

不要把真实 token 或 wxid 提交到 Git。

### 3. 手动运行

先登录官方微信，然后：

```powershell
.\.venv\Scripts\python.exe .\adapter.py
```

启动后会看到当前微信账号、目标会话、Listener、outbound sender 和 heartbeat 状态。

### 4. 登录后自动启动

```powershell
.\install-autostart.ps1
```

脚本会创建当前 Windows 用户的计划任务 `Cove WeChat Adapter`。

Supervisor 会：

- 等待 `Weixin.exe` 运行
- 启动 `adapter.py`
- Adapter 异常退出后自动重启
- 把日志写到 `logs/supervisor.log`
- 自动滚动日志

## Bridge 接口

Adapter 只依赖四个 HTTP 接口：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/wechat/agent/events` | 上报微信文字消息 |
| `GET` | `/wechat/agent/next` | 长轮询下一条待发送文字回复 |
| `POST` | `/wechat/agent/result` | 回报发送成功 / 失败 |
| `POST` | `/wechat/agent/heartbeat` | 心跳 |

所有接口均使用 Bearer token。

详细字段见 [docs/BRIDGE_PROTOCOL.md](docs/BRIDGE_PROTOCOL.md)。

## 可靠性说明

### 入站

当前 v0 对 Bridge ingress 做有限次数网络重试。

事件 ID 是确定性的：

```text
wechat:<target>:<create_time>:<local_id>
```

因此 Bridge 应对同一个 `eventId` 做幂等处理。

### 出站

成功发送到微信的 command ID 会持久化到：

```text
.local/delivered_commands.json
```

如果 Bridge 因 ACK 丢失重复下发同一个 command，Adapter 不会再次发微信，只会补 ACK。

### 单实例

- Adapter 有 named mutex
- Supervisor 有独立 named mutex
- Windows Scheduled Task 使用 `MultipleInstances IgnoreNew`

所以即使误触发多次启动，也不会正常跑出两套独立监听实例。

## 已验证范围

当前验证环境：

- Windows + 官方微信 4.x
- Python 3.12
- `wechatauto-replica 1.2.4.4`
- 单个白名单私聊会话
- 纯文字收发

实际跑通过：

```text
WeChat text
→ Adapter
→ Bridge
→ Agent
→ Bridge
→ Adapter
→ WeChat text
```

包括：

- 文字入站
- Bridge ingress
- Agent 回复
- Bridge 长轮询下发
- 微信发送确认
- command 去重
- ACK 重试
- Windows 自动启动
- Supervisor 崩溃拉起

## 上游托管 Agent 的延迟

如果日志里很快出现微信消息已经交给 Bridge，但最终回复很慢，延迟可能已经不在 Windows Adapter 这一层。

例如 webhook / MCP Events / Automations 这类托管执行机制中：

- webhook 被接受，不等于模型 turn 一定已经启动
- 模型读取事件，不等于最终回复一定已经提交

因此 Bridge 最好自己保留 pending 事件，并实现 retry / watchdog，而不是把“通知已接受”直接视为“消息已处理”。

## 项目边界

这一版**故意只保留文字流**。

如果你需要图片、语音、文件、朋友圈、拍一拍或更多微信桌面自动化能力，请直接参考上游项目扩展，不建议等本仓库重复实现全部能力。

## 文档

- **[端到端链路与部署路线图](docs/END_TO_END.md)**：从 Windows 微信直到 ChatGPT 回微信
- [VPS 部署与 Bridge 实现检查单](docs/VPS_BRIDGE.md)：HTTPS、systemd、队列、MCP Events 端点
- [ChatGPT Work 订阅 MCP Events](docs/WORK_MCP_EVENTS.md)：插件、订阅、读取、回复、排错
- [Bridge HTTP 协议](docs/BRIDGE_PROTOCOL.md)：文字入站、长轮询、ACK、心跳
- [Windows 部署与排错](docs/DEPLOY.md)：Adapter 自启动与日志

## 致谢

Windows 微信读写能力来自 [wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)。

感谢上游作者对微信 4.x 本地数据读取与自动化能力的维护。

## License

Apache License 2.0，与上游 `wechatauto-replica` 保持一致。详见 [LICENSE](LICENSE)。