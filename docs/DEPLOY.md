# 部署与排错 — Text Relay v0

## 推荐结构

```text
Windows PC
├─ 官方微信
└─ Cove WeChat Adapter
       │ HTTPS
       ▼
Bridge
       │
       ▼
Agent / LLM
```

## 第一次部署

1. Windows 登录官方微信。
2. 安装 Python 3.12。
3. 创建 `.venv`。
4. 安装 `requirements.txt`。
5. 配置三个 `COVE_WECHAT_*` 用户环境变量。
6. 先手动运行 `adapter.py`。
7. 确认 Listener、outbound sender、heartbeat 正常。
8. 再运行 `install-autostart.ps1`。

## 日志

默认：

```text
logs/supervisor.log
```

常见关键字：

```text
[listener] active
[inbound]
[inbound:error]
[outbound]
[outbound:sent]
[outbound:dedupe]
[receipt:ack]
[receipt:deferred]
```

## 微信发了文字，但 Agent 没收到

按层排查：

```text
微信 DB 是否读到
↓
Listener 是否触发
↓
POST /wechat/agent/events 是否成功
↓
Bridge 是否入队
↓
Agent 是否真正领取
```

如果 Adapter 已经打印 `[inbound] ... created=True`，Windows 侧基本已经完成自己的工作。

## Agent 已回复，但微信没收到

检查：

```text
Bridge 是否生成 command
↓
Adapter 是否从 /next 取到
↓
[outbound:sent] 是否出现
↓
[receipt:ack] 是否出现
```

`outbound:sent` 出现后，即使 ACK 暂时失败，Adapter 也会记住 command ID，避免重复发送同一条微信消息。

## 看到多个 pythonw.exe

使用 Python venv 时可能看到两层 Python 启动链：

```text
supervisor launcher
└─ supervisor python
   └─ adapter launcher
      └─ adapter python
```

这不等于运行了两套 Adapter。

判断重复实例时，请看：

- 父子进程树
- Scheduled Task
- named mutex

## Bridge / Agent 回复很慢

如果微信消息很快到达 Bridge，但回复延迟明显，问题可能在 Agent / 托管执行层。

例如：

```text
Bridge 已通知上游
→ webhook accepted
→ 但模型 turn 没启动
```

或者：

```text
Agent 已领取事件
→ 但 turn 中途终止
→ 没有生成最终 reply command
```

这类问题不是提高 Adapter 网络重试次数就一定能解决。

Bridge 应保留原 pending event，并通过 watchdog 重试。

## 文字版范围

本公开版只处理微信 `文本` 类型。

以下消息不在 v0 范围：

- 图片
- 动画表情
- 语音
- 文件
- 视频
- 拍一拍
- 朋友圈

需要这些功能时，请参考上游微信自动化项目自行扩展。

## 安全建议

- 只允许白名单 conversationId
- Adapter token 使用最小权限
- 不提交真实 token / wxid
- Bridge 使用 HTTPS
- eventId / commandId 做幂等
- 日志避免泄露凭据
