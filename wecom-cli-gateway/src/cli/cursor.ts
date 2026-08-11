import type { CliAdapter, CliSession, CliStartOpts, StreamChunk } from "./types.js";
import type { SpawnCliFn } from "./spawn-cli.js";

/**
 * CursorAdapter 基于 cursor-agent CLI + stream-json 解析(无官方 SDK)。
 *
 * 命令:cursor-agent -p <prompt> --output-format stream-json [--resume=<sid>] -f
 * - prompt 作命令行参数(Windows 需去换行,否则 cmd.exe 截断)
 * - 输出每行一个 JSON:system(init, session_id)/assistant(message.content)/result
 * - 会话恢复:--resume=<providerSessionId>
 *
 * 参考 claudecodeui server/modules/providers/list/cursor/cursor-runtime.provider.js。
 * 注意:本机未装 cursor-agent,无法真实端到端验证,解析基于 claudecodeui 源码推断。
 */

interface CursorStreamLine {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: { content?: Array<{ type: string; text?: string; thinking?: string }> };
}

export interface CursorAdapterOpts {
  spawnCli: SpawnCliFn;
  /** cursor 可执行文件名/路径,默认 "cursor-agent" */
  cmd?: string;
}

export class CursorAdapter implements CliAdapter {
  type = "cursor" as const;
  private cmd: string;

  constructor(private opts: CursorAdapterOpts) {
    this.cmd = opts.cmd ?? "cursor-agent";
  }

  async isAvailable(): Promise<boolean> {
    return true; // 生产:which cursor-agent
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
        // prompt 作参数:去换行(Windows cmd.exe 会截断多行)
        const prompt = text.replace(/\r?\n/g, " ");
        const args = ["-p", prompt, "--output-format", "stream-json", "-f"];
        if (sessionId) args.push(`--resume=${sessionId}`);

        const proc = spawnCli({ cmd, args, cwd: projectDir });
        killFn = proc.kill;
        let hasResult = false;
        const assistantTexts: string[] = [];

        for await (const line of proc.stdout) {
          let obj: CursorStreamLine;
          try { obj = JSON.parse(line); } catch { continue; } // 非 JSON 裸行忽略

          if (obj.type === "system" && obj.session_id && !sessionId) {
            sessionId = obj.session_id;
          }

          if (obj.type === "assistant" && obj.message?.content) {
            for (const c of obj.message.content) {
              if (c.type === "thinking" && c.thinking) {
                yield { type: "thinking", text: c.thinking };
              } else if (c.type === "text" && c.text) {
                assistantTexts.push(c.text); // 暂存,避免与 result 重复
              } else if (c.type === "tool_use" || c.type === "tool_result") {
                yield { type: "tool", text: JSON.stringify(c) };
              }
            }
          }

          if (obj.type === "result" && obj.result !== undefined) {
            hasResult = true;
            yield { type: "final", text: obj.result };
          }
        }

        if (!hasResult && assistantTexts.length > 0) {
          yield { type: "final", text: assistantTexts.join("") };
        }
      },
    };
  }
}
