import type { NormalizedMessage } from "../im/types.js";
import type { SessionStore } from "../store/redis.js";
import type { CliAdapter, StreamChunk } from "../cli/types.js";
import type { CliType } from "../cli/types.js";

// 全部支持的 CLI 类型:清空上下文命令会删除该用户在所有类型下的会话
const ALL_CLI_TYPES: CliType[] = ["claude", "codex", "cursor", "opencode"];

// 格式化时间戳:yyyy-MM-dd HH:mm:ss.sss
function ts(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

// 企微智能机器人被动流式对过短内容(实证 ≈18 字符)不上屏,只显示转圈等待;较长内容(180+)能上屏。
// 为让所有回复(状态提示、错误、短回复)都能被企微展示,短内容统一补充说明文字至安全长度。
const MIN_DISPLAY_LEN = 200;
function ensureDisplayable(content: string): string {
  if (content.length >= MIN_DISPLAY_LEN) return content;
  return (
    content +
    "\n\n————————\n【补充说明】本回复由企微机器人网关自动生成,内容较为简短。为符合企业微信消息展示规范,系统已自动补充以下说明:\n" +
    "1. 若为状态提示,表示相应操作已按预期处理完成或正在处理中;\n2. 若需继续操作,请直接发送具体指令,例如任务内容、需求编号、工单号、项目路径等;\n" +
    "3. 复杂任务将在后台持续处理,处理完成后会主动推送结果给您;\n4. 如需调整操作或补充信息,请随时留言,我会继续协助您处理。\n" +
    "————————\n感谢使用,祝工作顺利!"
  );
}

export interface RouterDeps {
  store: SessionStore;
  getAdapter: (cliType: CliType) => CliAdapter | undefined;
  defaultCli: CliType;
  projectDir: string; // 该 bot 的工作目录,传给 CLI 作为 cwd
  timeoutSec: number;
  cliSwitchPrefix?: string;
  // 白名单判断:由 bot 配置注入
  isAllowed: (userId: string) => boolean;
  // 主动回复回调:claude 完成后,若消息携带 responseUrl(企微),用其主动推送最终结果。
  // 用于兜底——企微流式刷新可能因 claude 处理过慢而超时,response_url(1h 有效)保证结果送达。
  sendActiveReply?: (msg: NormalizedMessage, content: string) => Promise<void>;
  // 安抚触发秒数:claude 处理超过此值仍未完成时,推一条安抚消息"请您稍后..."让企微显示,
  // 避免用户在企微流式刷新窗口内长时间看不到反馈。默认 180。
  reassureSec?: number;
  // 清空上下文命令词:命中则删除该用户所有 cliType 的会话(下次开新会话)。默认 ["/clear", "清空上下文"]。
  clearCommands?: string[];
  // 清空命令回复中,先推内容(finish=false)到标记完成(finish=true)之间的延时(ms)。
  // 企微被动流式需先看到"有内容未完成"的中间帧进入流式展示,才能接受 finish=true;
  // 默认 6000 给企微一次刷新机会。测试传小值。
  clearDelayMs?: number;
  // 正常回复完成前,内容(finish=false)到标记完成(finish=true)之间的延时(ms)。
  // claude 一次性输出完整回复时,内容出现与完成几乎同时,企微刷不到内容帧而不认完成;
  // 加短延时让企微刷新看到内容帧再完成。默认 3000。
  finishDelayMs?: number;
}

export class SessionRouter {
  constructor(private deps: RouterDeps) {}

  // 流式:把最新累积内容写 Redis(覆盖式),供 webhook 刷新回调拉取。
  // 短内容统一 ensureDisplayable 加长,确保企微被动流式能上屏。
  private async pushStream(streamId: string, content: string, finish: boolean): Promise<void> {
    const display = ensureDisplayable(content);
    try {
      await this.deps.store.setStreamChunk(streamId, display, finish);
      console.log(`[${ts()}] [router] push stream=${streamId.slice(0,12)} finish=${finish} len=${display.length} content=${display.slice(-100)}`);
    } catch {
      // Redis 写失败忽略,避免影响主流程(刷新回调会拉到旧值或空)
    }
  }

  // 主动回复兜底:claude 完成后,若消息带 responseUrl(企微),主动推送最终结果。
  // 企微流式刷新可能在 claude 处理过慢时超时,response_url(1h 有效)保证结果仍能送达。
  private async activePush(msg: NormalizedMessage, content: string): Promise<void> {
    if (!content || !this.deps.sendActiveReply || !msg.responseUrl) return;
    try {
      await this.deps.sendActiveReply(msg, content);
      console.log(`[${ts()}] [router] active-reply push len=${content.length} content=${content.slice(-100)}`);
    } catch (e) {
      console.error("[router] active-reply 失败:", (e as Error).message);
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
        // 清空上下文命令:删除该用户所有 cliType 的会话,下次消息开全新会话。
        // 在拿到锁后处理,避免与进行中的请求并发删除会话。
        const CLEAR_DEFAULT = ["/clear", "清空上下文"];
        const clearCmds = this.deps.clearCommands ?? CLEAR_DEFAULT;
        if (clearCmds.includes(text.trim())) {
          for (const t of ALL_CLI_TYPES) {
            await this.deps.store.deleteSession(`${msg.botId}:${msg.chatSceneId}:${msg.userId}:${t}`);
          }
          const clearMsg =
            "✅ 上下文已清空\n\n" +
            "已删除你在 claude / codex / cursor / opencode 全部工具下的历史会话记录。下次发送任意消息时,将开启一个全新的会话,不再携带此前的对话上下文。\n\n" +
            "注意:清空后 claude 将不再记得之前处理过的需求、工单审核等任务的背景信息。如需继续之前的任务,请重新描述需求,包括项目路径、需求编号或工单号等关键信息,以便 claude 重新定位并继续处理。";
          // 先推内容(finish=false)让企微进入流式展示,再延时后标记完成(finish=true)。
          // 企微被动流式是累积式,若首响应(空)后直接 finish=true,企微缺"有内容未完成"的
          // 中间帧而不认这次完成,会持续刷新等待。clearDelayMs 给企微一次刷新机会。
          const clearDelayMs = this.deps.clearDelayMs ?? 6000;
          await this.pushStream(streamId, clearMsg, false);
          await new Promise((r) => setTimeout(r, clearDelayMs));
          await this.pushStream(streamId, clearMsg, true);
          return;
        }

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

        // 安抚:claude 处理超过 reassureSec 仍未完成时,推安抚消息让企微显示"请您稍后"。
        // 企微被动流式只显示 finish=true 的内容,故安抚须 finish=true 才能上屏。
        // reassured 同时是"是否主动推送"的门槛:仅超时安抚后需主动推送兜底,快速完成靠被动流式即可。
        let reassured = false;
        const reassureSec = this.deps.reassureSec ?? 180;
        const reassureTimer = setTimeout(() => {
          reassured = true;
          this.pushStream(streamId, "请您稍后,待我处理完成后会主动通知您。", true);
        }, reassureSec * 1000);

        try {
          await exec;
        } catch {
          if (!timedOut) {
            await this.pushStream(streamId, finalChunks.join("") || "⚠️ 处理失败,请重试", true);
          }
        } finally {
          clearTimeout(timer);
          clearTimeout(reassureTimer);
          session.kill();
        }

        if (timedOut) {
          const timedOutReply = finalChunks.join("") || "⏱ 处理超时,已终止";
          await this.pushStream(streamId, timedOutReply, true);
          if (reassured) await this.activePush(msg, timedOutReply);
          return;
        }

        // 8. 回写 session
        if (session.sessionId && session.sessionId !== existing?.sessionId) {
          await this.deps.store.setSession(key, session.sessionId);
        }

        // 9. 流式结束:finish=true(最终内容已在循环里推送过,这里标记完成)
        const reply = finalChunks.join("").trim();
        // 一次性输出时内容出现与完成几乎同时,企微刷不到 finish=false 内容帧而不认完成;
        // 加短延时让企微刷新看到内容帧,再标记完成。
        const finishDelayMs = this.deps.finishDelayMs ?? 3000;
        await new Promise((r) => setTimeout(r, finishDelayMs));
        await this.pushStream(streamId, reply || "(空回复)", true);
        // 仅在触发过安抚(处理超 reassureSec)时才主动推送;快速完成靠被动流式已送达。
        if (reassured) await this.activePush(msg, reply);
      } finally {
        await this.deps.store.releaseLock(key);
      }
    } catch {
      // 最外层兜底:Redis 不可达等
      await this.pushStream(streamId, "⚠️ 服务暂时不可用", true);
    }
  }
}
