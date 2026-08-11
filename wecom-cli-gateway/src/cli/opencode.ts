import type { CliAdapter, CliSession, CliStartOpts, StreamChunk } from "./types.js";
import type { SpawnCliFn } from "./spawn-cli.js";

/**
 * OpencodeAdapter 基于 opencode CLI + json 解析(无官方 SDK)。
 *
 * 命令:opencode run --format json --dir <cwd> [--session <sid>] [--auto] <prompt>
 * - prompt 作命令行参数(opencode run [message..],官方文档确认,非 stdin)
 * - 输出每行一个 JSON(raw JSON events):session(sessionID)/message(content)/reasoning/tool_call/finish
 * - 会话恢复:--session <id>
 * - --auto:自动批准权限(网关自动化场景)
 *
 * 参考 claudecodeui server/modules/providers/list/opencode/opencode-runtime.provider.js。
 * 注意:本机未装 opencode,无法真实端到端验证;JSON 事件 schema 官方文档未展开,
 * 基于 claudecodeui 源码(sessionID/content 字段)推断,联调时可能需微调。
 */

interface OpencodeEvent {
  type: string; // session / message / reasoning / tool_call / tool_result / finish / error
  sessionID?: string;
  sessionId?: string; // 兼容大小写
  content?: string;
  name?: string; // tool_call
}

export interface OpencodeAdapterOpts {
  spawnCli: SpawnCliFn;
  /** opencode 可执行文件名/路径,默认 "opencode" */
  cmd?: string;
}

export class OpencodeAdapter implements CliAdapter {
  type = "opencode" as const;
  private cmd: string;

  constructor(private opts: OpencodeAdapterOpts) {
    this.cmd = opts.cmd ?? "opencode";
  }

  async isAvailable(): Promise<boolean> {
    return true; // 生产:which opencode
  }

  async start(opts: CliStartOpts): Promise<CliSession> {
    let sessionId: string | undefined = opts.sessionId;
    const spawnCli = this.opts.spawnCli;
    const cmd = this.cmd;
    const projectDir = opts.projectDir;
    let killFn: () => void = () => {};

    return {
      get sessionId() { return sessionId; },
      kill: () => { killFn(); },
      async *send(text): AsyncGenerator<StreamChunk> {
        // prompt 作参数:去换行(避免 shell 截断)
        const prompt = text.replace(/\r?\n/g, " ");
        const args = ["run", "--format", "json", "--dir", projectDir, "--auto"];
        if (sessionId) args.push("--session", sessionId);
        args.push(prompt);

        const proc = spawnCli({ cmd, args, cwd: projectDir });
        killFn = proc.kill;
        let finished = false;
        const messages: string[] = [];

        for await (const line of proc.stdout) {
          let e: OpencodeEvent;
          try { e = JSON.parse(line); } catch { continue; } // 非 JSON 行忽略

          // 捕获 sessionID(兼容 sessionID/sessionId)
          const sid = e.sessionID ?? e.sessionId;
          if (sid && !sessionId) sessionId = sid;

          if (e.type === "message" && e.content) {
            messages.push(e.content);
            yield { type: "final", text: e.content };
          } else if ((e.type === "reasoning" || e.type === "thinking") && e.content) {
            yield { type: "thinking", text: e.content };
          } else if (e.type === "tool_call" || e.type === "tool_result") {
            yield { type: "tool", text: JSON.stringify({ type: e.type, name: e.name, content: e.content }) };
          } else if (e.type === "finish" || e.type === "end") {
            finished = true;
          } else if (e.type === "error" && e.content) {
            yield { type: "error", text: e.content };
          }
        }

        // fallback:无 finish 且有 message(已在循环 yield,不重复);仅保证非空
        if (!finished && messages.length === 0) {
          // 无任何输出,不 yield(空回复由 router 处理)
        }
      },
    };
  }
}
