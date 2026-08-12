# 企微网关桥接 claudecodeui 联调指南

本指南将 wecom-cli-gateway 接入 claudecodeui 的 `POST /api/agent` 外部 API,使企微消息复用 claudecodeui 的 CLI 能力。

## 前置条件

- claudecodeui 源码位于 `F:\lancer_work\private\code\claudecodeui`(server 端口 3001)
- wecom-cli-gateway 位于其下 `wecom-cli-gateway/`(server 端口 3002)
- Node 18+(网关 `defaultFetchSse` 使用全局 `fetch`)
- Redis(wecom-redis 容器,默认 `redis://localhost:6379`)

## 1. 启动 claudecodeui

在 `claudecodeui` 目录(注意:不是 wecom-cli-gateway 子目录):

```bash
# .env 已存在:SERVER_PORT=3001 / HOST=0.0.0.0
npx tsx --tsconfig server/tsconfig.json server/index.ts
```

确认日志出现监听 3001。

## 2. 自托管模式:注册账号并创建 API key

claudecodeui Web UI 默认在 3001 端口提供前端页面。

1. 浏览器打开 `http://localhost:3001`
2. 注册一个账号(用户名 + 密码)
3. 登录后进入 Settings 页,创建一个 API key(命名为如 `wecom-gateway`)
4. 复制生成的 API key(形如 `ccui-...`,只显示一次)

> 注:claudecodeui 自托管模式下 `/api/agent` 通过 `x-api-key` 认证(见 `server/modules/agent/agent.routes.ts` 的 `validateExternalApiKey`)。`IS_PLATFORM` 环境变量不设置(保持自托管)。

## 3. 配置 wecom-cli-gateway

编辑 `wecom-cli-gateway/config.yaml`,在 `clis` 下新增 `ccui`:

```yaml
clis:
  claude:
    path: claude
  ccui:
    baseUrl: http://localhost:3001
    apiKey: <上一步复制的 API key>
    # timeoutMs: 600000   # 可选,默认 10 分钟
```

`bots` 配置不变(已有 wecom_1 bot,defaultCli=claude,projectDir 指向工作目录)。

## 4. 启动网关

在 `wecom-cli-gateway` 目录:

```bash
npm run dev
```

确认日志显示端口 3002 监听。

## 5. 端到端验证

1. 确认 claudecodeui(3001)与网关(3002)都在运行
2. 在企微向机器人发送 `你好`
3. 检查网关日志:应出现 `[router] push stream=... finish=false`(流式推送)然后 `finish=true`
4. claudecodeui 日志应出现 `🤖 Starting Claude SDK session`
5. 企微端收到 claude 的回复

## 6. 故障排查

| 现象 | 排查 |
|------|------|
| 网关日志 `⚠️ claude 启动失败` | 检查 3001 是否监听;API key 是否正确 |
| 企微无回复,网关无 push 日志 | Redis 连接;加解密;参考已有排查记录 |
| claudecodeui 401 | API key 失效,重新生成 |
| claudecodeui 400 `Either githubUrl or projectPath` | bot.projectDir 路径不存在,确保目录已创建 |
| 超时 | 增大 bot.timeout 或 ccui.timeoutMs |

## 7. 回退到旧适配器

如需回退(不桥接 claudecodeui,直接用 claude-agent-sdk),删除 config.yaml 中 `clis.ccui` 段并重启网关,`buildCliAdapters` 自动回退到 `ClaudeAdapter`(旧适配器保留备用)。
