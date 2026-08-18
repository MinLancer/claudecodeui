import { loadConfig } from "./config/loader.js";
import { createRedis, SessionStore } from "./store/redis.js";
import { WeComAdapter } from "./im/wecom.js";
import { DingtalkAdapter } from "./im/dingtalk.js";
import { FeishuAdapter } from "./im/feishu.js";
import { buildCliAdapters } from "./cli/registry.js";
import { realSpawnCli } from "./cli/spawn-cli.js";
import { SessionRouter } from "./router/session-router.js";
import { createApp } from "./server/app.js";
import { FIRST_REPLY_PLACEHOLDER } from "./server/webhook.js";
import { registerAdmin } from "./server/admin.js";
import { pathToFileURL } from "node:url";
import type { IMAdapter, NormalizedMessage } from "./im/types.js";
import type { CliAdapter, CliType } from "./cli/types.js";
import type { QueryFn } from "./cli/claude.js";

// 企微加解密(生产用 @wecom/crypto,此处按实际 SDK 接入)
// 接入时安装对应包并在 wecom.ts 的 crypto 注入真实实现

// claude-agent-sdk 路径:优先本仓库 node_modules,否则用环境变量 CLAUDE_AGENT_SDK_PATH 指向。
// 当前本机 SDK 装在 C:/Users/Administrator/.codemoss/dependencies/claude-sdk 下,
// 用 CLAUDE_AGENT_SDK_PATH 环境变量注入,或后续 npm install 装到本仓库。
async function loadClaudeQuery(): Promise<QueryFn> {
  const sdkPath = process.env.CLAUDE_AGENT_SDK_PATH;
  const target = sdkPath
    ? pathToFileURL(sdkPath + "/sdk.mjs").href
    : "@anthropic-ai/claude-agent-sdk";
  const mod = await import(target);
  return mod.query as QueryFn;
}

// codex SDK:@openai/codex-sdk。本机未装时降级为抛错的桩(isAvailable 仍 true,调用时报错)。
// 联调时安装 SDK 或设 CODEX_SDK_PATH。
async function loadCodexRun(): Promise<any> {
  const sdkPath = process.env.CODEX_SDK_PATH;
  try {
    const target = sdkPath ? pathToFileURL(sdkPath).href : "@openai/codex-sdk";
    const mod = await import(target);
    const Codex = mod.Codex ?? mod.default?.Codex;
    return async function* (params: { prompt: string; cwd: string; resume?: string; signal?: AbortSignal }) {
      const codex = new Codex();
      const thread = params.resume
        ? await codex.thread.resumeThread(params.resume, { workingDirectory: params.cwd })
        : await codex.thread.startThread({ workingDirectory: params.cwd });
      const turn = thread.runStreamed(params.prompt, { signal: params.signal });
      for await (const event of turn.events) yield event;
    };
  } catch (e) {
    // SDK 未装:返回桩,调用时抛清晰错误
    return async function* () {
      throw new Error("codex SDK 未加载(@openai/codex-sdk),设 CODEX_SDK_PATH 或 npm install");
    };
  }
}

async function main() {
  const cfg = loadConfig(process.env.CONFIG_PATH ?? "config.yaml");
  const redis = createRedis(cfg.redis.url);
  const store = new SessionStore(redis as any);

  // IM 适配器注册表
  const imAdapters: Record<string, IMAdapter> = {};
  const claudeQuery = await loadClaudeQuery();
  // ccui 配置存在时桥接 claudecodeui,否则回退到旧适配器(保留备用)
  const cliAdapters: Record<CliType, CliAdapter> = buildCliAdapters(cfg, {
    claudeQuery,
    codexRun: await loadCodexRun(),
    spawnCli: realSpawnCli,
  });

  // 为每个 bot 建 router(各自 defaultCli/timeout/白名单)
  const routers: Record<string, SessionRouter> = {};

  // 先实例化 IM 适配器(主动回复需要 adapter.sendMessage)
  for (const bot of cfg.bots) {
    if (bot.platform === "wecom") {
      imAdapters[bot.id] = new WeComAdapter(bot.credentials as any, bot.id);
    } else if (bot.platform === "dingtalk") {
      imAdapters[bot.id] = new DingtalkAdapter();
    } else if (bot.platform === "feishu") {
      imAdapters[bot.id] = new FeishuAdapter();
    }
  }

  for (const bot of cfg.bots) {
    const router = new SessionRouter({
      store,
      getAdapter: (t) => cliAdapters[t],
      defaultCli: bot.defaultCli,
      projectDir: bot.projectDir,
      timeoutSec: bot.timeout,
      cliSwitchPrefix: bot.cliSwitchPrefix,
      // 白名单:allowedUsers 为空表示不限制(联调/开放),否则仅放行名单内用户
      isAllowed: (uid) => bot.allowedUsers.length === 0 || bot.allowedUsers.includes(uid),
      // claude 完成后用回调的 response_url 主动推送最终结果(兜底企微流式刷新超时)
      sendActiveReply: async (msg, content) => {
        const adapter = imAdapters[msg.botId];
        if (!adapter) return;
        await adapter.sendMessage({ toUser: msg.userId, text: content, responseUrl: msg.responseUrl });
      },
    });
    routers[bot.id] = router;
  }

  // webhook 依赖
  const app = createApp({
    parseMessage: async (body, headers, botId, _platform) => {
      const adapter = imAdapters[botId];
      if (!adapter) return null;
      return adapter.parseMessage(body, headers);
    },
    // 用户消息:同步初始化 stream 状态(content 空 finish=false),再异步启动 router。
    // 同步初始化保证刷新回调来时能拿到状态(非 null),避免 claude 冷启动慢导致提前结束。
    handleUserMessage: async (msg) => {
      const streamId = msg.msgId;
      await store.setStreamChunk(streamId, FIRST_REPLY_PLACEHOLDER, false); // 同步写初始状态(非空占位,让企微端进入流式)
      const router = routers[msg.botId];
      if (router) router.handle(msg, streamId).catch((e) => console.error("router 异常:", e.message));
      return streamId;
    },
    // 流式刷新回调:从 Redis 拉 stream 状态
    getStreamState: async (streamId) => store.getStreamState(streamId),
    // 构造流式加密响应(由 IMAdapter 提供)
    buildStreamResponse: async (streamId, content, finish, nonce) => {
      // 用户消息的 botId 从 streamId 无法反推,但 buildStreamResponse 不需要 botId(只用 crypto)
      // 取第一个 wecom 适配器(单 bot 场景);多 bot 需按 botId 路由,此处简化
      const adapter = Object.values(imAdapters)[0];
      if (!adapter) throw new Error("无 IM 适配器");
      return adapter.buildStreamResponse(streamId, content, finish, nonce);
    },
    verifyUrl: async (query, botId, _platform) => {
      const adapter = imAdapters[botId];
      if (adapter && "verifyUrl" in adapter && typeof (adapter as any).verifyUrl === "function") {
        return (adapter as any).verifyUrl(query);
      }
      return null;
    },
  });

  // 最小配置页
  registerAdmin(app, {
    getBots: () => cfg.bots.map((b) => ({ id: b.id, timeout: b.timeout, allowedUsers: b.allowedUsers, defaultCli: b.defaultCli })),
    updateBot: (id, patch) => {
      const b = cfg.bots.find((x) => x.id === id);
      if (!b) throw new Error("bot 不存在");
      if (patch.timeout !== undefined) b.timeout = patch.timeout;
      if (patch.allowedUsers !== undefined) b.allowedUsers = patch.allowedUsers;
      if (patch.defaultCli !== undefined) b.defaultCli = patch.defaultCli as CliType;
      // 同步刷新对应 router
      (routers[id] as any).deps.timeoutSec = b.timeout; // 简化:实际应有 setter
      (routers[id] as any).deps.defaultCli = b.defaultCli;
    },
  });

  await app.listen({ port: cfg.server.port, host: "0.0.0.0" });
  console.log(`网关已启动,端口 ${cfg.server.port}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
