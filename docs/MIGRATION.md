# 升级到 v0.2.0

v0.2.0 将项目代码中的私人命名全部替换为中性名称。这次涉及运行接口变更，不能只更新文件后直接重启。

## 1. 停止旧实例，保留发送记录

先等当前消息处理完成，再停止 VPS Bridge、Windows 上原有的计划任务和对应的 Adapter / Supervisor 进程。卸载旧计划任务后再安装新任务，避免两个实例同时操作微信。

保留 Windows `.local/delivered_commands.json`：它保存已完成 command 的记录，用于抑制重复发送。VPS 的未完成会话队列仍含内存状态，请在空闲时升级。

## 2. 设置新的 Windows 用户环境变量

把原来的 Bridge 地址、Agent token 与目标会话 ID 分别填入：

```powershell
[Environment]::SetEnvironmentVariable('WECHAT_BRIDGE_URL', 'https://your-bridge.example.com', 'User')
[Environment]::SetEnvironmentVariable('WECHAT_AGENT_TOKEN', '<same token as VPS>', 'User')
[Environment]::SetEnvironmentVariable('WECHAT_TARGET', '<target wxid>', 'User')
```

确认值正确后移除旧版变量，重新打开终端。VPS 上的 `WECHAT_AGENT_TOKEN`、`MCP_EVENTS_PATH_TOKEN`、`MCP_EVENTS_STORE_PATH` 配置名保持不变，token 无需因为这次改名而重置。

## 3. 构建并启动新版

VPS 在 `bridge/` 目录执行：

```bash
npm ci
npm run typecheck
npm run build
npm test
```

使用现有服务管理方式启动 Bridge。既有 Linux 安装目录与 systemd 服务名可以沿用，不要复制新服务导致两个实例同时运行。

Windows 先手动运行 `adapter.py`，确认 Listener、outbound sender 与 heartbeat 正常，再运行 `install-autostart.ps1`。新版任务名为 `WeChat Resonance Adapter`。

## 4. 重新扫描并订阅 MCP

在 ChatGPT 中重新扫描原有的 MCP endpoint，取消旧订阅并在目标 Work 对话中订阅：

```text
wechat.bridge.requested
{"source":"wechat.dm"}
```

新工具名称：

```text
wechat_bridge_get_event
wechat_bridge_reply
```

同时更新对话指令或自动化里写死的工具名。旧事件订阅不会自动当作新事件订阅使用，需要重新经过 callback 验证。

## 5. 验证完整收发

在白名单微信会话发一条测试文字。依次确认 Windows 读取并上报、Work 被唤醒、新工具被调用、GUI 在原会话发出回复、Windows 报告发送成功与 ACK。确认只有一条回复后再恢复日常使用。
