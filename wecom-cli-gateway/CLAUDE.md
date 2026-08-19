# CLAUDE.md — wecom-cli-gateway（企微 CLI 网关）

把 IM（企业微信，钉钉/飞书预留）消息桥接到 CLI 工具（claude / codex / cursor / opencode）的独立网关服务。
桥接模式下复用上游 `claudecodeui`（本仓库父目录，端口 3001）的 `POST /api/agent` 外部 API 驱动 claude 等，而非直接 spawn。

技术栈：TypeScript + ESM（`"type":"module"`），Fastify（HTTP/回调），ioredis（会话/流式/锁），zod（配置校验），vitest（测试）。

---

## 目录结构

```
src/
  im/        IM 适配器：wecom（企微智能机器人）、dingtalk、feishu、wecom-crypto（AES-256-CBC+SHA1 加解密）、types
  cli/       CLI 适配器：claude/codex/cursor/opencode/ccui（桥接 claudecodeui）、ccui-sse（SSE 解析）、registry、spawn-cli、types
  router/    session-router.ts —— 核心会话编排（唯一入口）
  store/     redis.ts —— SessionStore：会话、流式 chunk、锁、去重
  server/    app.ts（fastify 装配）、webhook.ts（回调路由）、admin.ts（最小配置页）
  config/    loader.ts、schema.ts（zod）
docs/        deploy.md（部署）、ccui-bridge-setup.md（桥接联调）、remote-claudemd.template.md（远程 CLAUDE.md 模板）
tests/       与 src 镜像的 vitest 单测
start.sh/.ps1/.bat + stop.*   一键启停（start 会同时拉起 claudecodeui 3001 与网关 3002）
```

## 运行命令

```bash
npm run dev        # tsx watch 热重载
npm run build      # tsc -> dist/
npm start          # node dist/index.js
npm test           # vitest run
npm run test:watch
```

## 配置（config.yaml，zod schema 见 src/config/schema.ts）

- `server.port`（默认 3002）/ `redis.url`
- `bots[]`：每 bot 独立 `platform` / `defaultCli` / `projectDir`（claude 工作目录）/ `timeout`（秒）/ `allowedUsers`（空=不限制）/ `credentials`（企微 `aesKey`+`token`）
- `clis.claude/codex/cursor/opencode`：`path`；**`clis.ccui`**：`baseUrl`+`apiKey`（claudecodeui 自托管 API key）+`timeoutMs`（默认 600000）

> **ccui 桥接开关**：`clis.ccui` 存在时，`buildCliAdapters`（src/cli/registry.ts）把 claude/codex/cursor/opencode **全部**路由到 `CcuiAdapter`（仅 `provider` 参数不同），统一走 claudecodeui `/api/agent`；删除该段并重启即回退到旧的 `ClaudeAdapter` 等直接 spawn 实现。

## 关键机制（改动前必读，均为企微联调踩坑产物）

- **流式回复**：用户消息 → webhook 同步初始化 Redis stream 状态（content 空 finish=false）→ 异步启动 router → 内容实时**覆盖式**写 Redis（`stream:{streamId}`）→ 企微按 streamId 推刷新回调从 Redis 拉最新。首响应 **5s 内必须返回**。
- **会话 Key 四维隔离**：`botId:chatSceneId:userId:cliType`（防串话）；`/clear` / `清空上下文` 删该用户**全部** cliType 会话（`ALL_CLI_TYPES`）。
- **进入会话每日清空（enter_chat）**：企微用户**当天首次**进入单聊推 `enter_chat` 事件（无 response_url，仅单聊）；网关清空该用户全部 cliType 会话 + 被动**文本**回复欢迎语（`buildTextResponse`，非流式）。Redis `dailyclear:` 记录当天已清空防重复；欢迎语 bot 配置 `enterGreeting` 可配，默认 `DEFAULT_ENTER_GREETING`。
- **锁与去重**：`tryAcquireLock`/`isDuplicate` 用原子 `SET EX NX`；锁 TTL 120s、去重 300s、stream 400s。
- **企微被动流式显示限制（核心）**：短内容（<200 字，实证 ≈18 字不上屏）企微不显示。`ensureDisplayable`（MIN_DISPLAY_LEN=200）把短回复统一补说明文字至安全长度。改动任何"显示"逻辑先看这里。
- **finishDelayMs（默认 3000）**：claude 一次性输出时内容与完成几乎同时，企微刷不到 `finish=false` 内容帧就不认完成；先推内容、延时后再标记 finish=true。`clearDelayMs`（默认 6000）同理用于清空命令。**若缩短可能导致企微不显示，勿轻易调小。**
- **activePush 主动回复（response_url）**：仅当触发过 3 分钟安抚（`reassureSec=180`）才用回调携带的 `response_url` 主动推送兜底；快速完成靠被动流式已送达，不再主动推。
- **auto mode 后缀**：`src/cli/ccui.ts` 的 `AUTO_MODE_PROMPT` 每轮给企微消息追加精简约束，阻止 claude 用 `AskUserQuestion`/`ExitPlanMode` 交互式工具卡死企微。**与 docs/remote-claudemd.template.md 职责互补**（后缀=每轮强制约束，CLAUDE.md=SessionStart 环境/流程指引）；改模板时需同步该常量保持一致。
- **企微加解密**：回调为加密 JSON（非 XML）；回复用回调 `response_url`，无需 corpId/secret。**nonce 必须复用回调 URL query 的 nonce**（webhook.ts 注释强调，从 header 取会取空导致企微拒绝显示）。
- **claude-agent-sdk 注入**：ClaudeAdapter 用 `@anthropic-ai/claude-agent-sdk` 的 `query()`；路径经 `CLAUDE_AGENT_SDK_PATH` 环境变量注入，默认 import 本仓库 node_modules。

## 代码约定

- 适配器多采用**依赖注入式**（fetchSse / query / runCodex / spawnCli 可注入），便于单测 mock —— 新增 CLI/IM 适配器沿用此模式，勿在实现里硬编码网络调用。
- SSE 事件区分：控制类用 `type`（status/session-id/done），消息类用 `kind`（text/tool_use/…）；`extractText` 抽取 `{kind:"text", role:"assistant", content}` 为最终回复。
- 企微被动流式只显示 finish=true 的内容（安抚须 finish=true 才能上屏）。
- 对企微展示的文案面向真实用户，避免大段表格/超长代码。

## 运行拓扑

网关(3002) ──/api/agent SSE──▶ claudecodeui(3001) ──▶ claude code
    ▲                                         共享 ~/.claude（技能/MCP/会话）
    └── 企微回调（公网 https 反代到 /webhook/wecom/{botId}）

`projectDir` 里放一份 `remote-claudemd.template.md` 改成的 `CLAUDE.md`，企微会话 SessionStart 自动加载环境与 devops 流程。
