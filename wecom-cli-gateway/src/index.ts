import { loadConfig } from "./config/loader.js";
import { createRedis, SessionStore } from "./store/redis.js";
import { WeComAdapter } from "./im/wecom.js";
import { DingtalkAdapter } from "./im/dingtalk.js";
import { FeishuAdapter } from "./im/feishu.js";
import { ClaudeAdapter } from "./cli/claude.js";
import { CodexAdapter } from "./cli/codex.js";
import { CursorAdapter } from "./cli/cursor.js";
import { OpencodeAdapter } from "./cli/opencode.js";
import { SessionRouter } from "./router/session-router.js";
import { StreamRelay } from "./relay/stream-relay.js";
import { createApp } from "./server/app.js";
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

async function main() {
  const cfg = loadConfig(process.env.CONFIG_PATH ?? "config.yaml");
  const redis = createRedis(cfg.redis.url);
  const store = new SessionStore(redis as any);

  // IM 适配器注册表
  const imAdapters: Record<string, IMAdapter> = {};
  const claudeQuery = await loadClaudeQuery();
  const cliAdapters: Record<CliType, CliAdapter> = {
    claude: new ClaudeAdapter({ query: claudeQuery }),
    codex: new CodexAdapter(),
    cursor: new CursorAdapter(),
    opencode: new OpencodeAdapter(),
  };

  // 为每个 bot 建 router(各自 defaultCli/timeout/白名单)
  const routers: Record<string, SessionRouter> = {};
  for (const bot of cfg.bots) {
    const router = new SessionRouter({
      store,
      getAdapter: (t) => cliAdapters[t],
      defaultCli: bot.defaultCli,
      projectDir: bot.projectDir,
      timeoutSec: bot.timeout,
      cliSwitchPrefix: bot.cliSwitchPrefix,
      isAllowed: (uid) => bot.allowedUsers.includes(uid),
      onReply: async (text, msg) => {
        // 用 bot 对应的 IM 适配器回发
        const adapter = imAdapters[bot.id];
        for (const part of StreamRelay.split(text)) {
          await adapter.sendMessage({
            toUser: msg.userId,
            toChat: msg.chatSceneId.startsWith("group:") ? msg.chatSceneId.slice(6) : undefined,
            text: part,
            atUser: msg.chatSceneId.startsWith("group:") ? msg.userId : undefined,
          });
        }
      },
    });
    routers[bot.id] = router;

    // 实例化 IM 适配器(本期仅 wecom 完整)
    if (bot.platform === "wecom") {
      imAdapters[bot.id] = new WeComAdapter(bot.credentials as any, /* crypto 真实实现,联调时注入 */ {} as any, bot.id);
    } else if (bot.platform === "dingtalk") {
      imAdapters[bot.id] = new DingtalkAdapter();
    } else if (bot.platform === "feishu") {
      imAdapters[bot.id] = new FeishuAdapter();
    }
  }

  // webhook 依赖
  const app = createApp({
    parseMessage: async (body, headers, botId, platform) => {
      const adapter = imAdapters[botId];
      if (!adapter) return null;
      return adapter.parseMessage(body, headers);
    },
    routerHandle: async (msg) => {
      const router = routers[msg.botId];
      if (router) await router.handle(msg);
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
