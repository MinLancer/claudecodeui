import type { NormalizedMessage } from "../im/types.js";
import type { SessionStore } from "../store/redis.js";
import type { CliAdapter, StreamChunk } from "../cli/types.js";
import type { CliType } from "../cli/types.js";

export interface RouterDeps {
  store: SessionStore;
  getAdapter: (cliType: CliType) => CliAdapter | undefined;
  defaultCli: CliType;
  projectDir: string; // 该 bot 的工作目录,传给 CLI 作为 cwd
  timeoutSec: number;
  cliSwitchPrefix?: string;
  // 回复回调:由 webhook 层注入,调 IMAdapter.sendMessage
  onReply: (text: string, msg: NormalizedMessage) => Promise<void>;
  // 白名单判断:由 bot 配置注入
  isAllowed: (userId: string) => boolean;
}

export class SessionRouter {
  constructor(private deps: RouterDeps) {}

  async handle(msg: NormalizedMessage): Promise<void> {
    // 1. 白名单
    if (!this.deps.isAllowed(msg.userId)) {
      await this.deps.onReply("无权限使用该机器人", msg);
      return;
    }

    // 2. 去重
    if (await this.deps.store.isDuplicate(msg.msgId)) return;

    // 3. 解析 CLI(默认 / @前缀切换)
    let cliType: CliType = this.deps.defaultCli;
    let text = msg.text;
    if (this.deps.cliSwitchPrefix) {
      const prefix = this.deps.cliSwitchPrefix;
      if (text.startsWith(prefix)) {
        const rest = text.slice(prefix.length);
        const sp = rest.indexOf(" ");
        if (sp > 0) {
          const name = rest.slice(0, sp).trim();
          if (["claude", "codex", "cursor", "opencode"].includes(name)) {
            cliType = name as CliType;
            text = rest.slice(sp + 1).trim();
          }
        }
      }
    }

    // 4. Key
    const key = `${msg.botId}:${msg.chatSceneId}:${msg.userId}:${cliType}`;

    // 5. 锁
    if (!(await this.deps.store.tryAcquireLock(key))) {
      await this.deps.onReply("⏳ 上一条还在处理中,稍后再试", msg);
      return;
    }

    try {
      const adapter = this.deps.getAdapter(cliType);
      if (!adapter) {
        await this.deps.onReply(`⚠️ ${cliType} 未配置或未实现`, msg);
        return;
      }

      // 6. 取已有 session
      const existing = await this.deps.store.getSession(key);
      const session = await adapter.start({ projectDir: this.deps.projectDir, sessionId: existing?.sessionId });

      // 7. 执行 + 超时
      const finalChunks: string[] = [];
      const exec = (async () => {
        for await (const c of session.send(text)) {
          if (c.type === "final") finalChunks.push(c.text);
          else if (c.type === "error") finalChunks.push(c.text);
        }
      })();

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        session.kill();
      }, this.deps.timeoutSec * 1000);

      try {
        await exec;
      } catch {
        if (!timedOut) await this.deps.onReply("⚠️ 处理失败,请重试", msg);
      } finally {
        clearTimeout(timer);
      }

      if (timedOut) {
        await this.deps.onReply("⏱ 处理超时,已终止", msg);
        return;
      }

      // 8. 回写 session
      if (session.sessionId && session.sessionId !== existing?.sessionId) {
        await this.deps.store.setSession(key, session.sessionId);
      }

      // 9. 推送 final(攒齐)
      const reply = finalChunks.join("").trim();
      if (reply) await this.deps.onReply(reply, msg);
    } finally {
      await this.deps.store.releaseLock(key);
    }
  }
}
