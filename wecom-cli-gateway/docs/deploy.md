# 部署说明

## 前置
- Node.js 20+
- Redis(本机或外部,支持 URL 接入)
- claude code CLI(已装,PATH 可用)
- `@anthropic-ai/claude-agent-sdk`(网关依赖,见下 SDK 路径配置)
- claudecodeui(基座,独立运行,端口 3001,作 web 管理台)

## SDK 路径配置(重要)

ClaudeAdapter 用 `@anthropic-ai/claude-agent-sdk` 的 `query()` 驱动 claude code。SDK 路径通过环境变量注入:

```bash
# 方式1:指向已装的 SDK 目录(含 sdk.mjs)
export CLAUDE_AGENT_SDK_PATH="C:/Users/xxx/.codemoss/dependencies/claude-sdk/node_modules/@anthropic-ai/claude-agent-sdk"

# 方式2:在 wecom-cli-gateway 目录 npm install @anthropic-ai/claude-agent-sdk,留空即可(默认 import "@anthropic-ai/claude-agent-sdk")
```

未配置时默认 `import "@anthropic-ai/claude-agent-sdk"`,需在网关目录装该包。

## 启动网关
1. 复制 `config.example.yaml` 为 `config.yaml`,填:
   - `redis.url`(本机或外部 Redis)
   - bot 的 `credentials`(智能机器人的 `aesKey` + `token`,企微后台「智能机器人」配置页获取)
   - bot 的 `projectDir`(claude 工作目录)
   - `allowedUsers`(白名单)
2. `npm install && npm run build`
3. 设 `CLAUDE_AGENT_SDK_PATH`(若 SDK 不在本仓库)
4. `npm start`(或 `npm run dev` 开发热重载)

默认端口 3002。

## 公网接入(企微回调需公网 URL)

企微智能机器人回调要求公网可访问的 https URL。用 ngrok/frp/nginx 把 `https://你的域名/webhook/wecom/{botId}` 反代到本机 3002。

nginx 示例:
```nginx
location /webhook/ {
    proxy_pass http://127.0.0.1:3002;
    proxy_set_header Host $host;
}
```

## 企微后台配置

在企微管理后台「智能机器人」配置页:
- 接收消息 URL(回调): `https://你的域名/webhook/wecom/wecom_1`
- Token: 与 config.yaml 的 `credentials.token` 一致
- EncodingAESKey: 与 config.yaml 的 `credentials.aesKey` 一致
- 保存时企微发 GET 验证 URL 请求,网关自动解密 echostr 回显

## 流式回复机制

- 用户发消息 -> 网关在回调响应里返回**流式首响应**(stream, content 空, finish=false),并异步启动 claude
- claude 产出内容实时写 Redis(按 streamId,覆盖式)
- 企微按 streamId 推**刷新回调**,网关从 Redis 拉最新内容返回(覆盖式展示)
- claude 完成 -> 刷新回调返回 finish=true
- 流式超时 **6 分钟**(企微侧),claude 执行超时默认 180s(config 可改),无冲突

## 主动回复(response_url,非流式场景)

回调携带的 `response_url` 用于非用户消息触发的主动回复(如模板卡片事件),POST markdown,1 小时有效仅可用 1 次。日常用户对话走流式被动回复,不用 response_url。

## 验证

- 企微私聊机器人发"你好",应看到 claude 流式回复(内容逐步更新,最后完成)
- 群内 @机器人 发消息,机器人回复(群内引用触发消息)
- 不同人/不同群回复互不串话(会话 Key 四维隔离:botId+chatSceneId+userId+cliType)

## 共享 ~/.claude

网关与 claudecodeui 跑同一用户,共享 `~/.claude`。claude 的会话文件、MCP、skill、权限配置共享:
- 网关 spawn claude 时复用项目配置的 skill/mcp(需求1"调用配置好的 skill、mcp、cli"自动满足)
- 企微产生的会话可在 claudecodeui web 端只读查看

## 工作目录 CLAUDE.md(企微助手环境指引)

企微机器人的 `projectDir` 是 claude 的工作目录。把一份 **CLAUDE.md** 放在该目录下,企微触发会话时 **SessionStart 会自动加载**它,让 claude 自动理解环境、技能、MCP 与 devops 流程,无需每次手动说明。

### 模板与部署

- 模板见 [`docs/remote-claudemd.template.md`](remote-claudemd.template.md),覆盖:身份与运行方式、工作目录布局、可用 MCP、可用技能(rop-ai-kit 11 个)、完整 devops 流程(需求拆解→开发→提交登记工时→MR→部署→SQL 审核→日志排查)、企微场景行为约束、常用定位。
- 部署位置 = 企微机器人 `projectDir`(如容器内 `/workspace/ai-workspace`)。模板内容按实际环境修改后推送到该路径即可,注意保持容器用户属主与可读权限(如 `chown hybris:1000 && chmod 644`)。

### 与 auto mode 后缀的关系

- `src/cli/ccui.ts` 会给每条企微消息**追加精简的 auto mode 后缀**(阻止 claude 用 `AskUserQuestion`/`ExitPlanMode` 等交互式工具卡死企微,每轮兜底)。
- CLAUDE.md 只会在 SessionStart 加载一次、约束力较弱;两者职责互补:**后缀负责每轮强制约束,CLAUDE.md 负责环境与流程指引**。修改模板后如需让后缀与文档保持一致,同步更新 `ccui.ts` 中的 `AUTO_MODE_PROMPT`。

## 多 bot / 多 CLI

- config.yaml 可配多个 bot(不同 botId),各自凭证/白名单/projectDir
- 默认 CLI 为 claude;配 `cliSwitchPrefix: "@"` 后支持 `@codex`/`@cursor`/`@opencode` 前缀切换(需对应适配器实现,本期仅 claude 完整,其余预留)
