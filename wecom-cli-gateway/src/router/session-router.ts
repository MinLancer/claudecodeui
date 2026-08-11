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
  // 白名单判断:由 bot 配置注入
  isAllowed: (userId: string) => boolean;
}

export class SessionRouter {
  constructor(private deps: RouterDeps) {}

  // 流式:把最新累积内容写 Redis(覆盖式),供 webhook 刷新回调拉取
  private async pushStream(streamId: string, content: string, finish: boolean): Promise<void> {
    try {
      await this.deps.store.setStreamChunk(streamId, content, finish);
      console.log(`[router] push stream=${streamId.slice(0,12)} finish=${finish} len=${content.length}`);
    } catch {
      // Redis 写失败忽略,避免影响主流程(刷新回调会拉到旧值或空)
    }
  }

  async handle(msg: NormalizedMessage, streamId: string): Promise<void> {
    try {
      // 1. 白名单
      if (!this.deps.isAllowed(msg.userId)) {
        await this.pushStream(streamId, "无权限使用该机器人", true);
        return;
      }

      // 2. 去重
      if (await this.deps.store.isDuplicate(msg.msgId)) {
        await this.pushStream(streamId, "消息已处理", true);
        return;
      }

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
        await this.pushStream(streamId, "⏳ 上一条还在处理中,稍后再试", true);
        return;
      }

      try {
        const adapter = this.deps.getAdapter(cliType);
        if (!adapter) {
          await this.pushStream(streamId, `⚠️ ${cliType} 未配置或未实现`, true);
          return;
        }

        // 6. 取已有 session
        const existing = await this.deps.store.getSession(key);

        let session;
        try {
          session = await adapter.start({ projectDir: this.deps.projectDir, sessionId: existing?.sessionId });
        } catch {
          await this.pushStream(streamId, "⚠️ claude 启动失败,请联系管理员", true);
          return;
        }

        // 7. 执行 + 超时:实时把 final chunk 累积写 Redis(流式)
        const finalChunks: string[] = [];
        const exec = (async () => {
          for await (const c of session.send(text)) {
            if (c.type === "final") {
              finalChunks.push(c.text);
              // 实时推送当前累积内容(覆盖式),finish=false
              await this.pushStream(streamId, finalChunks.join(""), false);
            } else if (c.type === "error") {
              finalChunks.push(c.text);
              await this.pushStream(streamId, finalChunks.join(""), false);
            }
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
          if (!timedOut) {
            await this.pushStream(streamId, finalChunks.join("") || "⚠️ 处理失败,请重试", true);
          }
        } finally {
          clearTimeout(timer);
          session.kill();
        }

        if (timedOut) {
          await this.pushStream(streamId, finalChunks.join("") || "⏱ 处理超时,已终止", true);
          return;
        }

        // 8. 回写 session
        if (session.sessionId && session.sessionId !== existing?.sessionId) {
          await this.deps.store.setSession(key, session.sessionId);
        }

        // 9. 流式结束:finish=true(最终内容已在循环里推送过,这里标记完成)
        const reply = finalChunks.join("").trim();
        await this.pushStream(streamId, reply || "(空回复)", true);
      } finally {
        await this.deps.store.releaseLock(key);
      }
    } catch {
      // 最外层兜底:Redis 不可达等
      await this.pushStream(streamId, "⚠️ 服务暂时不可用", true);
    }
  }
}
